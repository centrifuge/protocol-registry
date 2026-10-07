/**
 * Decides which env contracts belong in a delta.
 *
 * The decision is made against the *accumulated* published state — every layer of the chain
 * flattened (see ./chain.ts) — never against a single layer. A single layer carries only its own
 * changes, so comparing against one marks every contract it happens to omit as new, which inflates
 * the delta into a near-full snapshot.
 *
 * A contract missing from env is never retired here. Env is written by deploy scripts that record
 * what they deployed and leave the rest alone (a release's `REPLACE` run drops everything it did not
 * redeploy), so a missing key says nothing about whether the contract is still in use. Retirement is
 * declared explicitly instead; see ./retirements.ts.
 */

import type { AccumulatedChain, ContractEntry } from "./types.ts";

/** Reads the address off an env or registry contract entry, which may be a bare address string. */
export function addressOf(entry: ContractEntry | null | undefined): string | null | undefined {
  return typeof entry === "string" ? entry : entry?.address;
}

/** Reads the blockNumber off a contract entry; a bare address string has none. */
export function blockNumberOf(entry: ContractEntry | null | undefined): number | null | undefined {
  return typeof entry === "string" ? null : entry?.blockNumber;
}

/**
 * Reports whether a contract differs from what the published chain already carries.
 *
 * @param accumulatedChain - Chain data merged across all registry layers; a single layer here
 *        would over-report changes
 * @returns True if the contract is new or was redeployed
 */
export function hasContractChanged(
  contractName: string,
  localContract: ContractEntry,
  accumulatedChain: Partial<AccumulatedChain> | null | undefined,
): boolean {
  if (!accumulatedChain?.contracts) {
    return true; // Nothing published for this chain yet, so everything is new
  }

  const existingContract = accumulatedChain.contracts[contractName];
  if (!existingContract) {
    return true; // New contract
  }

  if (addressOf(localContract)?.toLowerCase() !== addressOf(existingContract)?.toLowerCase()) {
    return true;
  }

  // A blockNumber that differs at the same address means the entry was corrected or redeployed.
  // A blockNumber env has and the chain never carried counts too: explorer lookups fill these in
  // after the fact, and requiring both sides to have one meant such a backfill could never reach
  // the chain — the indexer would keep starting that contract's listener from the chain-level
  // startBlock instead.
  //
  // The reverse is deliberately not a change. Emitting an entry whose blockNumber is null would
  // overwrite the published number with null (the indexer's merge takes leaf nulls literally, as
  // tombstones rely on), so env dropping a blockNumber must not erase what is already published.
  const localBlock = blockNumberOf(localContract);
  const existingBlock = blockNumberOf(existingContract);
  if (localBlock != null && String(localBlock) !== String(existingBlock)) {
    return true;
  }

  return false;
}

export interface ChainDeltaOptions {
  /** ABI names present anywhere in the chain (see flattenRegistryAbis). Omit to skip ABI-gap detection. */
  publishedAbiNames?: Set<string> | null;
  /** Artifact basenames a contract key requires; `artifactNamesForContractKey` in production. */
  abiNamesForContract?: (contractKey: string) => string[];
}

export interface ChainDelta {
  changed: Set<string>;
  /** Published, live, absent from env, and not emitted. */
  kept: Set<string>;
  /** Subset of `changed`: entries included only to heal a missing ABI. */
  abiGaps: Set<string>;
}

/**
 * Computes one chain's delta membership: which env contracts to include.
 *
 * A contract the accumulated state carries live but env no longer lists is reported as `kept` and
 * left published as it is. Tombstoning it here is what retired the v3.1 on/off-ramp factory while
 * its managers were still in use: env dropped the key during a v3.2 cleanup, and the indexer stopped
 * watching a factory that was never retired.
 *
 * ABI gaps also force inclusion. Packing can finish with "ABIs not found for: …" and still
 * publish, leaving a contract in the chain with no ABI anywhere. While deltas were computed against
 * the tip alone that healed by accident — nearly every contract counted as changed on every run, so
 * its ABI was re-shipped. Comparing against the accumulated state removed that accident, which
 * would make such a gap permanent. So an active contract whose ABI the chain never carried is
 * re-emitted even when its address is unchanged, purely to ship the missing ABI.
 */
export function computeChainDelta(
  envContracts: Record<string, ContractEntry> | null | undefined,
  accumulatedChain: Partial<AccumulatedChain> | null | undefined,
  options: ChainDeltaOptions = {},
): ChainDelta {
  const { publishedAbiNames = null, abiNamesForContract = () => [] } = options;
  const changed = new Set<string>();
  const abiGaps = new Set<string>();
  const kept = new Set<string>();
  const contracts = envContracts || {};

  for (const [contractName, contractData] of Object.entries(contracts)) {
    if (hasContractChanged(contractName, contractData, accumulatedChain)) {
      changed.add(contractName);
      continue;
    }
    // Unchanged — but if the chain has no ABI for it, it must ride along to carry one.
    if (!publishedAbiNames || addressOf(contractData) == null) continue;
    const missing = abiNamesForContract(contractName).filter(
      (name) => !publishedAbiNames.has(name),
    );
    if (missing.length > 0) {
      changed.add(contractName);
      abiGaps.add(contractName);
    }
  }

  for (const [contractName, published] of Object.entries(accumulatedChain?.contracts || {})) {
    if (addressOf(published) == null) continue;
    if (contracts[contractName]) continue;
    kept.add(contractName);
  }

  return { changed, kept, abiGaps };
}
