/**
 * Validates a generated registry against the indexer's hard requirements, plus the delta invariants
 * (./invariants.ts) against the published chain.
 *
 * Hard requirements (errors — break the indexer):
 *   - version: a non-empty string, **or** null for a patch layer (`previousRegistry.ipfsHash` set).
 *     api-v3 merges null-version patches into their predecessor, so the base still needs a version.
 *   - previousRegistry.ipfsHash: set whenever a live registry exists for the network, except in a
 *     testnet full snapshot the run asked for (a deliberate reset; mainnet is never reset this way),
 *     and naming the live tip: a link below it orphans every layer above the link, and one outside
 *     the live chain brings a chain nobody serves
 *   - version: not below the newest version the live chain names, except in a full snapshot the run
 *     asked for; a run generated from an older commit must not rewind the published version
 *   - chains.<id>.deployment.startBlock: a number (generation derives it as the earliest contract
 *     `blockNumber` the env config records)
 *   - chains.<id>.contracts.<name>.address: a 20-byte hex string for active contracts
 *   - chains.<id>.contracts.<name>.blockNumber: a number for active contracts, unless the chain has a
 *     deployment startBlock (api-v3 falls back to it); then a warning only
 *   - chains.<id>.retired: lowercase address → { contract, endBlock[, blockNumber] }
 *   - abis: an entry for every active contract (artifactNamesForContractKey, as packing uses)
 *
 * Old tombstones (`address: null`) skip the address, blockNumber and ABI checks.
 *
 * A delta with zero chains is not an error or a warning: it is what a run with nothing to publish
 * produces, and `summary.publishable` is false for it.
 */

import { artifactNamesForContractKey } from "./abi-names.ts";
import type { CollectedChain } from "./chain.ts";
import { checkDeltaInvariants, type DeltaStats, type EnvChains } from "./invariants.ts";
import { chainAddressHistory } from "./retirements.ts";
import type { Finding, Layer } from "./types.ts";
import { compareProtocolVersionStrings } from "./versions.ts";

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
  /**
   * The CID the network's hostname serves: a registry is live when it is set. Decided from the CID,
   * not from a fetched document, so a tip that could not be read never passes as "nothing live".
   */
  liveCid: string | null;
  /** The live tip's chain, for the link and delta checks; null when nothing is live. */
  liveChain: CollectedChain | null;
  /** The env this registry was generated from. */
  envChains: EnvChains;
  /** The run asked for a full snapshot: a deliberate new base registry, not a missing link. */
  fullSnapshot?: boolean;
}

/** The newest version the chain names; the tip may be a patch, which carries none. */
function newestVersion(layers: Layer[]): string | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const version = layers[i]?.version;
    if (typeof version === "string" && version) return version;
  }
  return null;
}

/**
 * How many layers the chain holds above the one `cid` names, or null when no link in the chain
 * names it. The oldest held layer's link counts too: on a partial chain it names the layer the walk
 * stopped at.
 */
function layersAbove(chain: CollectedChain, cid: string): number | null {
  // layers[i]'s CID is layers[i + 1].previousRegistry.ipfsHash; see CollectedChain
  for (let i = chain.layers.length - 1; i >= 0; i--) {
    if (chain.layers[i]?.previousRegistry?.ipfsHash === cid) return chain.layers.length - i;
  }
  return null;
}

export function validateRegistry({
  registry,
  liveCid,
  liveChain,
  envChains,
  fullSnapshot = false,
}: ValidateInput): ValidationReport {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const liveVersion = liveChain && !liveChain.fatal ? newestVersion(liveChain.layers) : null;
  const live = liveVersion ? `version ${liveVersion}` : `CID ${liveCid}`;

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
  // A layer with no link while a registry is live cuts the published chain off. Only a full snapshot
  // the run asked for may, and only on testnet, which is reset from time to time; a mainnet reset
  // would strand every consumer walking its chain, and is not something a run does
  const link = registry.previousRegistry?.ipfsHash;
  if (liveCid && !link) {
    if (fullSnapshot && registry.network === "testnet") {
      warnings.push({
        path: "previousRegistry",
        message: `Full snapshot: this replaces the published testnet chain (live ${live}) with a new base registry`,
      });
    } else {
      errors.push({
        path: "previousRegistry.ipfsHash",
        message: fullSnapshot
          ? `A full snapshot would cut off the published ${registry.network} chain (live ${live}); only testnet is reset this way`
          : `A live registry exists (${live}) but this registry has no previousRegistry.ipfsHash — it would be an orphan in the linked list`,
      });
    }
  }

  // A link that is not the live tip (a sourceCid) either sits below it, so that pointing the hostname
  // at this layer orphans every layer above the link, or outside the live chain, so that consumers
  // would follow a chain nobody served. Neither is published; a layer to build on is accepted first
  // by pointing the hostname at it.
  if (liveCid && link && link !== liveCid && liveChain && !liveChain.fatal) {
    const above = layersAbove(liveChain, link);
    const path = "previousRegistry.ipfsHash";
    if (above !== null) {
      errors.push({
        path,
        message:
          `Links to ${link}, ${above} layer(s) below the live tip ${liveCid}: publishing this layer ` +
          `would orphan them. To build on ${link} on purpose, point the hostname at it and accept it.`,
      });
    } else if (liveChain.complete) {
      errors.push({
        path,
        message: `Links to ${link}, which is not in the published ${registry.network} chain (live tip ${liveCid})`,
      });
    } else {
      errors.push({
        path,
        message: `Cannot tell whether ${link} is in the published ${registry.network} chain: ${liveChain.reason}`,
      });
    }
  }

  // --- version against the live chain ---
  // A lower version means the run generated from an older commit than the one published. The
  // indexer orders releases by it, so the layer would read as a step back. A full snapshot the run
  // asked for is a deliberate reset and may start anywhere.
  if (
    liveCid &&
    liveVersion &&
    versionIsString &&
    !fullSnapshot &&
    compareProtocolVersionStrings(registry.version as string, liveVersion) < 0
  ) {
    errors.push({
      path: "version",
      message:
        `Version ${registry.version} is lower than the live ${registry.network} registry's ` +
        `${liveVersion}: a publish cannot rewind the published version. Generate from the release ` +
        `branch head, or publish a full snapshot on purpose.`,
    });
  }

  // --- chains ---
  const chains = registry.chains || {};
  const chainIds = Object.keys(chains);

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
  if (liveCid && liveChain && mode !== "full") {
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
