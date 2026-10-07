import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chainAddressHistory,
  computeChainRetirements,
  declarationErrors,
  flattenRetired,
  openAddressesOutsideEnv,
} from "../src/core/retirements.ts";
import { chain, contract, layer } from "./helpers.js";

const A = "0xAaaa000000000000000000000000000000000001";
const B = "0xBbbb000000000000000000000000000000000002";
const C = "0xCccc000000000000000000000000000000000003";
const a = A.toLowerCase();
const b = B.toLowerCase();
const c = C.toLowerCase();

// A v3.2 release published hub and factory; v3.3 redeployed hub at a new address and did not touch
// the factory, so after the v3.3 REPLACE run env lists only the v3.3 hub.
const v32 = () =>
  layer({
    version: "v3.2.0",
    chains: { 1: chain({ hub: contract(A, 100), factory: contract(C, 110) }) },
  });
const v33 = (contracts = { hub: contract(B, 500) }) =>
  layer({ version: "v3.3.0", chains: { 1: chain(contracts) }, previousCid: "cid-v32" });

test("a declared release closes every address published at or before it that env no longer lists", () => {
  const { retired, errors, warnings } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900 } },
    envContracts: { hub: contract(B, 500) },
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(retired, {
    [a]: { contract: "hub", blockNumber: 100, endBlock: 900 },
    [c]: { contract: "factory", blockNumber: 110, endBlock: 900 },
  });
});

test("the superseded address under a reused name is closed, not the current one", () => {
  // `hub` names A in v3.2 and B in v3.3. Flattened by name, A is invisible; by address it is not.
  const { retired } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900 } },
    envContracts: { hub: contract(B, 500), factory: contract(C, 110) },
  });

  assert.deepEqual(Object.keys(retired), [a]);
});

test("an address env still lists is never closed, whatever release published it", () => {
  // Root is kept across releases: the REPLACE run re-registers it at the address it already has.
  const { retired, warnings } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900 } },
    envContracts: { hub: contract(A, 100), factory: contract(C, 110) },
  });

  assert.deepEqual(retired, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /closes nothing/);
});

test("an address a later release publishes again stays open", () => {
  const layers = [v32(), v33({ hub: contract(B, 500), factory: contract(C, 110) })];

  const { retired } = computeChainRetirements({
    chainId: "1",
    layers,
    declared: { "v3.2.0": { endBlock: 900 } },
    envContracts: { hub: contract(B, 500) },
  });

  assert.deepEqual(
    Object.keys(retired),
    [a],
    "factory was re-registered by v3.3, so it is current",
  );
});

test("addresses first published after the declared release are untouched", () => {
  const { retired } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900 } },
    envContracts: {},
  });

  assert.deepEqual(Object.keys(retired).sort(), [a, c]);
  assert.equal(retired[b], undefined);
});

test("a retirement already published is not emitted again", () => {
  const { retired, warnings, notes } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900 } },
    envContracts: { hub: contract(B, 500) },
    retiredSoFar: { [a]: { contract: "hub", endBlock: 900 } },
  });

  assert.deepEqual(Object.keys(retired), [c]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    notes,
    [],
    "something new was closed, so the declaration is not reported as merely in force",
  );
});

test("an address retired the old way, by tombstone, is left to the consumer", () => {
  // guardian was published in v3.0 and set to null in v3.1. There is no end block to give it, and
  // the consumer already handles the tombstone; a new entry would only state a wrong one.
  const layers = [
    layer({ version: "v3.0.0", chains: { 1: chain({ guardian: contract(A, 10) }) } }),
    layer({
      version: "v3.1.0",
      chains: { 1: chain({ guardian: contract(null), hub: contract(C, 50) }) },
      previousCid: "x",
    }),
  ];

  const { retired } = computeChainRetirements({
    chainId: "1",
    layers,
    declared: { "v3.1.0": { endBlock: 900 } },
    envContracts: {},
  });

  assert.deepEqual(Object.keys(retired), [c]);
});

test("a version no layer carries is an error that lists what was published", () => {
  const { retired, errors } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.4.0": { endBlock: 900 } },
    envContracts: {},
  });

  assert.deepEqual(retired, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no published layer carries version "v3.4.0"/);
  assert.match(errors[0], /v3\.2\.0, v3\.3\.0/);
});

