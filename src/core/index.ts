/**
 * The public surface of the registry's core: reading a published layer chain, proving a layer is
 * the one its CID names, and comparing what chains published. Nothing here does I/O itself: chain
 * walks reach layers only through the caller's `fetchLayer`, and nothing reads the network, a file
 * or an environment.
 *
 * Chain walking
 * - `collectRegistryChain(tip, { fetchLayer, maxDepth?, expectedNetwork?, stopAt? })` walks
 *   `previousRegistry` pointers from a fetched tip to the base snapshot or a `stopAt` CID and returns
 *   the layers oldest to newest with their accumulated state. Failures are returned (`reason`,
 *   `fatal`), not thrown.
 * - `isAncestor(headCid, ancestorCid, fetchLayer, options?)` resolves to whether the chain below the
 *   head contains the ancestor; it throws, naming the reason, when the walk cannot finish.
 * - `flattenRegistryChain(layers)` and `flattenRegistryAbis(layers)` merge layers ordered oldest to
 *   newest into the accumulated contracts and the set of published ABI names.
 * - `isRegistryDocument(value)` narrows a parsed document to a `Layer`; `describeLayer(layer)` names
 *   one for diagnostics; `slimLayer(layer)` returns it with its ABI bodies emptied.
 * - `DEFAULT_MAX_DEPTH` is the default bound on layers held in one walk.
 *
 * Address history
 * - `chainAddressHistory(layers, chainId)` lists every address one chain published, with the names
 *   it went by and where, and where each name was tombstoned; `layers` run oldest to newest.
 * - `diffAddressHistories(a, b)` returns what `b` adds to, removes from and changes in `a`, sorted.
 *   It shows published addresses, not liveness or retirements (see its docstring).
 * - `flattenRetired(layers)` returns the retirements in force, chain id to lowercase address.
 *
 * Verification
 * - `verifyLayer(cid, bytes)` resolves when the bytes are what the CID addresses; it throws
 *   `LayerVerificationError` (carrying the `cid`) on a mismatch or a CID it does not verify.
 * - `layerFromBytes(cid, bytes)` verifies, then parses the bytes into a `Layer`.
 * - A pinned head vouches for every layer under it only if the head and each fetched layer go
 *   through `layerFromBytes`.
 *
 * Networks
 * - `NETWORKS` lists the registry's networks; `Network` is their union.
 */

export {
  DEFAULT_MAX_DEPTH,
  collectRegistryChain,
  describeLayer,
  flattenRegistryAbis,
  flattenRegistryChain,
  isAncestor,
  isRegistryDocument,
  slimLayer,
} from "./chain.ts";
export type { CollectOptions, CollectedChain, FetchLayer, IsAncestorOptions } from "./chain.ts";

export { chainAddressHistory, flattenRetired } from "./retirements.ts";
export type { AddressHistory, AddressRecord, RetiredByChain } from "./retirements.ts";

export { diffAddressHistories } from "./address-history.ts";
export type { AddressHistoryDiff, AddressSummary } from "./address-history.ts";

export { LayerVerificationError } from "./layer-verification-error.ts";
export { layerFromBytes, verifyLayer } from "./verify.ts";

export { NETWORKS } from "./types.ts";
export type {
  AccumulatedChain,
  AccumulatedState,
  ContractEntry,
  Layer,
  LayerChain,
  Network,
  RetiredEntry,
} from "./types.ts";
