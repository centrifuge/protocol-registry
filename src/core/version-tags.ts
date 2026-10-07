/**
 * Every env contract must record a `version` that resolves to a protocol-internal tag, since that tag
 * is where its ABI is built from.
 *
 * A directory that aliases a version to another tag (`env/<dir>/versions.json`) is held to one thing
 * more: the tag it names must carry the source the deployment actually ran. The alias is what redirects
 * the ABIs of a deployment made before its release was tagged, and nothing else would catch it pointing
 * at the wrong candidate — the addresses stay valid, the ABIs quietly stop describing them. Checked by
 * comparing the source trees of the tag and of the commit the deployment recorded: same `src/`, same
 * ABIs. Since that is the *recorded* commit, it proves the tag matches what the config says was
 * deployed, not what the chain holds.
 *
 * Its scope is the run that registered `root`, the only one that writes `deploymentInfo`: a script that
 * adds contracts to a chain later records their version without touching it, so those contracts resolve
 * through the alias unchecked. A later deploy whose source differs needs its own tag, and a version
 * label of its own to carry it.
 */

import {
  allEnvFiles,
  baseEnvironment,
  parseEnvConfig,
  versionAliasesOf,
  VERSIONS_FILE,
  type EnvTree,
} from "./env.ts";
import { NETWORKS, type EnvConfig, type Network } from "./types.ts";
import { resolveVersionTag, versionTagCandidates } from "./versions.ts";

/** What a recorded `gitCommit` may look like, so that a tag name cannot pass as one and diff against itself. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export type SourceComparison =
  { checked: true; differing: string[] } | { checked: false; reason: string };

export interface VersionTagDeps {
  tagExists(tag: string): Promise<boolean>;
  /**
   * Whether a tag and a commit hold the same ABI-bearing source: `src/` without `src/spell/` (spells
   * are written on the live branch against a deployed release and never part of a tag), and `src-ir/`.
   */
  compareSource(tag: string, commit: string): Promise<SourceComparison>;
}

/** The commit a deployment recorded for itself, or null where it recorded none. */
function deploymentCommitOf(chain: EnvConfig): string | null {
  const info = chain.deploymentInfo;
  if (!info || typeof info !== "object") return null;
  const protocol = info["deploy:protocol"]?.gitCommit;
  if (protocol) return protocol;
  for (const value of Object.values(info)) {
    if (value?.gitCommit) return value.gitCommit;
  }
  return null;
}

