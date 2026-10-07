/**
 * Validates a generated registry against the indexer's hard requirements, plus the delta invariants
 * (./invariants.ts) against the published chain.
 *
 * Hard requirements (errors — break the indexer):
 *   - version: a non-empty string, **or** null for a patch layer (`previousRegistry.ipfsHash` set).
 *     api-v3 merges null-version patches into their predecessor, so the base still needs a version.
 *   - previousRegistry.ipfsHash: set whenever a live registry exists for the network
 *   - chains.<id>.deployment.startBlock: a number
 *   - chains.<id>.contracts.<name>.address: a 20-byte hex string for active contracts
 *   - chains.<id>.contracts.<name>.blockNumber: a number for active contracts, unless the chain has a
 *     deployment startBlock (api-v3 falls back to it); then a warning only
 *   - chains.<id>.retired: lowercase address → { contract, endBlock[, blockNumber] }
 *   - abis: an entry for every active contract (artifactNamesForContractKey, as packing uses)
 *
 * Old tombstones (`address: null`) skip the address, blockNumber and ABI checks.
 */

import { artifactNamesForContractKey } from "./abi-names.ts";
import type { CollectedChain } from "./chain.ts";
import { checkDeltaInvariants, type DeltaStats, type EnvChains } from "./invariants.ts";
import { chainAddressHistory } from "./retirements.ts";
import type { Finding, Layer } from "./types.ts";

export interface ValidationSummary {
  mode: "full" | "delta" | "patch";
  chains: number;
  contracts: number;
  retirements: number;
  abis: number;
  delta?: DeltaStats;
  errors: number;
  warnings: number;
  /**
   * Passes every hard requirement and carries something: an empty layer publishes nothing an
   * indexer needs, so it is not pinned.
   */
  publishable: boolean;
}

export interface ValidationReport {
  errors: Finding[];
  warnings: Finding[];
  summary: ValidationSummary;
}

export interface ValidateInput {
  registry: Layer;
  /** The live tip; null when none is published (or the check is skipped). */
  liveTip: Layer | null;
  /** The live tip's chain, for the delta invariants; null to skip them. */
  liveChain: CollectedChain | null;
  /** The env this registry was generated from. */
  envChains: EnvChains;
}

