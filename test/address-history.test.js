import { test } from "node:test";
import assert from "node:assert/strict";

import { diffAddressHistories } from "../src/core/address-history.ts";
import { chainAddressHistory } from "../src/core/retirements.ts";
import { chain, contract, layer } from "./helpers.js";

function history(...layers) {
  return chainAddressHistory(layers, "1");
}

function at(contracts) {
  return layer({ chains: { 1: chain(contracts) } });
}

function emptyDiff() {
  return { added: [], removed: [], changed: [], tombstonesAdded: [], tombstonesRemoved: [] };
}

const withSpoke = () => history(at({ hub: "0xaa", spoke: "0xbb" }));
const withoutSpoke = () => history(at({ hub: "0xaa" }));
const spoke = { address: "0xbb", contract: "spoke", names: ["spoke"], blockNumber: 100 };

test("diffAddressHistories reports an address only the second history has as added", () => {
  assert.deepEqual(diffAddressHistories(withoutSpoke(), withSpoke()), {
    ...emptyDiff(),
    added: [spoke],
  });
});

test("diffAddressHistories reports an address only the first history has as removed", () => {
  assert.deepEqual(diffAddressHistories(withSpoke(), withoutSpoke()), {
    ...emptyDiff(),
    removed: [spoke],
  });
});

const CHANGED = [
  ["published under another name", [at({ hub: "0xaa" })], [at({ hubV2: "0xaa" })]],
  [
    "with an extra historical name and the same last name",
    [at({ hub: "0xaa" })],
    [at({ oldHub: "0xaa" }), at({ hub: "0xaa" })],
  ],
  [
    "with the same names published in another order",
    [at({ hub: "0xaa" }), at({ hubV2: "0xaa" })],
    [at({ hubV2: "0xaa" }), at({ hub: "0xaa" })],
  ],
  [
    "with a different earlier name",
    [at({ oldHub: "0xaa" }), at({ hub: "0xaa" })],
    [at({ priorHub: "0xaa" }), at({ hub: "0xaa" })],
  ],
  [
    "that lost a historical name",
    [at({ oldHub: "0xaa" }), at({ hub: "0xaa" })],
    [at({ hub: "0xaa" })],
  ],
  [
    "with a different block number",
    [at({ hub: contract("0xaa", 100) })],
    [at({ hub: contract("0xaa", 250) })],
  ],
];

for (const [name, before, after] of CHANGED) {
  test(`diffAddressHistories reports an address ${name} as changed`, () => {
    const diff = diffAddressHistories(history(...before), history(...after));

    assert.deepEqual(
      diff.changed.map(({ address }) => address),
      ["0xaa"],
    );
    assert.deepEqual({ ...diff, changed: [] }, emptyDiff());
  });
}

const NO_DIFFERENCE = [
  ["addresses differing only in case", [at({ hub: "0xAbC" })], [at({ hub: "0xaBc" })]],
  [
    "a name tombstoned in both, however often",
    [at({ guardian: "0xaa" }), at({ guardian: contract(null) })],
    [at({ guardian: "0xaa" }), at({ guardian: contract(null) }), at({ guardian: contract(null) })],
  ],
  [
    "a tombstoned name re-published at a known address",
    [at({ hub: "0xaa" }), at({ hub: contract(null) })],
    [at({ hub: "0xaa" }), at({ hub: contract(null) }), at({ hub: "0xaa" })],
  ],
  [
    "a history and itself",
    [at({ hub: "0xaa", spoke: "0xbb" }), at({ hub: contract(null) })],
    [at({ hub: "0xaa", spoke: "0xbb" }), at({ hub: contract(null) })],
  ],
];

for (const [name, before, after] of NO_DIFFERENCE) {
  test(`diffAddressHistories finds no difference for ${name}`, () => {
    assert.deepEqual(diffAddressHistories(history(...before), history(...after)), emptyDiff());
  });
}

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

test("diffAddressHistories reports names tombstoned on one side only", () => {
  const a = history(at({ guardian: "0xaa", root: "0xbb" }), at({ guardian: contract(null) }));
  const b = history(at({ guardian: "0xaa", root: "0xbb" }), at({ root: contract(null) }));

  const diff = diffAddressHistories(a, b);

  assert.deepEqual(diff.tombstonesAdded, ["root"]);
  assert.deepEqual(diff.tombstonesRemoved, ["guardian"]);
});

test("diffAddressHistories sorts every list, whatever order the histories publish in", () => {
  const forward = history(
    at({ c: "0xcc", a: "0xaa", b: "0xbb", y: contract(null), x: contract(null) }),
  );
  const renamed = history(at({ cV2: "0xcc", bV2: "0xbb", aV2: "0xaa" }));
  const empty = history(at({}));
  const sorted = ["0xaa", "0xbb", "0xcc"];
  const addresses = (list) => list.map(({ address }) => address);

  assert.deepEqual(addresses(diffAddressHistories(empty, forward).added), sorted);
  assert.deepEqual(addresses(diffAddressHistories(forward, empty).removed), sorted);
  assert.deepEqual(addresses(diffAddressHistories(forward, renamed).changed), sorted);
  assert.deepEqual(diffAddressHistories(empty, forward).tombstonesAdded, ["x", "y"]);
  assert.deepEqual(diffAddressHistories(forward, empty).tombstonesRemoved, ["x", "y"]);
});

test("diffAddressHistories serialises both summaries with their names and without layer positions", () => {
  const a = history(at({ hub: contract("0xaa", 100) }));
  const b = history(at({ oldHub: contract("0xaa", 250) }), at({ hub: "0xaa", spoke: "0xbb" }));

  const serialised = JSON.parse(JSON.stringify(diffAddressHistories(a, b)));

  assert.deepEqual(serialised.added, [spoke]);
  assert.deepEqual(serialised.changed, [
    {
      address: "0xaa",
      before: { contract: "hub", names: ["hub"], blockNumber: 100 },
      after: { contract: "hub", names: ["hub", "oldHub"], blockNumber: 250 },
    },
  ]);
});

test("diffAddressHistories leaves its inputs alone and returns results that share nothing with them", () => {
  const a = history(at({ hub: "0xaa" }), at({ guardian: contract(null) }));
  const b = history(at({ hubV2: "0xaa", spoke: "0xbb" }));
  const before = structuredClone([a, b]);

  const diff = diffAddressHistories(a, b);
  assert.deepEqual([a, b], before);

  diff.added[0].names.push("tampered");
  diff.added[0].contract = "tampered";
  diff.changed[0].after.names.push("tampered");
  diff.changed[0].before.contract = "tampered";
  assert.deepEqual([a, b], before);
});
