/**
 * Reconstructs the accumulated (flattened) state of the published registry chain.
 *
 * Published registries are a linked list: each layer carries only the contracts that changed in
 * that publish and points at its predecessor via `previousRegistry.ipfsHash`. Indexers walk that
 * list and merge layers to obtain the effective state of every contract.
 *
 * Delta generation has to compare against that same effective state. Comparing against the tip
 * document alone treats every contract the tip happens not to carry as "new", which inflates the
 * delta to a near-full snapshot and — because the next run then compares against that large
 * layer — makes successive publishes oscillate between complementary halves of the contract set.
 *
 * `collectRegistryChain` is the entry point to prefer: it returns the accumulated state already
 * flattened, so callers never have to know that `flattenRegistryChain` requires oldest → newest
 * ordering (feeding it the other way round silently yields stale winners).
 *
 * Network I/O (gateways, layer cache) lives in ../io/ipfs.ts and reaches this module as `fetchLayer`.
 */

import type { AccumulatedState, Layer } from "./types.ts";

// Chain length guard. Cycles are caught precisely by the `seen` set below, so this only bounds
// how many fetches a single run may do. Keep it well clear of real chain lengths — the published
// chain grows by one layer per publish and testnet is already ~50 layers deep — because hitting
// this guard fails generation rather than silently truncating the comparison.
export const DEFAULT_MAX_DEPTH = 500;

export type FetchLayer = (cid: string) => Promise<Layer>;

export interface CollectOptions {
  fetchLayer: FetchLayer;
  /**
   * Maximum number of layers to hold, tip included. A chain of exactly maxDepth layers still
   * completes; only one longer than that is refused.
   */
  maxDepth?: number;
  /** When set, every layer must declare this network; see networkMismatchReason. */
  expectedNetwork?: string | null;
}

export interface CollectedChain {
  /** Ordered oldest → newest. */
  layers: Layer[];
  accumulated: AccumulatedState;
  /** ABI names the layers publish between them. */
  accumulatedAbis: Set<string>;
  complete: boolean;
  reason: string | null;
  /** The chain is not merely incomplete but invalid: no "proceed anyway" override may apply. */
  fatal: boolean;
}

/**
 * Minimal shape check for a registry layer.
 *
 * Deliberately narrow: `chains` is the only field every layer shape (delta, patch, full) must
 * carry, and it is the field the accumulated state is built from.
 */
export function isRegistryDocument(document: unknown): document is Layer {
  if (document == null || typeof document !== "object" || Array.isArray(document)) return false;
  const chains = (document as { chains?: unknown }).chains;
  return typeof chains === "object" && chains !== null && !Array.isArray(chains);
}

/**
 * Walks the registry linked list backwards from a tip document, collecting every layer.
 *
 * The walk terminates cleanly at the base snapshot (a layer with no `previousRegistry`).
 * Any other stop — a broken pointer, an unfetchable layer, a cycle, or the depth guard — leaves
 * the chain incomplete, which callers must treat as "cannot compute a trustworthy delta".
 */
export async function collectRegistryChain(
  tipRegistry: Layer,
  options: CollectOptions,
): Promise<CollectedChain> {
  const { fetchLayer, maxDepth = DEFAULT_MAX_DEPTH, expectedNetwork = null } = options;

  const layers: Layer[] = [tipRegistry];
  const seen = new Set<string>();
  let current = tipRegistry;
  let complete = false;

  // The tip is checked before walking: it comes from the caller, so it is both the layer no
  // gateway shape check has seen and the one most likely to be from the wrong network. There is
  // no point walking a chain we reject.
  let reason = tipRejectionReason(tipRegistry, expectedNetwork);
  let fatal = reason != null;

  // Keep walking while nothing has gone wrong. The terminal check comes before the depth bound,
  // so a chain whose base snapshot is the maxDepth'th layer is reported complete rather than
  // "too long": the bound limits how many layers may be held, not how many may be inspected.
  while (!reason) {
    if (!current.previousRegistry) {
      complete = true; // base snapshot reached
      break;
    }

    const previousCid = current.previousRegistry.ipfsHash;
    if (!previousCid) {
      reason =
        `layer ${describeLayer(current)} points at previous version ` +
        `"${current.previousRegistry.version ?? "unknown"}" but carries no previousRegistry.ipfsHash`;
      break;
    }
    if (seen.has(previousCid)) {
      reason = `cycle detected — ${previousCid} appears twice in the chain`;
      break;
    }
    if (layers.length >= maxDepth) {
      reason = `chain longer than maxDepth ${maxDepth} — refusing to keep walking`;
      break;
    }
    seen.add(previousCid);

    let previous: Layer;
    try {
      previous = await fetchLayer(previousCid);
    } catch (error) {
      reason = (error as Error).message;
      break;
    }

    // Checked before the layer joins `layers`, so a foreign layer never reaches the accumulated
    // state even though the walk is about to be reported incomplete.
    const mismatch = networkMismatchReason(previous, expectedNetwork);
    if (mismatch) {
      reason = mismatch;
      fatal = true;
      break;
    }

    layers.push(previous);
    current = previous;
  }

  // A cross-network chain yields nothing usable: returning an empty state means that even a
  // caller which ignored `fatal` cannot end up comparing against the wrong environment.
  if (fatal) {
    return {
      layers: [],
      accumulated: {},
      accumulatedAbis: new Set(),
      complete: false,
      reason,
      fatal,
    };
  }

  layers.reverse(); // oldest → newest
  return {
    layers,
    accumulated: flattenRegistryChain(layers),
    accumulatedAbis: flattenRegistryAbis(layers),
    complete,
    reason,
    fatal,
  };
}

