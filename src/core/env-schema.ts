/**
 * Schema check for `env/`: the gate that runs before generation, to catch structural issues (field
 * renames, missing required keys, type mismatches) that would make the generator skip a chain or
 * crash.
 *
 * A config holds `network`, `adapters` and `contracts` and nothing else: it records no deployment
 * metadata, so the chain-level start block the indexer polls from is derived at publish time as the
 * earliest contract `blockNumber` (./generate.ts), not read from here.
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

const KNOWN_TOP_LEVEL_KEYS = new Set(["network", "adapters", "contracts"]);
const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      // Every entry carries the block number the deploy script recorded: the registry derives the
      // chain's start block from them and never asks an explorer for one that is missing
      for (const [name, value] of Object.entries(chain.contracts)) {
        if (!isObject(value)) {
          errors.push(
            `contracts.${name}: must be an object with "address" and "blockNumber", got ${typeof value}`,
          );
          continue;
        }
        const addr = value.address;
        if (!addr) {
          errors.push(`contracts.${name}: missing "address" field`);
        } else if (!ADDRESS_REGEX.test(String(addr))) {
          errors.push(`contracts.${name}: invalid address format "${addr}"`);
        }
        if (typeof value.blockNumber !== "number" || !Number.isInteger(value.blockNumber)) {
          errors.push(
            `contracts.${name}.blockNumber: must be an integer, got ${JSON.stringify(value.blockNumber)}`,
          );
        }
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