test("an end block before an address's deploy block is an error", () => {
  const { retired, errors } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 105 } },
    envContracts: { hub: contract(B, 500) },
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /endBlock 105 precedes factory/);
  assert.deepEqual(Object.keys(retired), [a], "the address it does not precede is still closed");
});

test("an end block that is not a positive integer is an error", () => {
  for (const endBlock of [0, -1, 1.5, "900", null, undefined]) {
    const { errors } = computeChainRetirements({
      chainId: "1",
      layers: [v32()],
      declared: { "v3.2.0": { endBlock } },
      envContracts: {},
    });
    assert.equal(errors.length, 1, `endBlock ${JSON.stringify(endBlock)}`);
    assert.match(errors[0], /must be a positive integer/);
  }
});

test("no declarations means nothing to do", () => {
  const result = computeChainRetirements({
    chainId: "1",
    layers: [v32()],
    declared: undefined,
    envContracts: {},
  });
  assert.deepEqual(result, { retired: {}, errors: [], warnings: [], notes: [] });
});

test("a version declaration can except contracts by name or by address", () => {
  // The v3.2 spoke must stay open while share tokens discovered through it carry over; Root is
  // excepted by address for the same reason, although env would keep it anyway.
  const layers = [v32(), v33()];

  const { retired, errors } = computeChainRetirements({
    chainId: "1",
    layers,
    declared: { "v3.2.0": { endBlock: 900, except: ["hub", C] } },
    envContracts: {},
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(retired, {}, "hub by name and factory by address are both excepted");
});

test("an except entry that matches nothing is an error, not a silent no-op", () => {
  // A typo in `except` would otherwise close exactly what it meant to protect.
  const { errors } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900, except: ["spokee"] } },
    envContracts: { hub: contract(B, 500) },
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /except: "spokee" matches no contract name or address/);
});

test("an address declaration closes exactly that address", () => {
  const { retired, errors, warnings } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { [C]: { endBlock: 950, reason: "permissionless old factory, abused" } },
    envContracts: { hub: contract(B, 500) },
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(retired, { [c]: { contract: "factory", blockNumber: 110, endBlock: 950 } });
});

test("an address declaration is refused for an unpublished address, a live one, or one with except", () => {
  const base = { chainId: "1", layers: [v32(), v33()], envContracts: { hub: contract(B, 500) } };

  const unpublished = computeChainRetirements({
    ...base,
    declared: { "0x9999000000000000000000000000000000000009": { endBlock: 900 } },
  });
  assert.match(unpublished.errors[0], /no published layer carries this address/);

  const live = computeChainRetirements({ ...base, declared: { [B]: { endBlock: 900 } } });
  assert.match(live.errors[0], /env still lists this address as live \(hub\)/);

  const withExcept = computeChainRetirements({
    ...base,
    declared: { [C]: { endBlock: 900, except: ["x"] } },
  });
  assert.match(withExcept.errors[0], /only a version declaration takes "except"/);
});

test("an address declaration overrides what a version declaration would close", () => {
  const { retired, errors } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900 }, [C]: { endBlock: 1200 } },
    envContracts: { hub: contract(B, 500) },
  });

  assert.deepEqual(errors, []);
  assert.equal(retired[a].endBlock, 900);
  assert.equal(retired[c].endBlock, 1200, "the explicit end block wins for that address");
});

test("declarations are a ledger: one in force is noted, not warned about, and a changed end block is a correction", () => {
  const base = { chainId: "1", layers: [v32(), v33()], envContracts: { hub: contract(B, 500) } };
  const published = {
    [a]: { contract: "hub", endBlock: 900 },
    [c]: { contract: "factory", endBlock: 900 },
  };

  const same = computeChainRetirements({
    ...base,
    declared: { "v3.2.0": { endBlock: 900 } },
    retiredSoFar: published,
  });
  assert.deepEqual(
    same.retired,
    {},
    "nothing to emit when every address is published with this end block",
  );
  assert.deepEqual(same.warnings, [], "a kept declaration must stay quiet on every later publish");
  assert.equal(same.notes.length, 1);
  assert.match(same.notes[0], /in force, 2 address\(es\) already published with end block 900/);

  const corrected = computeChainRetirements({
    ...base,
    declared: { "v3.2.0": { endBlock: 950 } },
    retiredSoFar: published,
  });
  assert.deepEqual(Object.keys(corrected.retired).sort(), [a, c]);
  assert.equal(corrected.retired[a].endBlock, 950);

  const sameAddress = computeChainRetirements({
    ...base,
    declared: { [C]: { endBlock: 900 } },
    retiredSoFar: published,
  });
  assert.deepEqual(sameAddress.retired, {});
  assert.match(sameAddress.notes[0], /in force, published with end block 900/);
});

