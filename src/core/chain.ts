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
 * `isAncestor` answers whether one layer lies below another in that list.
 *
 * Network I/O reaches this module only as `fetchLayer`.
 */

import { LayerVerificationError } from "./layer-verification-error.ts";
import type { AccumulatedState, Layer } from "./types.ts";

// Chain length guard. Cycles are caught precisely by the `seen` set below, so this only bounds
// how many fetches a single run may do. Keep it well clear of real chain lengths — the published
// chain grows by one layer per publish and testnet is already ~50 layers deep — because hitting
// this guard fails generation rather than silently truncating the comparison.
export const DEFAULT_MAX_DEPTH = 500;

/**
 * Fetches the layer a CID addresses. A rejection ends the walk, its message becoming the `reason`.
 *
 * The walk trusts what this returns. A pinned head vouches for the chain only when the bytes of
 * every layer, as served, were checked with `verifyLayer` before any parse; `layerFromBytes` does
 * that and parses, keeping integers above 2^53 exact.
 */
export type FetchLayer = (cid: string) => Promise<Layer>;

export interface CollectOptions {
  fetchLayer: FetchLayer;
  /**
   * Maximum number of layers to hold, tip included. A chain of exactly maxDepth layers still
   * completes; only one longer than that is refused.
   */
  maxDepth?: number;
  /**
   * When set, every layer, tip included, must declare this network. One that declares another, or
   * none, is refused, fatal.
   */
  expectedNetwork?: string | null;
  /**
   * CIDs at which the walk stops without fetching them. Checked against each layer's
   * `previousRegistry.ipfsHash`, so the tip's own CID, which this function never sees, is never
   * matched. Compared as strings, so pass canonical CIDs (see `verifyLayer`).
   */
  stopAt?: ReadonlySet<string>;
}

export interface CollectedChain {
  /**
   * Ordered oldest → newest. The CID of `layers[i]` is `layers[i + 1].previousRegistry.ipfsHash`;
   * the newest layer's is the tip CID the caller fetched.
   */
  layers: Layer[];
  accumulated: AccumulatedState;
  /** ABI names the layers publish between them. */
  accumulatedAbis: Set<string>;
  /** True only when the walk reached the base snapshot; false when it stopped, failed or was refused. */
  complete: boolean;
  /**
   * The `stopAt` CID the walk stopped before fetching, or null; `layers` and `accumulated` then
   * cover only the layers above it.
   */
  stoppedAt: string | null;
  /** Why the walk failed or was refused; null when it completed or stopped at `stopAt`. */
  reason: string | null;
  /**
   * The chain is not merely incomplete but invalid: no "proceed anyway" override may apply. Set for
   * a rejected tip, a network refusal, and a `LayerVerificationError` from `fetchLayer`. A fatal
   * result carries no layers and an empty accumulated state.
   */
  fatal: boolean;
}

/**
 * Minimal shape check for a registry layer.
 *
 * Deliberately narrow: `chains` is the only field every layer shape (delta, patch, full) must
 * carry, and it is the field the accumulated state is built from.
 *
 * @param document - A parsed JSON value
 * @returns Whether it is an object with a `chains` object
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
 * Any other end — a broken pointer, an unfetchable layer, a cycle, the depth guard or a network
 * refusal — leaves the chain incomplete with a `reason`, which callers must treat as "cannot
 * compute a trustworthy delta".
 *
 * With `options.stopAt` the walk ends before fetching a listed CID; see `stoppedAt`.
 *
 * @param tipRegistry - The newest layer, already fetched; verify its bytes like every other layer's,
 *   since the walk never sees its CID
 * @param options - How to fetch layers, and the optional depth bound, network and stop set
 * @returns The layers oldest → newest with their accumulated state; refusals set `fatal`
 */
export async function collectRegistryChain(
  tipRegistry: Layer,
  options: CollectOptions,
): Promise<CollectedChain> {
  const { fetchLayer, maxDepth = DEFAULT_MAX_DEPTH, expectedNetwork = null, stopAt } = options;

  const layers: Layer[] = [tipRegistry];
  const seen = new Set<string>();
  let current = tipRegistry;
  let complete = false;
  let stoppedAt: string | null = null;

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
    // Before the cycle and depth guards: a stop adds no layer, so it ends the walk cleanly even
    // at maxDepth.
    if (stopAt?.has(previousCid)) {
      stoppedAt = previousCid;
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
      // A layer that fails verification is invalid, not an outage: no override applies.
      fatal = isVerificationError(error);
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
      stoppedAt: null,
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
    stoppedAt,
    reason,
    fatal,
  };
}

