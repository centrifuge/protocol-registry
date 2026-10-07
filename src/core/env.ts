/**
 * Which `env/` directory backs each registry, read from a snapshot of protocol-internal's `env/` at
 * one commit.
 *
 * The indexer knows two registries, `mainnet` and `testnet`, while `env/` may hold several deployments
 * of one kind at once: `env/testnet/` beside `env/testnet-rev2/`, each a full set of configs at its own
 * addresses (the part of the directory name after the first `-` is the deployment id, folded into every
 * salt). `env/registry.json` says which of them each registry publishes:
 *
 *     { "mainnet": "mainnet", "testnet": "testnet-rev2" }
 *
 * A registry name maps to a directory of the same base environment; a missing entry means the id-less,
 * canonical directory. Every stage that enumerates env files goes through here, so they cannot disagree
 * about which deployment "testnet" is.
 *
 * A directory may also hold a `versions.json`, which says which git tag backs each `version` its configs
 * record — see {@link versionAliasesOf} — and a `retired.json`, which says which of its chains' contracts
 * are out of use and at which block — see {@link retirementsOf}.
 */

import { parseJson } from "./json.ts";
import { NETWORKS, type EnvConfig, type Network, type Retirements } from "./types.ts";

export const POINTER_FILE = "registry.json";
export const VERSIONS_FILE = "versions.json";
export const RETIRED_FILE = "retired.json";

/**
 * `env/` at one commit. `paths` lists every file under `env/`, relative to it (`mainnet/ethereum.json`);
 * `files` holds the contents of the ones the generator reads.
 */
export interface EnvTree {
  paths: readonly string[];
  files: ReadonlyMap<string, string>;
}

/** Whether a path under `env/` has its contents loaded into an {@link EnvTree}. */
export function isReadEnvPath(path: string): boolean {
  if (path === POINTER_FILE) return true;
  const parts = path.split("/");
  return parts.length === 2 && parts[1].endsWith(".json") && parts[1] !== "connections.json";
}

export function readEnvFile(tree: EnvTree, path: string): string {
  const content = tree.files.get(path);
  if (content === undefined) throw new Error(`env/${path}: not in the env snapshot`);
  return content;
}

export function parseEnvConfig(tree: EnvTree, path: string): EnvConfig {
  return parseJson<EnvConfig>(readEnvFile(tree, path));
}

function hasPath(tree: EnvTree, path: string): boolean {
  return tree.paths.includes(path);
}

function filesIn(tree: EnvTree, directory: string): string[] {
  const prefix = `${directory}/`;
  return tree.paths
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map((path) => path.slice(prefix.length))
    .sort();
}

function directoryExists(tree: EnvTree, directory: string): boolean {
  return tree.paths.some((path) => path.startsWith(`${directory}/`));
}

/** `testnet-rev2` → `testnet`: the environment a directory belongs to, whatever id it carries. */
export function baseEnvironment(environment: unknown): string {
  return String(environment ?? "").split("-", 1)[0];
}

/** Whether a config file name is a network config rather than one of the files that sit beside them. */
export function isNetworkConfig(file: string): boolean {
  return (
    file.endsWith(".json") &&
    file !== "connections.json" &&
    file !== POINTER_FILE &&
    file !== VERSIONS_FILE &&
    file !== RETIRED_FILE
  );
}

/**
 * The version → git tag aliases one deployment directory declares, or `{}` where it declares none.
 *
 * A config records the protocol version its contracts were deployed at — `v3.3` — and the pipeline
 * builds their ABIs from the tag of that name. A deployment made *before* the release is tagged has no
 * such tag to point at, and must not borrow the release's once it exists: its contracts are the release
 * candidate, not the release. `env/<dir>/versions.json` is where such a deployment says so:
 *
 *     { "tags": { "v3.3": "v3.3.0-rc2" } }
 *
 * Per directory, because that is per deployment: the same `v3.3` means the release in `env/mainnet/` and
 * the candidate in a testnet directory that ran ahead of it.
 *
 * An entry is retired by re-pointing it at the release tag, never by deleting it: only an aliased version
 * is checked against the source the deployment recorded, so dropping the entry hands the deployment back
 * to the unchecked fallback it was written to avoid.
 *
 * @returns version string → git tag
 */
export function versionAliasesOf(tree: EnvTree, environmentDir: string): Record<string, string> {
  const path = `${environmentDir}/${VERSIONS_FILE}`;
  if (!hasPath(tree, path)) return {};

  const label = `env/${path}`;
  let parsed: unknown;
  try {
    parsed = parseJson(readEnvFile(tree, path));
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${(error as Error).message})`, {
      cause: error,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: must be a JSON object`);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "tags") {
      throw new Error(`${label}: unknown key "${key}", expected "tags"`);
    }
  }

  const tags = (parsed as { tags?: unknown }).tags ?? {};
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    throw new Error(`${label}: "tags" must be an object of version → git tag`);
  }
  for (const [version, tag] of Object.entries(tags)) {
    if (typeof tag !== "string" || tag.trim() === "") {
      throw new Error(`${label}: "tags.${version}" must be a non-empty git tag name`);
    }
    if (tag === version) {
      throw new Error(
        `${label}: "tags.${version}" aliases the version to itself. To retire an alias, point it at ` +
          `the release tag (e.g. "v3.3.0") so the source check still runs, rather than back at itself`,
      );
    }
  }

  return tags as Record<string, string>;
}

