/**
 * Schema check for `env/`: the gate that runs before generation, to catch structural issues (field
 * renames, missing required keys, type mismatches) that would make the generator skip a chain or
 * crash.
 *
 * When any contract has a numeric `blockNumber`, requires `deploymentInfo.*.startBlock` (indexers use
 * it for chain-level block polling), and checks that **every** entry's startBlock is not wildly earlier
 * than the earliest contract deployment block — later deploy batches too, which is what catches an L1
 * block recorded on an L2 chain.
 */

import {
  RETIRED_FILE,
  allEnvFiles,
  allEnvironmentDirs,
  baseEnvironment,
  readEnvFile,
  registryPointer,
  retirementsOf,
  versionAliasesOf,
  type EnvTree,
} from "./env.ts";
import { parseJson } from "./json.ts";
import { declarationErrors } from "./retirements.ts";
import { NETWORKS, type Network } from "./types.ts";

const KNOWN_TOP_LEVEL_KEYS = new Set(["network", "adapters", "contracts", "deploymentInfo"]);
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
// A recorded deployment commit is a sha, short or full. Checked because things downstream diff
// against it — a tag name or a branch here resolves, and would compare a tag against itself
const COMMIT_REGEX = /^[0-9a-f]{7,40}$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every `deploymentInfo` entry carrying a numeric `startBlock`, in file order.
 *
 * All of them are validated, not just the first (which is what the generator copies into the
 * registry): a later batch's `startBlock` is just as likely to be wrong, and on chains where
 * `block.number` reports the L1 block — Arbitrum — an L1-scale value in a later entry is exactly the
 * mistake this catches.
 */
function deploymentStartBlocksFromEnv(chain: Json): { key: string; startBlock: number }[] {
  const info = chain.deploymentInfo;
  if (!isObject(info)) return [];
  return Object.entries(info)
    .filter(([, value]) => isObject(value) && typeof value.startBlock === "number")
    .map(([key, value]) => ({ key, startBlock: (value as Json).startBlock as number }));
}

function minActiveContractBlockNumber(contracts: unknown): number | null {
  if (!isObject(contracts)) return null;
  let min: number | null = null;
  for (const contract of Object.values(contracts)) {
    if (!isObject(contract)) continue;
    if (contract.address === null) continue;
    if (typeof contract.blockNumber !== "number") continue;
    if (min === null || contract.blockNumber < min) min = contract.blockNumber;
  }
  return min;
}

function startBlockGapErrorThreshold(minContractBlock: number): number {
  return Math.max(5_000_000, Math.floor(minContractBlock * 0.005));
}

function startBlockGapErrors(
  envLabel: string,
  entryKey: string,
  startBlock: number,
  contracts: unknown,
): string[] {
  const minBlock = minActiveContractBlockNumber(contracts);
  if (minBlock == null || typeof startBlock !== "number" || !Number.isFinite(startBlock)) {
    return [];
  }
  const gap = minBlock - startBlock;
  const threshold = startBlockGapErrorThreshold(minBlock);
  if (gap < threshold) return [];
  return [
    `${envLabel} deploymentInfo["${entryKey}"].startBlock: startBlock (${startBlock}) lies far before the earliest active contract deployment (min blockNumber ${minBlock}, gap ${gap} blocks ≥ threshold ${threshold}). ` +
      `Chain-level block listeners use deployment.startBlock (e.g. hourly snapshots); align it with the deployment record (deploymentInfo.startBlock is the earliest contract blockNumber). ` +
      `On chains where block.number reports the L1 block (Arbitrum), check this is the L2 block, not the L1 one.`,
  ];
}

function hasAnyNumericContractBlockNumber(chain: Json): boolean {
  if (!isObject(chain.contracts)) return false;
  return Object.values(chain.contracts).some(
    (value) => isObject(value) && typeof value.blockNumber === "number",
  );
}