test("a version declaration that matches nothing at all is still a warning", () => {
  const { warnings, notes } = computeChainRetirements({
    chainId: "1",
    layers: [v32(), v33()],
    declared: { "v3.2.0": { endBlock: 900 } },
    envContracts: { hub: contract(A, 100), factory: contract(C, 110) },
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual(notes, []);
});

test("declarationErrors checks the shape of one declaration, not its meaning", () => {
  assert.deepEqual(
    declarationErrors("v3.2.0", { endBlock: 900, except: ["spoke"], reason: "done" }, "ethereum"),
    [],
  );
  assert.deepEqual(declarationErrors(A, { endBlock: 900 }), []);

  const [badKey] = declarationErrors("v3.1-rev2", { endBlock: 900 });
  assert.match(
    badKey,
    /key must be a published registry version like "v3\.2\.0" or a 20-byte hex address/,
  );

  const [notObject] = declarationErrors("v3.2.0", 900, "base");
  assert.match(notObject, /"base\.v3\.2\.0" must be an object with "endBlock"/);

  const errors = declarationErrors(A, { endBlock: 0, except: ["x"], reason: 1, bogus: true });
  assert.equal(errors.length, 4, errors.join("\n"));
  assert.ok(errors.some((e) => /\.bogus": unknown key, expected "endBlock" or "reason"/.test(e)));
  assert.ok(
    errors.some((e) => /\.except": unknown key/.test(e)),
    "an address declaration takes no except",
  );
  assert.ok(errors.some((e) => /endBlock" must be a positive integer/.test(e)));
  assert.ok(errors.some((e) => /reason" must be a string/.test(e)));
});

test("chainAddressHistory keys by lowercase address, keeps every name, and records where a name was tombstoned", () => {
  const layers = [
    layer({ version: "v1", chains: { 1: chain({ hub: contract(A, 100) }) } }),
    layer({
      version: "v2",
      chains: {
        1: chain({
          hub: contract(null),
          spoke: contract(A.toUpperCase().replace("0X", "0x"), 100),
        }),
      },
      previousCid: "x",
    }),
  ];

  const { addresses, tombstones } = chainAddressHistory(layers, "1");

  assert.deepEqual([...addresses.keys()], [a]);
  assert.deepEqual(addresses.get(a), {
    contract: "spoke",
    names: new Set(["hub", "spoke"]),
    blockNumber: 100,
    firstLayer: 0,
    lastLayer: 1,
  });
  assert.deepEqual(tombstones.get("hub"), [1]);
});

test("flattenRetired lets the newest layer win per address and lowercases keys", () => {
  const layers = [
    layer({
      version: "v1",
      chains: { 1: chain({}, { retired: { [A]: { contract: "hub", endBlock: 900 } } }) },
    }),
    layer({
      version: "v2",
      chains: {
        1: chain({}, { retired: { [a]: { contract: "hub", endBlock: 950 } } }),
        2: chain({}, { retired: { [b]: { contract: "spoke", endBlock: 10 } } }),
      },
      previousCid: "x",
    }),
  ];

  assert.deepEqual(flattenRetired(layers), {
    1: { [a]: { contract: "hub", endBlock: 950 } },
    2: { [b]: { contract: "spoke", endBlock: 10 } },
  });
});

test("openAddressesOutsideEnv reports what a snapshot built from env alone would drop", () => {
  const open = openAddressesOutsideEnv({
    chainId: "1",
    layers: [v32(), v33()],
    envContracts: { hub: contract(B, 500) },
    retiredSoFar: { [c]: { contract: "factory", endBlock: 900 } },
  });

  assert.deepEqual(open, [{ address: a, contract: "hub", blockNumber: 100 }]);
});