// By name as well as by class: a consumer can hold two copies of this package (one vendored, one
// installed), and an instance check across them would let a verification failure read as an outage.
function isVerificationError(error: unknown): boolean {
  return (
    error instanceof LayerVerificationError ||
    (error instanceof Error && error.name === "LayerVerificationError")
  );
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
 * With no expected network nothing is checked.
 *
 * A layer must declare the expected network as a string. One that names another network, or none
 * at all, is refused: a mistyped source CID pointing at the other environment's chain would
 * otherwise flatten that environment's contracts into this delta and pass every downstream check,
 * and a layer with no label cannot be told apart from one of those.
 */
function networkMismatchReason(layer: Layer, expectedNetwork: string | null): string | null {
  if (!expectedNetwork) return null;
  const declared = layer?.network;
  if (declared === expectedNetwork) return null;
  const declaration =
    typeof declared === "string" ? `declares network "${declared}"` : "declares no network";
  return (
    `layer ${describeLayer(layer)} ${declaration}, ` +
    `but "${expectedNetwork}" is being generated — refusing to mix environments`
  );
}

export interface IsAncestorOptions {
  /** Maximum number of layers the walk may hold, head included; see CollectOptions. */
  maxDepth?: number;
  /** When set, every layer walked must declare this network; see CollectOptions. */
  expectedNetwork?: string | null;
}

/**
 * Reports whether `ancestorCid` is `headCid` or a layer the chain below it points to.
 *
 * Answers true as soon as the walk would reach the ancestor, without fetching or verifying the
 * ancestor or anything under it, and false only when the walk reaches the base snapshot without
 * meeting it. When the walk cannot finish it throws: an unfetchable layer must not read as "not an
 * ancestor". See `FetchLayer` for what the walk trusts.
 *
 * @param headCid - The CID of the newest layer; fetched through `fetchLayer` unless it equals the ancestor
 * @param ancestorCid - The CID to look for, in canonical form: it is compared as a string with each
 *   `previousRegistry.ipfsHash`, so another spelling of the same CID is never found
 * @param fetchLayer - Fetches one layer by CID
 * @param options - The depth bound and expected network of the walk
 * @returns Whether the ancestor is the head or lies below it in the chain
 * @throws A plain `Error` with the message `cannot walk from <head>: <reason>` when the head cannot
 *   be fetched or is not a registry document, a layer in the chain cannot be fetched or has no
 *   usable pointer, the chain cycles or exceeds `maxDepth`, or a layer fails the network check;
 *   its `cause` is the error `fetchLayer` threw, such as a `LayerVerificationError`
 */
export async function isAncestor(
  headCid: string,
  ancestorCid: string,
  fetchLayer: FetchLayer,
  options: IsAncestorOptions = {},
): Promise<boolean> {
  if (headCid === ancestorCid) return true;

  let head: Layer;
  try {
    head = await fetchLayer(headCid);
  } catch (error) {
    throw new Error(`cannot walk from ${headCid}: ${(error as Error).message}`, { cause: error });
  }

  // The walk reports a failed fetch as a message; the error itself is kept to travel as the cause.
  let fetchError: unknown;
  const walk = await collectRegistryChain(head, {
    ...options,
    fetchLayer: async (cid) => {
      try {
        return await fetchLayer(cid);
      } catch (error) {
        fetchError = error;
        throw error;
      }
    },
    stopAt: new Set([ancestorCid]),
  });
  if (walk.stoppedAt !== null) return true;
  if (walk.complete) return false;
  throw new Error(`cannot walk from ${headCid}: ${walk.reason}`, { cause: fetchError });
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
 * @returns Chain id → that chain's merged contracts, adapters, network and retired map
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
 *
 * @param layers - Registry documents, in any order
 * @returns Every ABI name any layer carries
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

/**
 * The same layer without its ABI bodies: a chain walk needs which ABIs a layer carries, not them.
 *
 * @param layer - A registry layer; not modified
 * @returns A layer whose every ABI is an empty array, or the layer itself when it carries none
 */
export function slimLayer(layer: Layer): Layer {
  if (!layer.abis) return layer;
  return { ...layer, abis: Object.fromEntries(Object.keys(layer.abis).map((name) => [name, []])) };
}

/**
 * Human-readable label for a registry layer, used in diagnostics.
 *
 * @param registry - A registry layer
 * @returns Its quoted version or deploy commit, or "(unversioned patch)"
 */
export function describeLayer(registry: Layer): string {
  const version = registry?.version || registry?.deploymentInfo?.gitCommit;
  return version ? `"${version}"` : "(unversioned patch)";
}
