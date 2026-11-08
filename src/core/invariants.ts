/**
 * Semantic checks on a generated delta, beyond "is this valid JSON with the right fields in it".
 *
 * The delta that oscillated between 443 and 12 contracts passed every structural check there was,
 * because a delta re-stating contracts that are already published is perfectly well-formed. What it
 * violated is a property nothing was asserting: a delta must describe *the difference* between the
 * published state and env, no more and no less.
 *
 * Two invariants pin that down, both computed against the flattened published chain:
 *
 *   1. Projection. Applying the delta to the published state must reproduce every contract env
 *      lists, at env's address and blockNumber. Catches a delta that omits a real change or invents
 *      one. Contracts published but absent from env stay as they are (a missing key is not a
 *      retirement) and are only reported.
 *   2. Minimality. No delta entry may restate what the published state already says. Catches the
 *      inflation directly — this is the check that fails on the original bug.
 *
 * Retirements are checked both ways. A `retired` entry in the delta must close an address env no
 * longer lists; and an address env lists must not be one the published chain has already retired.
 * The second is what makes a retirement final: nothing in the schema reopens an address, and a
 * version declaration skips an address env lists (see ./retirements.ts), so re-adding a retired
 * address to env emits nothing and would leave indexers with a closed listener env says is live.
 *
 * A size heuristic warns when a delta looks like a snapshot, which is what a human noticed first.
 */

import { artifactNamesForContractKey } from "./abi-names.ts";
import { addressOf, blockNumberOf } from "./delta.ts";
import { envFilesOf, parseEnvConfig, resolveEnvironmentDir, type EnvTree } from "./env.ts";
import type {
  AccumulatedState,
  ContractEntry,
  Finding,
  Layer,
  LayerChain,
  RetiredEntry,
} from "./types.ts";

/** Fraction of the accumulated state above which a delta stops looking like a delta. */
const SNAPSHOT_RATIO = 0.3;

/** Below this many contracts, a large ratio is unremarkable (early chains, small networks). */
const SNAPSHOT_FLOOR = 20;

export type EnvChains = Record<string, { contracts: Record<string, ContractEntry> }>;

/** Artifact names a contract key needs that the chain has never published. */
function missingAbiNames(contractKey: string, publishedAbiNames: Set<string> | null): string[] {
  if (!publishedAbiNames) return [];
  return artifactNamesForContractKey(contractKey).filter((name) => !publishedAbiNames.has(name));
}

/**
 * Loads the chains a registry's env files describe, keyed by chainId.
 *
 * Mirrors the generator's selection: files whose `network.environment` matches, minus the local
 * dev chain. Anything else would compare the delta against a different set of chains than produced
 * it.
 */
export function loadEnvChains(tree: EnvTree, registryName: string): EnvChains {
  const chains: EnvChains = {};

  const environmentDir = resolveEnvironmentDir(tree, registryName);
  for (const file of envFilesOf(tree, registryName)) {
    let parsed;
    try {
      parsed = parseEnvConfig(tree, file);
    } catch {
      continue; // the env schema check is the gate for malformed env files
    }
    const chainId = parsed?.network?.chainId;
    if (parsed?.network?.environment !== environmentDir) continue;
    if (chainId == null || chainId === 31337) continue;

    chains[String(chainId)] = { contracts: parsed.contracts || {} };
  }

  return chains;
}

