import { test } from "node:test";
import assert from "node:assert/strict";

import { diffAddressHistories } from "../src/core/address-history.ts";
import { chainAddressHistory } from "../src/core/retirements.ts";
import { MAINNET_HEAD, OLD_MAINNET_HEAD, chain, contract, layer, realChain } from "./helpers.js";

function history(...layers) {
  return chainAddressHistory(layers, "1");
}

function at(contracts) {
  return layer({ chains: { 1: chain(contracts) } });
}

function emptyDiff() {
  return { added: [], removed: [], changed: [], tombstonesAdded: [], tombstonesRemoved: [] };
}

test("diffAddressHistories reports an address only the second history has as added", () => {
  const diff = diffAddressHistories(
    history(at({ hub: "0xaa" })),
    history(at({ hub: "0xaa", spoke: "0xbb" })),
  );

  assert.deepEqual(
    diff.added.map(({ address, contract }) => [address, contract]),
    [["0xbb", "spoke"]],
  );
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

test("diffAddressHistories reports an address only the first history has as removed", () => {
  const diff = diffAddressHistories(
    history(at({ hub: "0xaa", spoke: "0xbb" })),
    history(at({ hub: "0xaa" })),
  );

  assert.deepEqual(
    diff.removed.map(({ address, contract }) => [address, contract]),
    [["0xbb", "spoke"]],
  );
  assert.deepEqual(diff.added, []);
});

test("diffAddressHistories reports an address published under another name as changed", () => {
  const diff = diffAddressHistories(history(at({ hub: "0xaa" })), history(at({ hubV2: "0xaa" })));

  assert.equal(diff.changed.length, 1);
  const [change] = diff.changed;
  assert.equal(change.address, "0xaa");
  assert.equal(change.before.contract, "hub");
  assert.equal(change.after.contract, "hubV2");
});

test("diffAddressHistories reports an extra historical name as changed even when the last name is the same", () => {
  const a = history(at({ hub: "0xaa" }));
  const b = history(at({ oldHub: "0xaa" }), at({ hub: "0xaa" }));

  const diff = diffAddressHistories(a, b);

  assert.deepEqual(
    diff.changed.map(({ address }) => address),
    ["0xaa"],
  );
  assert.deepEqual([...diff.changed[0].after.names].sort(), ["hub", "oldHub"]);
});

test("diffAddressHistories reports the same names published in another order as changed", () => {
  const a = history(at({ hub: "0xaa" }), at({ hubV2: "0xaa" }));
  const b = history(at({ hubV2: "0xaa" }), at({ hub: "0xaa" }));

  const diff = diffAddressHistories(a, b);

  assert.deepEqual(
    diff.changed.map(({ address, before, after }) => [address, before.contract, after.contract]),
    [["0xaa", "hubV2", "hub"]],
  );
});

test("diffAddressHistories reports an address with a different earlier name as changed", () => {
  const a = history(at({ oldHub: "0xaa" }), at({ hub: "0xaa" }));
  const b = history(at({ priorHub: "0xaa" }), at({ hub: "0xaa" }));

  assert.deepEqual(
    diffAddressHistories(a, b).changed.map(({ address }) => address),
    ["0xaa"],
  );
});

test("diffAddressHistories reports an address that lost a historical name as changed", () => {
  const a = history(at({ oldHub: "0xaa" }), at({ hub: "0xaa" }));
  const b = history(at({ hub: "0xaa" }));

  assert.deepEqual(
    diffAddressHistories(a, b).changed.map(({ address }) => address),
    ["0xaa"],
  );
});

test("diffAddressHistories reports a different block number as changed", () => {
  const a = history(at({ hub: contract("0xaa", 100) }));
  const b = history(at({ hub: contract("0xaa", 250) }));

  const diff = diffAddressHistories(a, b);

  assert.deepEqual(
    diff.changed.map(({ address, before, after }) => [
      address,
      before.blockNumber,
      after.blockNumber,
    ]),
    [["0xaa", 100, 250]],
  );
});

test("diffAddressHistories does not report an address whose layer position differs between chains", () => {
  const a = history(at({ hub: "0xaa" }));
  const b = history(at({ other: "0xcc" }), at({ more: "0xdd" }), at({ hub: "0xaa" }));

  const diff = diffAddressHistories(a, b);

  assert.deepEqual(
    diff.added.map(({ address }) => address),
    ["0xcc", "0xdd"],
  );
  assert.deepEqual(diff.changed, [], "0xaa sits in layer 0 of one chain and 2 of the other");
});

test("diffAddressHistories compares addresses case-insensitively", () => {
  const diff = diffAddressHistories(history(at({ hub: "0xAbC" })), history(at({ hub: "0xaBc" })));

  assert.deepEqual(diff, emptyDiff());
});

test("diffAddressHistories reports names tombstoned on one side only", () => {
  const a = history(at({ guardian: "0xaa", root: "0xbb" }), at({ guardian: contract(null) }));
  const b = history(at({ guardian: "0xaa", root: "0xbb" }), at({ root: contract(null) }));

  const diff = diffAddressHistories(a, b);

  assert.deepEqual(diff.tombstonesAdded, ["root"]);
  assert.deepEqual(diff.tombstonesRemoved, ["guardian"]);
});

test("diffAddressHistories does not report a name tombstoned in both, however often", () => {
  const a = history(at({ guardian: "0xaa" }), at({ guardian: contract(null) }));
  const b = history(
    at({ guardian: "0xaa" }),
    at({ guardian: contract(null) }),
    at({ guardian: contract(null) }),
  );

  assert.deepEqual(diffAddressHistories(a, b), emptyDiff());
});

test("diffAddressHistories of a history with itself is empty", () => {
  const a = history(at({ hub: "0xaa", spoke: "0xbb" }), at({ hub: contract(null) }));

  assert.deepEqual(diffAddressHistories(a, a), emptyDiff());
});

test("diffAddressHistories sorts every list, whatever order the histories were built in", () => {
  const forward = history(at({ c: "0xcc", a: "0xaa", b: "0xbb" }));
  const reverse = history(at({ b: "0xbb", a: "0xaa", c: "0xcc" }));
  const empty = history(at({}));

  const fromForward = diffAddressHistories(empty, forward);
  const fromReverse = diffAddressHistories(empty, reverse);

  assert.deepEqual(
    fromForward.added.map(({ address }) => address),
    ["0xaa", "0xbb", "0xcc"],
  );
  assert.deepEqual(fromForward, fromReverse);
  assert.deepEqual(
    diffAddressHistories(forward, empty).removed.map(({ address }) => address),
    ["0xaa", "0xbb", "0xcc"],
  );
});

test("diffAddressHistories sorts tombstoned names", () => {
  const a = history(at({}));
  const b = history(at({ zed: contract(null), alpha: contract(null) }));

  assert.deepEqual(diffAddressHistories(a, b).tombstonesAdded, ["alpha", "zed"]);
});

test("diffAddressHistories sorts changed addresses, whatever order the second history publishes them", () => {
  const a = history(at({ one: "0xaa", two: "0xbb", three: "0xcc" }));
  const b = history(at({ threeV2: "0xcc", twoV2: "0xbb", oneV2: "0xaa" }));

  const diff = diffAddressHistories(a, b);

  assert.deepEqual(
    diff.changed.map(({ address }) => address),
    ["0xaa", "0xbb", "0xcc"],
  );
});

test("diffAddressHistories serialises with its names and without layer positions", () => {
  const a = history(at({}));
  const b = history(at({ oldHub: "0xaa" }), at({ hub: "0xaa" }));

  const serialised = JSON.parse(JSON.stringify(diffAddressHistories(a, b)));

  assert.deepEqual(serialised.added, [
    { address: "0xaa", contract: "hub", names: ["hub", "oldHub"], blockNumber: 100 },
  ]);
});

test("diffAddressHistories results share nothing with the histories they came from", () => {
  const a = history(at({ hub: "0xaa" }));
  const b = history(at({ hubV2: "0xaa", spoke: "0xbb" }));
  const before = structuredClone([a, b]);

  const diff = diffAddressHistories(a, b);
  diff.added[0].names.push("tampered");
  diff.added[0].contract = "tampered";
  diff.changed[0].after.names.push("tampered");
  diff.changed[0].before.contract = "tampered";

  assert.deepEqual([a, b], before);
});

test("diffAddressHistories leaves both inputs as they were", () => {
  const a = history(at({ hub: "0xaa" }), at({ guardian: contract(null) }));
  const b = history(at({ hubV2: "0xaa", spoke: "0xbb" }));
  const before = structuredClone([a, b]);

  diffAddressHistories(a, b);

  assert.deepEqual([a, b], before);
});

function realHistories(head, chainId) {
  const layers = realChain(head)
    .reverse()
    .map(({ bytes }) => JSON.parse(new TextDecoder().decode(bytes)));
  return chainAddressHistory(layers, chainId);
}

test("diffAddressHistories over the real mainnet chain and its older self lists the addresses published since", () => {
  // The two layers above the old head publish four contracts on chain 5042 and nothing on chain 1.
  const old = realHistories(OLD_MAINNET_HEAD, "5042");
  const head = realHistories(MAINNET_HEAD, "5042");

  const diff = diffAddressHistories(old, head);

  assert.equal(diff.added.length, 4);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(
    diff.added.map(({ address }) => address),
    diff.added.map(({ address }) => address).sort(),
  );
  assert.deepEqual(diffAddressHistories(old, head), diff);
  assert.deepEqual(diffAddressHistories(head, old).removed, diff.added);
});

test("diffAddressHistories finds nothing on chain 1 when the newer layers only re-publish a known address under an already tombstoned name", () => {
  const diff = diffAddressHistories(
    realHistories(OLD_MAINNET_HEAD, "1"),
    realHistories(MAINNET_HEAD, "1"),
  );

  assert.deepEqual(diff, emptyDiff());
});

test("diffAddressHistories reports a changed address between the real chain's first layer and its head", () => {
  const layers = realChain(MAINNET_HEAD)
    .reverse()
    .map(({ bytes }) => JSON.parse(new TextDecoder().decode(bytes)));

  const diff = diffAddressHistories(
    chainAddressHistory(layers.slice(0, 1), "8453"),
    chainAddressHistory(layers, "8453"),
  );

  assert.equal(diff.added.length, 55);
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.removed, []);
});
