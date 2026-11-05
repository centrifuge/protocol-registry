/**
 * Comparing the address histories of two registry chains.
 *
 * A history (see `chainAddressHistory` in ./retirements.ts) records every address a chain ever
 * published, which is what an address book is built from. The diff says which addresses a consumer
 * holding the first history would be missing, no longer need, or hold under other names.
 */

import type { AddressHistory, AddressRecord } from "./retirements.ts";

/** What a history says about one address, as plain data that serialises. */
export type AddressSummary = {
  /** The name it was last published under. */
  contract: string;
  /** Every name it was published under, ascending. */
  names: string[];
  /** The deploy block of the first entry that carried one, or null. */
  blockNumber: number | null;
};

export interface AddressHistoryDiff {
  /** Addresses only the second history has, by ascending address. */
  added: ({ address: string } & AddressSummary)[];
  /** Addresses only the first history has, by ascending address. */
  removed: ({ address: string } & AddressSummary)[];
  /** Addresses in both whose contract name, name set or block number differ, by ascending address. */
  changed: { address: string; before: AddressSummary; after: AddressSummary }[];
  /** Names tombstoned in the second history only, ascending. */
  tombstonesAdded: string[];
  /** Names tombstoned in the first history only, ascending. */
  tombstonesRemoved: string[];
}

/**
 * Compares two address histories of one chain, address by lowercase address.
 *
 * A history records what was ever published, not what is live. The diff covers the addresses an
 * indexer listens to; it does not show a name entering or leaving the current set at an address
 * already in the history (a tombstoned name re-published at a known address gives no difference),
 * nor retirements (see `flattenRetired`). Layer positions belong to two different registry chains,
 * so they never count as a difference and are not reported. A tombstone counts by name, not by how
 * many layers carry it.
 *
 * @param a - The history to compare from
 * @param b - The history to compare to
 * @returns What `b` adds to, removes from and changes in `a`, as plain data sharing nothing with
 *   the inputs, every list sorted so the result is the same however the histories were built
 */
export function diffAddressHistories(a: AddressHistory, b: AddressHistory): AddressHistoryDiff {
  const added: AddressHistoryDiff["added"] = [];
  const removed: AddressHistoryDiff["removed"] = [];
  const changed: AddressHistoryDiff["changed"] = [];

  for (const [address, after] of b.addresses) {
    const before = a.addresses.get(address);
    if (!before) added.push({ address, ...summarize(after) });
    else if (differ(before, after)) {
      changed.push({ address, before: summarize(before), after: summarize(after) });
    }
  }
  for (const [address, record] of a.addresses) {
    if (!b.addresses.has(address)) removed.push({ address, ...summarize(record) });
  }

  return {
    added: added.sort(byAddress),
    removed: removed.sort(byAddress),
    changed: changed.sort(byAddress),
    tombstonesAdded: namesMissingFrom(a.tombstones, b.tombstones),
    tombstonesRemoved: namesMissingFrom(b.tombstones, a.tombstones),
  };
}

function summarize(record: AddressRecord): AddressSummary {
  return {
    contract: record.contract,
    names: [...record.names].sort(),
    blockNumber: record.blockNumber,
  };
}

function differ(before: AddressRecord, after: AddressRecord): boolean {
  return (
    before.contract !== after.contract ||
    before.blockNumber !== after.blockNumber ||
    before.names.size !== after.names.size ||
    [...after.names].some((name) => !before.names.has(name))
  );
}

function byAddress(left: { address: string }, right: { address: string }): number {
  // Code-unit order, not localeCompare: the result must not depend on the runtime's locale.
  if (left.address < right.address) return -1;
  return left.address > right.address ? 1 : 0;
}

function namesMissingFrom(from: Map<string, number[]>, to: Map<string, number[]>): string[] {
  return [...to.keys()].filter((name) => !from.has(name)).sort();
}