/**
 * Validates one network config.
 *
 * @param path - Relative to `env/`, e.g. `mainnet/ethereum.json`
 * @returns Human-readable errors; empty when the file is valid
 */
export function validateEnvFile(path: string, raw: string): string[] {
  const errors: string[] = [];
  let chain: unknown;

  try {
    chain = parseJson(raw);
  } catch (err) {
    errors.push(`Invalid JSON: ${(err as Error).message}`);
    return errors;
  }

  if (!isObject(chain)) {
    errors.push("Root must be a JSON object");
    return errors;
  }

  for (const key of Object.keys(chain)) {
    if (key === "retired") {
      errors.push(
        `"retired" does not belong in a network config, which records the deployment and nothing else. ` +
          `Declare retirements in env/<environment>/${RETIRED_FILE}, keyed by network name.`,
      );
    } else if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      errors.push(
        `Unknown top-level key "${key}". ` +
          `Expected one of: ${Array.from(KNOWN_TOP_LEVEL_KEYS).join(", ")}. ` +
          `If this is intentional, update src/core/env-schema.ts in protocol-registry.`,
      );
    }
  }

  // --- network (required) ---
  const network = chain.network;
  if (!network) {
    errors.push('Missing required key "network"');
  } else if (!isObject(network)) {
    errors.push('"network" must be an object');
  } else {
    if (network.chainId == null) {
      errors.push('"network.chainId" is required');
    } else if (typeof network.chainId !== "number" || !Number.isInteger(network.chainId)) {
      errors.push(
        `"network.chainId" must be an integer, got ${typeof network.chainId}: ${network.chainId}`,
      );
    }

    // The environment is the directory the config sits in, deployment id included — `testnet-rev2`
    // for env/testnet-rev2/ — and the two are checked against each other so a renamed directory or
    // a copied rev cannot quietly describe another deployment
    const environment = network.environment;
    const directory = path.split("/").slice(-2, -1)[0] ?? "";
    if (environment == null) {
      errors.push('"network.environment" is required');
    } else if (!NETWORKS.includes(baseEnvironment(environment) as Network)) {
      errors.push(
        `"network.environment" must be "mainnet" or "testnet", optionally followed by "-<deploymentId>", got "${environment}"`,
      );
    } else if (environment !== directory) {
      errors.push(
        `"network.environment" is "${environment}" but the file sits in env/${directory}/`,
      );
    }

    // Every address on the chain derives from the namespace, so a config without one describes no
    // deployment (Chains.parse rejects it on the Solidity side for the same reason)
    if (network.namespace == null) {
      errors.push('"network.namespace" is required');
    } else if (!ADDRESS_REGEX.test(String(network.namespace))) {
      errors.push(`"network.namespace": invalid address format "${network.namespace}"`);
    }
  }

  // --- contracts (optional but validated if present) ---
  if (chain.contracts != null) {
    if (!isObject(chain.contracts)) {
      errors.push('"contracts" must be an object');
    } else {
      for (const [name, value] of Object.entries(chain.contracts)) {
        if (typeof value === "string") {
          if (!ADDRESS_REGEX.test(value)) {
            errors.push(`contracts.${name}: invalid address format "${value}"`);
          }
        } else if (isObject(value)) {
          const addr = value.address;
          if (!addr) {
            errors.push(`contracts.${name}: missing "address" field`);
          } else if (!ADDRESS_REGEX.test(String(addr))) {
            errors.push(`contracts.${name}: invalid address format "${addr}"`);
          }
          if (value.blockNumber != null && typeof value.blockNumber !== "number") {
            errors.push(
              `contracts.${name}.blockNumber: must be a number, got ${typeof value.blockNumber}`,
            );
          }
        } else {
          errors.push(
            `contracts.${name}: must be an address string or an object with "address", got ${typeof value}`,
          );
        }
      }
    }
  }

  // --- deploymentInfo (optional but validated if present) ---
  if (chain.deploymentInfo != null) {
    if (!isObject(chain.deploymentInfo)) {
      errors.push('"deploymentInfo" must be an object');
    } else {
      for (const [key, value] of Object.entries(chain.deploymentInfo)) {
        if (typeof value !== "object" || value === null) {
          errors.push(`deploymentInfo.${key}: must be an object`);
        } else if (
          (value as Json).startBlock != null &&
          typeof (value as Json).startBlock !== "number"
        ) {
          errors.push(`deploymentInfo.${key}.startBlock: must be a number`);
        } else if (
          (value as Json).gitCommit != null &&
          !COMMIT_REGEX.test(String((value as Json).gitCommit))
        ) {
          errors.push(
            `deploymentInfo.${key}.gitCommit: must be a commit sha, got "${(value as Json).gitCommit}"`,
          );
        }
      }
    }
  }

  const envLabel = path.split("/").pop() ?? path;
  if (hasAnyNumericContractBlockNumber(chain)) {
    const startBlocks = deploymentStartBlocksFromEnv(chain);
    if (startBlocks.length === 0) {
      errors.push(
        `${envLabel}: missing deploymentInfo.*.startBlock — required when any contract has blockNumber ` +
          `(indexers use it for chain-level block listeners, e.g. hourly snapshots; see protocol-registry's README)`,
      );
    } else {
      for (const { key, startBlock } of startBlocks) {
        errors.push(...startBlockGapErrors(envLabel, key, startBlock, chain.contracts || {}));
      }
    }
  }

  // --- adapters (optional but validated if present) ---
  if (chain.adapters != null && !isObject(chain.adapters)) {
    errors.push('"adapters" must be an object');
  }

  return errors;
}