/**
 * Reports why the tip cannot be walked, or null if it is usable.
 *
 * Both rejections are fatal: an unvalidated tip flattens to an empty accumulated state, which
 * reads as "nothing is published yet" and inflates the delta into a full snapshot — exactly what
 * no override should be able to wave through.
 */
function tipRejectionReason(tip: Layer, expectedNetwork: string | null): string | null {
  if (!isRegistryDocument(tip)) return `tip document is not a registry (no "chains" object)`;
  return networkMismatchReason(tip, expectedNetwork);
}

/**
 * Reports why a layer does not belong to the network being generated, or null if it is fine.
 *
 * Nothing in the chain format ties a layer to a network, so a mistyped source CID pointing at the
 * other environment's chain would otherwise flatten that environment's contracts into this delta
 * and pass every downstream check — the delta invariants included, since they compare against
 * this same accumulated state.
 *
 * A layer with no `network` field is treated as unknown rather than wrong: every layer published
 * so far carries one, but refusing to walk an older base snapshot that predates the field would
 * turn a missing label into a hard generation failure.
 */
function networkMismatchReason(layer: Layer, expectedNetwork: string | null): string | null {
  if (!expectedNetwork) return null;
  const declared = layer?.network;
  if (typeof declared !== "string") return null;
  if (declared === expectedNetwork) return null;
  return (
    `layer ${describeLayer(layer)} declares network "${declared}", ` +
    `but "${expectedNetwork}" is being generated — refusing to mix environments`
  );
}

/**
 * Merges registry layers into the accumulated contract state an indexer would hold.
 *
 * Later layers win, so a contract redeployed several times resolves to its newest entry and a
 * tombstone (`address: null`) published later correctly shadows the live entry before it. A
 * chain's `retired` map (lowercase address → { contract, endBlock }, see ./retirements.ts) merges
 * the same way, per address.
 *
 * @param layers - Registry documents ordered oldest → newest
 */
export function flattenRegistryChain(layers: Layer[]): AccumulatedState {
  const accumulated: AccumulatedState = {};

  for (const layer of layers) {
    for (const [chainId, chainData] of Object.entries(layer?.chains || {})) {
      const target = (accumulated[chainId] ??= { contracts: {} });

      // Newest layer that carries these fields wins; they are metadata only (the delta comparison
      // reads `contracts`), but keeping them makes the state self-describing.
      if (chainData.network) target.network = chainData.network;
      if (chainData.adapters) target.adapters = chainData.adapters;

      Object.assign(target.contracts, chainData.contracts || {});

      if (chainData.retired) {
        target.retired ??= {};
        for (const [address, entry] of Object.entries(chainData.retired)) {
          target.retired[address.toLowerCase()] = entry;
        }
      }
    }
  }

  return accumulated;
}

/**
 * Collects every ABI name published anywhere in the chain.
 *
 * Presence, not freshness: an indexer walking the chain resolves a contract's ABI from whichever
 * layer last carried it, so a name published once stays available. This is what makes it possible
 * to tell a contract whose ABI the chain already has from one whose ABI was never shipped — see
 * the ABI-gap healing in ./delta.ts.
 */
export function flattenRegistryAbis(layers: Layer[]): Set<string> {
  const names = new Set<string>();
  for (const layer of layers) {
    for (const name of Object.keys(layer?.abis || {})) names.add(name);
  }
  return names;
}

/** Counts chains and contracts in an accumulated state, for logging. */
export function summarizeAccumulatedState(accumulated: AccumulatedState): {
  chains: number;
  contracts: number;
} {
  const chains = Object.keys(accumulated).length;
  const contracts = Object.values(accumulated).reduce(
    (sum, chain) => sum + Object.keys(chain.contracts || {}).length,
    0,
  );
  return { chains, contracts };
}

/** Human-readable label for a registry layer, used in diagnostics. */
export function describeLayer(registry: Layer): string {
  const version = registry?.version || registry?.deploymentInfo?.gitCommit;
  return version ? `"${version}"` : "(unversioned patch)";
}