export function validateRegistry({
  registry,
  liveTip,
  liveChain,
  envChains,
}: ValidateInput): ValidationReport {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  const hasPreviousRegistryHash =
    typeof registry.previousRegistry?.ipfsHash === "string" &&
    registry.previousRegistry.ipfsHash.length > 0;
  const versionIsString = typeof registry.version === "string" && registry.version.length > 0;
  const mode: ValidationSummary["mode"] =
    registry.previousRegistry == null
      ? "full"
      : registry.version === null && hasPreviousRegistryHash
        ? "patch"
        : "delta";

  // --- version ---
  if (mode === "patch") {
    if (registry.version !== null) {
      errors.push({
        path: "version",
        message: `Patch registries must have version: null, got ${JSON.stringify(registry.version)}`,
      });
    }
  } else if (!versionIsString) {
    errors.push({
      path: "version",
      message:
        mode === "full"
          ? `Full snapshot must have a non-empty string version, got ${JSON.stringify(registry.version)}`
          : `Delta registries must have a non-empty string version, got ${JSON.stringify(registry.version)} (use a null version only when this is a patch layer with previousRegistry.ipfsHash set)`,
    });
  }

  // --- previousRegistry.ipfsHash ---
  if (liveTip && !registry.previousRegistry?.ipfsHash) {
    errors.push({
      path: "previousRegistry.ipfsHash",
      message: `A live registry exists (version ${liveTip.version}) but this registry has no previousRegistry.ipfsHash — it would be an orphan in the linked list`,
    });
  }

  // --- chains ---
  const chains = registry.chains || {};
  const chainIds = Object.keys(chains);
  if (chainIds.length === 0) {
    warnings.push({ path: "chains", message: "Delta registry has zero chains — nothing changed?" });
  }

  const requiredAbis = new Set<string>();
  let totalContracts = 0;

  for (const chainId of chainIds) {
    const chain = chains[chainId];

    const startBlock = chain.deployment?.startBlock;
    if (startBlock == null) {
      errors.push({
        path: `chains.${chainId}.deployment.startBlock`,
        message: "Required by indexer, got null/undefined",
      });
    } else if (typeof startBlock !== "number") {
      errors.push({
        path: `chains.${chainId}.deployment.startBlock`,
        message: `Must be a number, got ${typeof startBlock}: ${JSON.stringify(startBlock)}`,
      });
    }

    for (const [name, entry] of Object.entries(chain.contracts || {})) {
      totalContracts++;
      const contract = (typeof entry === "string" ? { address: entry } : entry) as {
        address?: unknown;
        blockNumber?: unknown;
      };

      if (contract.address === null) continue; // an old tombstone

      for (const artifact of artifactNamesForContractKey(name)) requiredAbis.add(artifact);

      if (!contract.address || typeof contract.address !== "string") {
        errors.push({
          path: `chains.${chainId}.contracts.${name}.address`,
          message: `Must be a non-empty string, got ${JSON.stringify(contract.address)}`,
        });
      } else if (!/^0x[0-9a-fA-F]{40}$/.test(contract.address)) {
        errors.push({
          path: `chains.${chainId}.contracts.${name}.address`,
          message: `Not a 20-byte hex address: ${JSON.stringify(contract.address)}`,
        });
      }

      // api-v3 uses contract.blockNumber ?? chain.deployment.startBlock, so a null is allowed when
      // the chain has a numeric start (e.g. CREATE3 contracts the explorers cannot place)
      const hasDeploymentStartBlock = typeof startBlock === "number" && Number.isFinite(startBlock);
      if (contract.blockNumber == null) {
        if (hasDeploymentStartBlock) {
          warnings.push({
            path: `chains.${chainId}.contracts.${name}.blockNumber`,
            message:
              "Null blockNumber — allowed because chain.deployment.startBlock is set (indexer fallback); add blockNumber when creation data is available",
          });
        } else {
          errors.push({
            path: `chains.${chainId}.contracts.${name}.blockNumber`,
            message:
              "Required by indexer, got null/undefined (no chain.deployment.startBlock fallback)",
          });
        }
      } else if (typeof contract.blockNumber !== "number") {
        errors.push({
          path: `chains.${chainId}.contracts.${name}.blockNumber`,
          message: `Must be a number, got ${typeof contract.blockNumber}: ${JSON.stringify(contract.blockNumber)}`,
        });
      }
    }
  }

  // --- retired: lowercase address → { contract, endBlock[, blockNumber] } ---
  let totalRetirements = 0;
  for (const chainId of chainIds) {
    const retired = chains[chainId].retired as unknown;
    if (retired == null) continue;
    if (typeof retired !== "object" || Array.isArray(retired)) {
      errors.push({
        path: `chains.${chainId}.retired`,
        message: "Must be an object of lowercase address → { contract, endBlock }",
      });
      continue;
    }
    for (const [address, value] of Object.entries(retired as Record<string, unknown>)) {
      totalRetirements++;
      const path = `chains.${chainId}.retired.${address}`;
      if (!/^0x[0-9a-f]{40}$/.test(address)) {
        errors.push({ path, message: "Key must be a lowercase 20-byte hex address" });
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push({ path, message: "Must be an object with contract and endBlock" });
        continue;
      }
      const entry = value as { contract?: unknown; endBlock?: unknown; blockNumber?: unknown };
      if (typeof entry.contract !== "string" || entry.contract.length === 0) {
        errors.push({
          path: `${path}.contract`,
          message: `Must be a non-empty string, got ${JSON.stringify(entry.contract)}`,
        });
      }
      const endBlockValid = Number.isInteger(entry.endBlock) && (entry.endBlock as number) >= 1;
      if (!endBlockValid) {
        errors.push({
          path: `${path}.endBlock`,
          message: `Must be a positive integer, got ${JSON.stringify(entry.endBlock)}`,
        });
      }
      if (entry.blockNumber != null && !Number.isInteger(entry.blockNumber)) {
        errors.push({
          path: `${path}.blockNumber`,
          message: `Must be an integer when present, got ${JSON.stringify(entry.blockNumber)}`,
        });
      } else if (
        Number.isInteger(entry.blockNumber) &&
        Number.isInteger(entry.endBlock) &&
        (entry.endBlock as number) < (entry.blockNumber as number)
      ) {
        errors.push({
          path: `${path}.endBlock`,
          message: `Precedes the contract's blockNumber ${entry.blockNumber}`,
        });
      }
    }
  }

  // --- abis completeness (active contracts only) ---
  const abiNames = new Set(Object.keys(registry.abis || {}));
  for (const needed of requiredAbis) {
    if (!abiNames.has(needed)) {
      errors.push({
        path: `abis.${needed}`,
        message: `Missing ABI — active contract in chains but no ABI entry`,
      });
    }
  }

  // --- delta invariants (semantic, not structural) ---
  // Structural checks pass on a delta that re-states already-published contracts, which is how a
  // near-full snapshot shipped three times. These compare the delta to the state it extends.
  let deltaStats: DeltaStats | null = null;
  if (liveTip && liveChain && mode !== "full") {
    if (liveChain.fatal) {
      // An unreachable layer only costs the invariant check; a chain from the other environment
      // means this registry is being compared to the wrong world entirely.
      errors.push({
        path: "(chain)",
        message: `Published chain is unusable: ${liveChain.reason}`,
      });
    } else if (!liveChain.complete) {
      warnings.push({
        path: "(chain)",
        message: `Skipped delta invariants — could not reconstruct the published chain: ${liveChain.reason}`,
      });
    } else {
      // Every address each chain ever published live, so a retirement naming one the chain never
      // carried is caught here rather than by a consumer
      const publishedAddresses: Record<string, Set<string>> = {};
      const layerChainIds = new Set(
        liveChain.layers.flatMap((layer) => Object.keys(layer?.chains || {})),
      );
      for (const chainId of layerChainIds) {
        publishedAddresses[chainId] = new Set(
          chainAddressHistory(liveChain.layers, chainId).addresses.keys(),
        );
      }
      const invariants = checkDeltaInvariants({
        accumulatedChains: liveChain.accumulated,
        accumulatedAbiNames: liveChain.accumulatedAbis,
        deltaRegistry: registry,
        envChains,
        publishedAddresses,
      });
      errors.push(...invariants.errors);
      warnings.push(...invariants.warnings);
      deltaStats = invariants.stats;
    }
  }

  return {
    errors,
    warnings,
    summary: {
      mode,
      chains: chainIds.length,
      contracts: totalContracts,
      retirements: totalRetirements,
      abis: abiNames.size,
      ...(deltaStats ? { delta: deltaStats } : {}),
      errors: errors.length,
      warnings: warnings.length,
      publishable: errors.length === 0 && chainIds.length > 0,
    },
  };
}