export interface EnvSchemaReport {
  /** A problem with the directory layout or the files beside the configs; nothing else was checked. */
  fatal: string | null;
  /** Per network config, relative to `env/`. */
  files: { file: string; errors: string[] }[];
  /** What was read, for the log. */
  notes: string[];
  checked: number;
}

/** Validates every deployment record under `env/`, published or not, and the files beside them. */
export function validateEnvTree(tree: EnvTree): EnvSchemaReport {
  const notes: string[] = [];
  let files: string[];
  try {
    // Every deployment record, published or not: a rev's configs have to hold to the schema too
    files = allEnvFiles(tree);
    // And the pointer has to name directories that exist and match their registry
    const pointer = registryPointer(tree);
    notes.push(
      `Registries: ${NETWORKS.map((name) => `${name} → env/${pointer[name]}/`).join(", ")}`,
    );
    // A malformed versions.json would otherwise surface only once the ABI stage reached for a tag
    for (const dir of allEnvironmentDirs(tree)) {
      for (const [version, tag] of Object.entries(versionAliasesOf(tree, dir))) {
        notes.push(`env/${dir}/: version ${version} → tag ${tag}`);
      }
    }
    // And a retired.json has to name known networks and well-formed declarations before the
    // generator expands it against the published chain
    for (const dir of allEnvironmentDirs(tree)) {
      const declared = retirementsOf(tree, dir);
      const errors: string[] = [];
      let count = 0;
      for (const [network, declarations] of Object.entries(declared)) {
        for (const [key, declaration] of Object.entries(declarations)) {
          count++;
          errors.push(...declarationErrors(key, declaration, network));
        }
      }
      if (errors.length > 0) {
        throw new Error(`env/${dir}/${RETIRED_FILE}:\n  ${errors.join("\n  ")}`);
      }
      if (count > 0) notes.push(`env/${dir}/${RETIRED_FILE}: ${count} retirement declaration(s)`);
    }
  } catch (err) {
    return { fatal: (err as Error).message, files: [], notes, checked: 0 };
  }

  const results = files
    .map((file) => ({ file, errors: validateEnvFile(file, readEnvFile(tree, file)) }))
    .filter(({ errors }) => errors.length > 0);
  return { fatal: null, files: results, notes, checked: files.length };
}
