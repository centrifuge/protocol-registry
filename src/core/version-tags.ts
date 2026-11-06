/**
 * Every env contract must record a `version` that resolves to a protocol tag, since that tag
 * is where its ABI is built from.
 *
 * A directory may alias a version to another tag (`env/<dir>/versions.json`): that is how the ABIs of
 * a deployment made before its release was tagged are redirected to the candidate it ran. The alias is
 * the deployment's own account of its source — a config records no deployment commit to check it
 * against — so what is held here is that the tag exists and that every alias redirects a version some
 * contract records. A later deploy from different source needs its own tag, and a version label of its
 * own to carry it.
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

export interface VersionTagDeps {
  tagExists(tag: string): Promise<boolean>;
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
    // Every alias this file's contracts actually use, for the "redirects nothing" check below
    if (!usedAliasKeysByDir.has(directory)) usedAliasKeysByDir.set(directory, new Set());
    const usedAliasKeys = usedAliasKeysByDir.get(directory)!;

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
        await resolveVersionTag(version, aliases, tagExists);
        if (aliases[version]) usedAliasKeys.add(version);
      } catch (e) {
        errors.push(
          `${file} chain ${chainId} (${environment}): contract "${name}" version "${version}" → no git tag. ` +
            `Tried: ${versionTagCandidates(version, aliases).join(", ")}. (${(e as Error).message})`,
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