/** Checks every deployment record under `env/`, published or not: a rev that is later pointed at has to build too. */
export async function versionTagErrors(tree: EnvTree, deps: VersionTagDeps): Promise<string[]> {
  const errors: string[] = [];
  const aliasesByDir = new Map<string, Record<string, string>>();
  const usedAliasKeysByDir = new Map<string, Set<string>>();
  const tagCache = new Map<string, Promise<boolean>>();
  const tagExists = (tag: string) => {
    if (!tagCache.has(tag)) tagCache.set(tag, deps.tagExists(tag));
    return tagCache.get(tag)!;
  };

  for (const file of allEnvFiles(tree)) {
    const directory = file.split("/")[0];
    let chain: EnvConfig;
    try {
      chain = parseEnvConfig(tree, file);
    } catch (e) {
      errors.push(`${file}: invalid JSON (${(e as Error).message})`);
      continue;
    }

    const chainId = chain.network?.chainId;
    const environment = chain.network?.environment;
    if (chainId === 31337) continue;
    if (!NETWORKS.includes(baseEnvironment(environment) as Network)) continue;

    let aliases: Record<string, string>;
    try {
      if (!aliasesByDir.has(directory))
        aliasesByDir.set(directory, versionAliasesOf(tree, directory));
      aliases = aliasesByDir.get(directory)!;
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    if (!usedAliasKeysByDir.has(directory)) usedAliasKeysByDir.set(directory, new Set());
    const usedAliasKeys = usedAliasKeysByDir.get(directory)!;

    // Every alias this file's contracts actually use, resolved once: what the source-tree check is about
    const aliasedTags = new Map<string, string>();
    for (const [name, data] of Object.entries(chain.contracts || {})) {
      if (typeof data === "string") {
        errors.push(
          `${file} chain ${chainId} (${environment}): "${name}" is a bare address string; add an object with address + version`,
        );
        continue;
      }
      if (!data || typeof data !== "object") {
        errors.push(`${file} chain ${chainId}: "${name}" has invalid contract entry`);
        continue;
      }
      const version = data.version;
      if (!version || typeof version !== "string") {
        errors.push(
          `${file} chain ${chainId} (${environment}): contract "${name}" is missing a non-empty "version" field (required for ABI tag resolution)`,
        );
        continue;
      }
      try {
        const tag = await resolveVersionTag(version, aliases, tagExists);
        if (aliases[version]) {
          aliasedTags.set(version, tag);
          usedAliasKeys.add(version);
        }
      } catch (e) {
        errors.push(
          `${file} chain ${chainId} (${environment}): contract "${name}" version "${version}" → no git tag. ` +
            `Tried: ${versionTagCandidates(version, aliases).join(", ")}. (${(e as Error).message})`,
        );
      }
    }

    // An alias redirects the ABIs; the tag it names has to hold the source this deployment ran
    const deploymentCommit = deploymentCommitOf(chain);
    for (const [version, tag] of aliasedTags) {
      // Each of these would otherwise keep a wrong alias green, which is the whole of what this checks
      if (!deploymentCommit) {
        errors.push(
          `${file} (${environment}): version "${version}" is aliased to tag "${tag}", but the file records no deploymentInfo gitCommit to check it against`,
        );
        continue;
      }
      if (!COMMIT_SHA.test(deploymentCommit)) {
        errors.push(
          `${file} (${environment}): version "${version}" is aliased to tag "${tag}", but the recorded ` +
            `deploymentInfo gitCommit "${deploymentCommit}" is not a commit sha — a tag name there would ` +
            `diff against itself and pass regardless`,
        );
        continue;
      }

      const comparison = await deps.compareSource(tag, deploymentCommit);
      if (!comparison.checked) {
        errors.push(
          `${file} (${environment}): version "${version}" is aliased to tag "${tag}", but ${comparison.reason}`,
        );
        continue;
      }
      if (comparison.differing.length > 0) {
        const shown = comparison.differing.slice(0, 5).join(", ");
        const more =
          comparison.differing.length > 5 ? `, +${comparison.differing.length - 5} more` : "";
        errors.push(
          `${file} (${environment}): version "${version}" is aliased to tag "${tag}", but that tag's ` +
            `source differs from the deployed commit ${deploymentCommit} (${shown}${more}). Its ABIs ` +
            `would not describe what is deployed: tag the deployed commit and point the alias at that tag.`,
        );
      }
    }
  }

  // An alias key no contract records redirects nothing, and reads as though it does — a typo in the
  // version resolves through the ordinary candidates instead, which is the release's tag once cut
  for (const [directory, aliases] of aliasesByDir) {
    const used = usedAliasKeysByDir.get(directory) ?? new Set();
    for (const version of Object.keys(aliases)) {
      if (used.has(version)) continue;
      errors.push(
        `env/${directory}/${VERSIONS_FILE}: "tags.${version}" is aliased to "${aliases[version]}", but no ` +
          `contract in env/${directory}/ records version "${version}" — it redirects nothing`,
      );
    }
  }

  return errors;
}

/** The tags the published deployments' contracts resolve to: what their ABIs are built from. */
export async function publishedTags(
  tree: EnvTree,
  directories: string[],
  tagExists: (tag: string) => Promise<boolean>,
): Promise<string[]> {
  const tags = new Set<string>();
  for (const file of allEnvFiles(tree).filter((file) => directories.includes(file.split("/")[0]))) {
    const chain = parseEnvConfig(tree, file);
    const aliases = versionAliasesOf(tree, file.split("/")[0]);
    for (const data of Object.values(chain.contracts || {})) {
      const version = typeof data === "string" ? undefined : data?.version;
      if (version) tags.add(await resolveVersionTag(version, aliases, tagExists));
    }
  }
  return [...tags].sort();
}