function sameAddress(a: ContractEntry, b: ContractEntry): boolean {
  const left = addressOf(a);
  const right = addressOf(b);
  if (left == null || right == null) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Whether a blockNumber env states is what the other side resolves to.
 *
 * Only judged in that direction, matching `hasContractChanged`: env is the source of truth for a
 * blockNumber it has, and a blockNumber env does not have says nothing about the published one.
 */
function blockNumberAgrees(envEntry: ContractEntry, otherEntry: ContractEntry): boolean {
  const envBlock = blockNumberOf(envEntry);
  if (envBlock == null) return true;
  return String(envBlock) === String(blockNumberOf(otherEntry));
}

/** Applies a delta's chains onto the accumulated published state, as an indexer would. */
function project(
  accumulatedChains: AccumulatedState,
  deltaChains: Record<string, LayerChain>,
): Record<string, Record<string, ContractEntry>> {
  const projected: Record<string, Record<string, ContractEntry>> = {};

  for (const [chainId, chainData] of Object.entries(accumulatedChains || {})) {
    projected[chainId] = { ...(chainData.contracts || {}) };
  }
  for (const [chainId, chainData] of Object.entries(deltaChains || {})) {
    projected[chainId] = { ...(projected[chainId] || {}), ...(chainData.contracts || {}) };
  }

  return projected;
}

/** The same for each chain's `retired` map, keyed by lowercase address. */
function projectRetired(
  accumulatedChains: AccumulatedState,
  deltaChains: Record<string, LayerChain>,
): Record<string, Record<string, RetiredEntry>> {
  const projected: Record<string, Record<string, RetiredEntry>> = {};
  const merge = (chainId: string, retired: Record<string, RetiredEntry> | undefined) => {
    for (const [address, entry] of Object.entries(retired || {})) {
      (projected[chainId] ??= {})[address.toLowerCase()] = entry;
    }
  };
  for (const [chainId, chainData] of Object.entries(accumulatedChains || {}))
    merge(chainId, chainData.retired);
  for (const [chainId, chainData] of Object.entries(deltaChains || {}))
    merge(chainId, chainData.retired);
  return projected;
}

export interface DeltaStats {
  accumulatedContracts: number;
  deltaContracts: number;
  deltaRatio: number | null;
  redundantContracts: number;
  keptContracts: number;
  /** chainId → the names kept as published though env no longer lists them. */
  keptByChain: Record<string, string[]>;
  retirements: number;
}

export interface DeltaInvariantsParams {
  /** Flattened published state (flattenRegistryChain output). */
  accumulatedChains: AccumulatedState;
  /** The generated registry document. */
  deltaRegistry: Layer;
  /** chainId → { contracts } from env, for this registry. */
  envChains: EnvChains;
  /** ABI names published anywhere in the chain. Omit to skip the ABI-coverage invariant. */
  accumulatedAbiNames?: Set<string> | null;
  /**
   * chainId → lowercase addresses the chain ever published live (chainAddressHistory). Omit to skip
   * checking that a retirement names a published address.
   */
  publishedAddresses?: Record<string, Set<string>> | null;
}

/** Checks a generated delta against the state it claims to extend. */
export function checkDeltaInvariants({
  accumulatedChains,
  deltaRegistry,
  envChains,
  accumulatedAbiNames = null,
  publishedAddresses = null,
}: DeltaInvariantsParams): { errors: Finding[]; warnings: Finding[]; stats: DeltaStats } {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  const deltaChains = deltaRegistry?.chains || {};
  const deltaAbiNames = new Set(Object.keys(deltaRegistry?.abis || {}));
  const projected = project(accumulatedChains, deltaChains);
  const projectedRetired = projectRetired(accumulatedChains, deltaChains);
  let keptContracts = 0;
  const keptByChain: Record<string, string[]> = {};
  let retirements = 0;

  // --- 1. Projection: published state + delta must equal env ---
  for (const [chainId, envChain] of Object.entries(envChains || {})) {
    const envContracts = envChain?.contracts || {};
    const projectedContracts = projected[chainId] || {};

    for (const [name, envContract] of Object.entries(envContracts)) {
      const projectedContract = projectedContracts[name];
      if (!projectedContract || addressOf(projectedContract) === null) {
        errors.push({
          path: `chains.${chainId}.contracts.${name}`,
          message:
            `Present in env but missing from the published state after applying this ` +
            `delta — an indexer reading the chain would never see this contract`,
        });
      } else if (!sameAddress(projectedContract, envContract)) {
        errors.push({
          path: `chains.${chainId}.contracts.${name}.address`,
          message:
            `Published state after this delta resolves to ` +
            `${addressOf(projectedContract)} but env says ${addressOf(envContract)}`,
        });
      } else if (!blockNumberAgrees(envContract, projectedContract)) {
        // The address alone is not the whole entry: the indexer starts this contract's listener at
        // its blockNumber, falling back to the chain-level startBlock. A delta that leaves the wrong
        // one — or none — published is not a faithful projection of env.
        errors.push({
          path: `chains.${chainId}.contracts.${name}.blockNumber`,
          message:
            `Published state after this delta resolves to blockNumber ` +
            `${blockNumberOf(projectedContract) ?? "null"} but env says ` +
            `${blockNumberOf(envContract)}`,
        });
      }
    }

    // Live in the published state but absent from env, and not retired: kept as published. A
    // missing key is not a retirement (see ./delta.ts), and keeping is the normal case, so it is
    // reported rather than warned about; reviewers still see what env stopped listing, since that
    // is the set a declaration would close.
    const retiredHere = projectedRetired[chainId] || {};
    const kept = Object.entries(projectedContracts)
      .filter(([name, projectedContract]) => {
        const address = addressOf(projectedContract);
        return address != null && !envContracts[name] && !retiredHere[address.toLowerCase()];
      })
      .map(([name]) => name)
      .sort();
    if (kept.length > 0) {
      keptContracts += kept.length;
      keptByChain[chainId] = kept;
    }
  }

  // --- 1b. Retirements: each closes a published address that env no longer lists, once ---
  for (const [chainId, chainData] of Object.entries(deltaChains)) {
    const envAddresses = new Set(
      Object.values(envChains?.[chainId]?.contracts || {})
        .map((entry) => addressOf(entry)?.toLowerCase())
        .filter(Boolean),
    );
    const alreadyRetired = accumulatedChains?.[chainId]?.retired || {};
    const everPublished = publishedAddresses?.[chainId] || null;

    for (const [rawAddress, entry] of Object.entries(chainData.retired || {})) {
      retirements++;
      const address = rawAddress.toLowerCase();
      const path = `chains.${chainId}.retired.${rawAddress}`;

      if (envAddresses.has(address)) {
        errors.push({
          path,
          message: `Closes an address env still lists as live — a retirement must not end a current contract`,
        });
      }
      if (everPublished && !everPublished.has(address)) {
        errors.push({
          path,
          message: `No layer in the chain ever published this address on chain ${chainId}`,
        });
      }
      const existing = alreadyRetired[address];
      if (existing) {
        if (existing.endBlock === entry?.endBlock) {
          errors.push({
            path,
            message: "Restates a retirement the published state already carries",
          });
        } else {
          warnings.push({
            path,
            message: `Corrects a published retirement: endBlock ${existing.endBlock} → ${entry?.endBlock}`,
          });
        }
      }
    }
  }

  // --- 1c. Env must not list an address the published chain has already retired ---
  // The retired entry stays in force whatever env says: a version declaration skips an address env
  // lists, so nothing is emitted, the projection sees the same address and passes, and indexers
  // keep the listener closed at its endBlock. An address this delta itself retires is 1b's case.
  for (const [chainId, envChain] of Object.entries(envChains || {})) {
    const retiredHere = projectedRetired[chainId] || {};
    const retiredByDelta = new Set(
      Object.keys(deltaChains[chainId]?.retired || {}).map((a) => a.toLowerCase()),
    );
    for (const [name, envContract] of Object.entries(envChain?.contracts || {})) {
      const address = addressOf(envContract)?.toLowerCase();
      if (!address || retiredByDelta.has(address)) continue;
      const existing = retiredHere[address];
      if (!existing) continue;
      errors.push({
        path: `chains.${chainId}.contracts.${name}`,
        message:
          `Env lists ${address} as live, but the published chain retired it at ` +
          `endBlock ${existing.endBlock}, and nothing in the schema reopens a retired ` +
          `address — indexers would keep its listener closed. Deploy to a new address, ` +
          `or leave it retired and remove it from env`,
      });
    }
  }

  // A chain in the delta that env does not describe at all cannot be validated against anything.
  for (const chainId of Object.keys(deltaChains)) {
    if (!envChains?.[chainId]) {
      warnings.push({
        path: `chains.${chainId}`,
        message: "Chain is in the delta but has no env file for this environment",
      });
    }
  }

  // --- 2. Minimality: no entry may restate what is already published ---
  let redundant = 0;
  for (const [chainId, chainData] of Object.entries(deltaChains)) {
    const published = accumulatedChains?.[chainId]?.contracts || {};
    for (const [name, entry] of Object.entries(chainData.contracts || {})) {
      const existing = published[name];
      if (!existing) continue;

      if (addressOf(entry) === null) {
        // Re-tombstoning something already retired is redundant too.
        if (addressOf(existing) === null) {
          redundant++;
          errors.push({
            path: `chains.${chainId}.contracts.${name}`,
            message: "Re-tombstones a contract the published state already retired",
          });
        }
        continue;
      }

      const addressUnchanged = sameAddress(entry, existing);
      // Mirrors hasContractChanged, so an entry the delta was right to include can never be
      // reported as redundant: a blockNumber the entry states must match the published one,
      // including when the chain carried none and this entry backfills it.
      const blockUnchanged = blockNumberAgrees(entry, existing);

      if (addressUnchanged && blockUnchanged) {
        // One legitimate reason to restate an unchanged contract: the chain never carried its ABI,
        // and this delta ships it. Allowed, but surfaced so it is not invisible.
        const healed = missingAbiNames(name, accumulatedAbiNames).filter((abiName) =>
          deltaAbiNames.has(abiName),
        );
        if (healed.length > 0) {
          warnings.push({
            path: `chains.${chainId}.contracts.${name}`,
            message:
              `Restates the published state, but ships ${healed.join(", ")} — an ABI ` +
              `the chain never carried. Allowed: without it the gap would be permanent`,
          });
          continue;
        }

        redundant++;
        errors.push({
          path: `chains.${chainId}.contracts.${name}`,
          message:
            `Restates the published state (same address and blockNumber) — a delta must ` +
            `carry only what changed. Re-emitting published contracts is what made ` +
            `earlier publishes oscillate between near-full snapshots`,
        });
      }
    }
  }

  // --- 3. ABI coverage: every live contract must resolve to an ABI somewhere in the chain ---
  // Packing can finish with "ABIs not found for: …" and still publish. Before deltas were computed
  // against the accumulated state, such a gap healed by accident on the next run; now nothing
  // re-emits an unchanged contract, so an undetected gap is permanent in the chain.
  if (accumulatedAbiNames) {
    const uncovered = new Map<string, string[]>(); // artifact name → where it is needed
    for (const [chainId, projectedContracts] of Object.entries(projected)) {
      for (const [name, entry] of Object.entries(projectedContracts)) {
        if (addressOf(entry) == null) continue; // retired; the ABI is not needed going forward
        for (const abiName of missingAbiNames(name, accumulatedAbiNames)) {
          if (deltaAbiNames.has(abiName)) continue; // this delta closes it
          if (!uncovered.has(abiName)) uncovered.set(abiName, []);
          uncovered.get(abiName)!.push(`${chainId}.${name}`);
        }
      }
    }
    for (const [abiName, where] of uncovered) {
      errors.push({
        path: `abis.${abiName}`,
        message:
          `No layer in the chain carries this ABI, and this delta does not add it, but ` +
          `${where.length} live contract(s) need it (${where.slice(0, 3).join(", ")}` +
          `${where.length > 3 ? ", …" : ""}). An indexer walking the chain cannot decode them`,
      });
    }
  }

  // --- 4. Size heuristic ---
  const accumulatedContracts = Object.values(accumulatedChains || {}).reduce(
    (sum, chainData) => sum + Object.keys(chainData.contracts || {}).length,
    0,
  );
  const deltaContracts = Object.values(deltaChains).reduce(
    (sum, chainData) => sum + Object.keys(chainData.contracts || {}).length,
    0,
  );
  const deltaRatio = accumulatedContracts > 0 ? deltaContracts / accumulatedContracts : null;

  if (
    accumulatedContracts > 0 &&
    deltaContracts > SNAPSHOT_FLOOR &&
    deltaRatio !== null &&
    deltaRatio > SNAPSHOT_RATIO
  ) {
    warnings.push({
      path: "chains",
      message:
        `Delta carries ${deltaContracts} of ${accumulatedContracts} published contracts ` +
        `(${Math.round(deltaRatio * 100)}%) — large for a delta. Expected for a broad ` +
        `redeploy or a backlog of tombstones; otherwise check what it is comparing against`,
    });
  }

  return {
    errors,
    warnings,
    stats: {
      accumulatedContracts,
      deltaContracts,
      deltaRatio: deltaRatio === null ? null : Number(deltaRatio.toFixed(4)),
      redundantContracts: redundant,
      keptContracts,
      keptByChain,
      retirements,
    },
  };
}