/**
 * The retirement declarations one deployment directory makes, keyed by network name, or `{}` where it
 * makes none.
 *
 * A network config records what is deployed and nothing else: a deploy run rewrites it wholesale. A
 * retirement is a decision about a chain taken later, about a previous release, so it is written beside
 * the configs rather than in one, in `env/<dir>/retired.json`:
 *
 *     {
 *       "ethereum": { "v3.2.0": { "endBlock": 25900000, "reason": "All pools migrated to v3.3" } },
 *       "base":     { "v3.2.0": { "endBlock": 41900000 } }
 *     }
 *
 * A key is a network name, resolved through the configs in the same directory: a key that matches no
 * `<network>.json` there is an error, never a skip, since a typo would retire nothing and say so only in
 * a log. The shape of a declaration is checked by the env schema check and its meaning by
 * ./retirements.ts.
 *
 * The file is a ledger: a declaration stays once published, and the generator reports it as in force
 * rather than emitting it again. Git history keeps the decision and the review that approved it.
 */
export function retirementsOf(tree: EnvTree, environmentDir: string): Retirements {
  const path = `${environmentDir}/${RETIRED_FILE}`;
  if (!hasPath(tree, path)) return {};

  const label = `env/${path}`;
  let parsed: unknown;
  try {
    parsed = parseJson(readEnvFile(tree, path));
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${(error as Error).message})`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: must be a JSON object of network name → declarations`);
  }

  const networks = new Set(
    filesIn(tree, environmentDir)
      .filter(isNetworkConfig)
      .map((file) => file.slice(0, -".json".length)),
  );
  for (const [network, declarations] of Object.entries(parsed)) {
    if (!networks.has(network)) {
      throw new Error(
        `${label}: "${network}" matches no network config in env/${environmentDir}/ ` +
          `(known: ${[...networks].sort().join(", ") || "none"})`,
      );
    }
    if (typeof declarations !== "object" || declarations === null || Array.isArray(declarations)) {
      throw new Error(
        `${label}: "${network}" must be an object of registry version or address → { endBlock }`,
      );
    }
  }
  return parsed as Retirements;
}

/** The pointer, filled in with the canonical directory for every registry it does not name. */
export function registryPointer(tree: EnvTree): Record<Network, string> {
  const pointer: Record<string, unknown> = hasPath(tree, POINTER_FILE)
    ? parseJson(readEnvFile(tree, POINTER_FILE))
    : {};

  for (const name of Object.keys(pointer)) {
    if (!NETWORKS.includes(name as Network)) {
      throw new Error(
        `env/${POINTER_FILE}: unknown registry "${name}", expected one of ${NETWORKS.join(", ")}`,
      );
    }
  }
  for (const name of NETWORKS) {
    const dir = pointer[name] ?? name;
    if (typeof dir !== "string" || baseEnvironment(dir) !== name) {
      throw new Error(
        `env/${POINTER_FILE}: "${name}" points at "${dir}", which is not a ${name} environment`,
      );
    }
    if (!directoryExists(tree, dir)) {
      throw new Error(`env/${POINTER_FILE}: "${name}" points at env/${dir}/, which does not exist`);
    }
    pointer[name] = dir;
  }
  return pointer as Record<Network, string>;
}

/**
 * The environment directory a registry publishes — also the `network.environment` every config in it
 * declares, which is what the pipeline matches chains by.
 */
export function resolveEnvironmentDir(tree: EnvTree, registryName: string): string {
  if (!NETWORKS.includes(registryName as Network)) {
    throw new Error(`Unknown registry "${registryName}": expected one of ${NETWORKS.join(", ")}`);
  }
  return registryPointer(tree)[registryName as Network];
}

/** The network configs one registry publishes, as `<dir>/<file>` paths relative to `env/`. */
export function envFilesOf(tree: EnvTree, registryName: string): string[] {
  const dir = resolveEnvironmentDir(tree, registryName);
  return filesIn(tree, dir)
    .filter(isNetworkConfig)
    .map((file) => `${dir}/${file}`);
}

/**
 * Every environment directory under `env/`, published or not: `mainnet`, `testnet`, `testnet-rev2`, ...
 * For the checks that apply to any deployment record, not only the published ones.
 */
export function allEnvironmentDirs(tree: EnvTree): string[] {
  const directories = new Set<string>();
  for (const path of tree.paths) {
    const slash = path.indexOf("/");
    if (slash > 0) directories.add(path.slice(0, slash));
  }
  return [...directories]
    .filter((dir) => NETWORKS.includes(baseEnvironment(dir) as Network))
    .sort();
}

/** The network configs of every environment directory, as `<dir>/<file>` paths relative to `env/`. */
export function allEnvFiles(tree: EnvTree): string[] {
  return allEnvironmentDirs(tree).flatMap((dir) =>
    filesIn(tree, dir)
      .filter(isNetworkConfig)
      .map((file) => `${dir}/${file}`),
  );
}

/** Builds an {@link EnvTree} from a path → content map, for tests and local runs. */
export function envTreeOf(files: Record<string, string>): EnvTree {
  return { paths: Object.keys(files).sort(), files: new Map(Object.entries(files)) };
}
