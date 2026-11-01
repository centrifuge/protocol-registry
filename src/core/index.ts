/**
 * The public surface of the registry's core: reading a published layer chain, proving a layer is
 * the one its CID names, and comparing what chains published. Nothing here does I/O itself: chain
 * walks reach layers only through the caller's `fetchLayer`, and nothing reads the network, a file
 * or an environment.
 *
 * Exports: chain walking (`collectRegistryChain`, `isAncestor`, `flattenRegistryChain`,
 * `flattenRegistryAbis`, `isRegistryDocument`, `describeLayer`, `slimLayer`, `DEFAULT_MAX_DEPTH`),
 * address history (`chainAddressHistory`, `diffAddressHistories`, `flattenRetired`), verification
 * (`verifyLayer`, `layerFromBytes`, `LayerVerificationError`) and `NETWORKS`, with their types.
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
