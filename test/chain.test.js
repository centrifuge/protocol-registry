import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectRegistryChain,
  flattenRegistryAbis,
  flattenRegistryChain,
  isAncestor,
  slimLayer,
  summarizeAccumulatedState,
} from "../src/core/chain.ts";
import { LayerVerificationError } from "../src/core/layer-verification-error.ts";
import { layerFromBytes } from "../src/core/verify.ts";
import {
  MAINNET_HEAD,
  MAINNET_HEAD_PARENT,
  OLD_MAINNET_HEAD,
  chain,
  contract,
  fakeFetch,
  flipByte,
  ipfsFetcher,
  layer,
  realLayerBytes,
  realLayerCids,
} from "./helpers.js";

test("flattenRegistryChain lets the newest layer win", () => {
  const accumulated = flattenRegistryChain([
    layer({ version: "v1", chains: { 1: chain({ hub: "0xold" }) } }),
    layer({ version: "v2", chains: { 1: chain({ hub: "0xnew" }) } }),
  ]);

  assert.equal(accumulated["1"].contracts.hub.address, "0xnew");
});

test("flattenRegistryChain accumulates contracts across layers that touch different chains", () => {
  const accumulated = flattenRegistryChain([
    layer({ chains: { 1: chain({ hub: "0xhub", spoke: "0xspoke" }) } }),
    layer({ chains: { 8453: chain({ hub: "0xbase" }) } }),
    layer({ chains: { 1: chain({ vault: "0xvault" }) } }),
  ]);

  // The bug this guards: a later layer touching only chain 1 must not erase chain 8453, and must
  // not erase chain 1's other contracts either.
  assert.deepEqual(Object.keys(accumulated).sort(), ["1", "8453"]);
  assert.deepEqual(Object.keys(accumulated["1"].contracts).sort(), ["hub", "spoke", "vault"]);
  assert.equal(summarizeAccumulatedState(accumulated).contracts, 4);
});

test("flattenRegistryChain lets a later tombstone shadow a live entry", () => {
  const accumulated = flattenRegistryChain([
    layer({ chains: { 1: chain({ guardian: "0xguardian" }) } }),
    layer({ chains: { 1: chain({ guardian: contract(null) }) } }),
  ]);

  assert.equal(accumulated["1"].contracts.guardian.address, null);
});

test("flattenRegistryChain resolves a contract re-added after a tombstone", () => {
  const accumulated = flattenRegistryChain([
    layer({ chains: { 1: chain({ oracleValuation: "0xv1" }) } }),
    layer({ chains: { 1: chain({ oracleValuation: contract(null) }) } }),
    layer({ chains: { 1: chain({ oracleValuation: "0xv2" }) } }),
  ]);

  assert.equal(accumulated["1"].contracts.oracleValuation.address, "0xv2");
});

test("flattenRegistryChain merges null-version patch layers like any other layer", () => {
  const accumulated = flattenRegistryChain([
    layer({ version: "v1", chains: { 1: chain({ hub: "0xhub" }) } }),
    layer({ version: null, chains: { 1: chain({ spoke: "0xspoke" }) } }),
  ]);

  assert.deepEqual(Object.keys(accumulated["1"].contracts).sort(), ["hub", "spoke"]);
});

test("flattenRegistryChain merges retired maps per address, newest layer winning, keyed by lowercase address", () => {
  const flattened = flattenRegistryChain([
    layer({
      version: "v1",
      chains: {
        1: chain({ hub: "0xhub" }, { retired: { "0xAAAA": { contract: "old", endBlock: 10 } } }),
      },
    }),
    layer({
      version: "v2",
      chains: {
        1: chain(
          {},
          {
            retired: {
              "0xaaaa": { contract: "old", endBlock: 20 },
              "0xBBBB": { contract: "older", endBlock: 5 },
            },
          },
        ),
      },
    }),
  ]);

  assert.deepEqual(flattened["1"].retired, {
    "0xaaaa": { contract: "old", endBlock: 20 },
    "0xbbbb": { contract: "older", endBlock: 5 },
  });
  assert.deepEqual(
    Object.keys(flattened["1"].contracts),
    ["hub"],
    "contracts are untouched by retired",
  );
});

test("flattenRegistryChain keeps the newest network and adapter metadata", () => {
  const accumulated = flattenRegistryChain([
    layer({
      chains: {
        1: chain(
          { hub: "0xhub" },
          { network: { chainId: 1, centrifugeId: 1 }, adapters: { axelar: {} } },
        ),
      },
    }),
    layer({
      chains: { 1: chain({ hub: "0xhub2" }, { network: { chainId: 1, centrifugeId: 99 } }) },
    }),
  ]);

  assert.equal(accumulated["1"].network.centrifugeId, 99);
  // A layer that does not restate adapters must not drop them.
  assert.deepEqual(accumulated["1"].adapters, { axelar: {} });
});

test("collectRegistryChain walks to the base snapshot and returns layers oldest to newest", async () => {
  const base = layer({ version: "v1", chains: { 1: chain({ hub: "0xhub" }) } });
  const middle = layer({
    version: "v2",
    chains: { 1: chain({ spoke: "0xspoke" }) },
    previousCid: "cidBase",
  });
  const tip = layer({
    version: "v3",
    chains: { 1: chain({ vault: "0xvault" }) },
    previousCid: "cidMiddle",
  });
  const { fetchImpl } = fakeFetch({ cidBase: base, cidMiddle: middle });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.equal(result.complete, true);
  assert.equal(result.reason, null);
  assert.deepEqual(
    result.layers.map((l) => l.version),
    ["v1", "v2", "v3"],
  );
});

test("collectRegistryChain reports a cycle instead of looping forever", async () => {
  const looping = layer({ version: "v2", chains: {}, previousCid: "cidLoop" });
  const { fetchImpl } = fakeFetch({ cidLoop: looping });
  const tip = layer({ version: "v3", chains: {}, previousCid: "cidLoop" });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.equal(result.complete, false);
  assert.match(result.reason, /cycle detected/);
});

test("collectRegistryChain reports a previousRegistry with no ipfsHash", async () => {
  const tip = layer({ version: "v2", chains: {}, previousRegistry: { version: "v1" } });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher() });

  assert.equal(result.complete, false);
  assert.match(result.reason, /no previousRegistry\.ipfsHash/);
});

test("collectRegistryChain reports an unfetchable layer with the gateway failures", async () => {
  const { fetchImpl } = fakeFetch({});
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidMissing" });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.equal(result.complete, false);
  assert.match(result.reason, /could not fetch cidMissing/);
  assert.match(result.reason, /404/);
});

test("collectRegistryChain stops when a layer points at something that is not a CID", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const tip = layer({ version: "v2", chains: {}, previousCid: "../../etc/passwd" });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.equal(result.complete, false);
  assert.match(result.reason, /is not a plain CID/);
  assert.equal(calls.length, 0);
});

test("collectRegistryChain stops at maxDepth rather than walking indefinitely", async () => {
  // Every layer points at the next distinct CID, so only the depth guard can stop the walk.
  const documents = {};
  for (let i = 0; i < 10; i++) {
    documents[`cid${i}`] = layer({ version: `v${i}`, chains: {}, previousCid: `cid${i + 1}` });
  }
  const { fetchImpl } = fakeFetch(documents);
  const tip = layer({ version: "tip", chains: {}, previousCid: "cid0" });

  const result = await collectRegistryChain(tip, {
    maxDepth: 3,
    fetchLayer: ipfsFetcher(fetchImpl),
  });

  assert.equal(result.complete, false);
  assert.match(result.reason, /longer than maxDepth 3/);
  // maxDepth bounds how many layers are held, tip included.
  assert.equal(result.layers.length, 3);
});

test("collectRegistryChain completes when the base snapshot is the maxDepth'th layer", async () => {
  // The terminal check must run before the depth bound. Otherwise a chain of exactly maxDepth
  // layers is fetched in full, the base is in hand, and the walk still reports "chain longer
  // than maxDepth" — which would make setting the bound to the observed chain length fail.
  const base = layer({ version: "v1", chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl } = fakeFetch({ cidBase: base });
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidBase" });

  const result = await collectRegistryChain(tip, {
    maxDepth: 2,
    fetchLayer: ipfsFetcher(fetchImpl),
  });

  assert.equal(result.complete, true);
  assert.equal(result.reason, null);
  assert.equal(result.layers.length, 2);
});

test("collectRegistryChain survives a failing gateway by falling through to the next", async () => {
  const base = layer({ version: "v1", chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl, calls } = fakeFetch({ cidBase: base }, { failGateways: ["centrifuge-files"] });
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidBase" });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.equal(result.complete, true);
  assert.equal(result.layers.length, 2);
  assert.ok(
    calls.some((url) => url.includes("centrifuge-files")),
    "first gateway was tried",
  );
  assert.ok(calls.length > 1, "fell through to a second gateway");
});

test("collectRegistryChain returns the accumulated state alongside the layers", async () => {
  // Callers take `accumulated` rather than ordering layers themselves: flattenRegistryChain
  // requires oldest → newest and silently returns stale winners if handed the reverse.
  const base = layer({
    version: "v1",
    chains: { 1: chain({ hub: "0xold", guardian: "0xguardian" }) },
  });
  const { fetchImpl } = fakeFetch({ cidBase: base });
  const tip = layer({
    version: "v2",
    chains: { 1: chain({ hub: "0xnew", guardian: contract(null) }) },
    previousCid: "cidBase",
  });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.deepEqual(result.accumulated, flattenRegistryChain(result.layers));
  assert.equal(result.accumulated["1"].contracts.hub.address, "0xnew");
  assert.equal(result.accumulated["1"].contracts.guardian.address, null);
});

test("collectRegistryChain refuses a tip from the wrong network", async () => {
  // A mistyped source CID pointing at the other environment would otherwise flatten that
  // environment's contracts into this delta, and pass every downstream check — the delta
  // invariants included, since they compare against this same accumulated state.
  const { fetchImpl } = fakeFetch({});
  const tip = layer({ version: "v2", network: "testnet", chains: { 1: chain({ hub: "0xhub" }) } });

  const result = await collectRegistryChain(tip, {
    expectedNetwork: "mainnet",
    fetchLayer: ipfsFetcher(fetchImpl),
  });

  assert.equal(result.complete, false);
  assert.match(result.reason, /declares network "testnet".*"mainnet" is being generated/);
  // fatal, so allowPartialChain cannot wave it through, and the state is empty so
  // even a caller that ignored the flag cannot compare against the wrong environment.
  assert.equal(result.fatal, true);
  assert.deepEqual(result.accumulated, {});
  assert.deepEqual(result.layers, []);
});

test("collectRegistryChain refuses a mid-chain layer from the wrong network", async () => {
  const foreign = layer({
    version: "v1",
    network: "testnet",
    chains: { 1: chain({ hub: "0xforeign" }) },
  });
  const { fetchImpl } = fakeFetch({ cidBase: foreign });
  const tip = layer({
    version: "v2",
    chains: { 1: chain({ vault: "0xvault" }) },
    previousCid: "cidBase",
  });

  const result = await collectRegistryChain(tip, {
    expectedNetwork: "mainnet",
    fetchLayer: ipfsFetcher(fetchImpl),
  });

  assert.equal(result.complete, false);
  assert.match(result.reason, /declares network "testnet"/);
  assert.equal(result.fatal, true);
  // The foreign layer must not reach the accumulated state even though the walk already had it.
  assert.deepEqual(result.accumulated, {});
});

const UNDECLARED_NETWORK = [
  ["a tip that declares no network", () => [layer({ network: null }), {}]],
  [
    "a mid-chain layer that declares no network",
    () => [layer({ previousCid: "cidBase" }), { cidBase: layer({ network: null }) }],
  ],
  ["a layer whose network is not a string", () => [layer({ network: 1 }), {}]],
];

for (const [name, build] of UNDECLARED_NETWORK) {
  test(`collectRegistryChain refuses ${name} when one is expected`, async () => {
    const [tip, cidMap] = build();

    const result = await collectRegistryChain(tip, {
      expectedNetwork: "mainnet",
      fetchLayer: ipfsFetcher(fakeFetch(cidMap).fetchImpl),
    });

    assert.match(result.reason, /declares no network.*"mainnet" is being generated/);
    assert.equal(result.fatal, true);
    assert.equal(result.complete, false);
    assert.deepEqual(result.layers, []);
    assert.deepEqual(result.accumulated, {});
  });
}

test("collectRegistryChain accepts layers without a network when none is expected", async () => {
  const base = layer({ version: "v1", network: null, chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl } = fakeFetch({ cidBase: base });
  const tip = layer({ version: "v2", network: null, chains: {}, previousCid: "cidBase" });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.equal(result.complete, true);
  assert.equal(result.reason, null);
  assert.equal(result.accumulated["1"].contracts.hub.address, "0xhub");
});

test("collectRegistryChain refuses a tip that is not a registry document", async () => {
  // The tip arrives from the caller, not through the layer fetch,
  // so it needs its own check. Accepting it would flatten to an empty accumulated state and
  // make every published contract look new.
  const result = await collectRegistryChain(
    { detail: "cloudflare error page" },
    {
      fetchLayer: ipfsFetcher(),
    },
  );

  assert.equal(result.complete, false);
  assert.match(result.reason, /tip document is not a registry/);
  // Fatal for the same reason a network mismatch is: not incomplete but invalid, so no
  // "proceed anyway" override may apply.
  assert.equal(result.fatal, true);
  assert.deepEqual(result.layers, []);
  assert.deepEqual(result.accumulated, {});
});

test("collectRegistryChain returns ABI coverage alongside the accumulated state", async () => {
  // Callers need coverage from the same call that gives them contracts: comparing the two is how
  // an ABI the chain never carried is detected (see src/core/delta.ts).
  const base = {
    network: "mainnet",
    version: "v1",
    chains: { 1: chain({ hub: "0xhub" }) },
    abis: { Hub: [] },
    previousRegistry: null,
  };
  const { fetchImpl } = fakeFetch({ cidBase: base });
  const tip = {
    network: "mainnet",
    version: "v2",
    chains: { 1: chain({ spoke: "0xspoke" }) },
    abis: { Spoke: [] },
    previousRegistry: { version: "v1", ipfsHash: "cidBase" },
  };

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.deepEqual([...result.accumulatedAbis].sort(), ["Hub", "Spoke"]);
});

test("collectRegistryChain returns empty ABI coverage when the chain is rejected", async () => {
  const tip = layer({ version: "v2", network: "testnet", chains: { 1: chain({ hub: "0xhub" }) } });

  const result = await collectRegistryChain(tip, {
    expectedNetwork: "mainnet",
    fetchLayer: ipfsFetcher(),
  });

  assert.equal(result.fatal, true);
  assert.deepEqual([...result.accumulatedAbis], []);
});

test("flattenRegistryAbis collects every ABI name published across the chain", () => {
  const layers = [
    { chains: {}, abis: { Root: [], Gateway: [] } },
    { chains: {}, abis: { Gateway: [], Spoke: [] } },
  ];

  const names = flattenRegistryAbis(layers);

  assert.deepEqual([...names].sort(), ["Gateway", "Root", "Spoke"]);
  // A layer that ships no ABIs must not erase coverage from earlier layers.
  assert.deepEqual([...flattenRegistryAbis([...layers, { chains: {} }])].sort(), [
    "Gateway",
    "Root",
    "Spoke",
  ]);
});

/**
 * A fetchLayer over the real layers that verifies each against its CID, as a consumer's does, and
 * records what it fetched. `tampered` is served with one byte flipped.
 */
function realFetcher({ tampered = null } = {}) {
  const known = new Set(realLayerCids());
  const fetched = [];
  const fetchLayer = async (cid) => {
    fetched.push(cid);
    if (!known.has(cid)) throw new Error(`could not fetch ${cid}`);
    const bytes = realLayerBytes(cid);
    return layerFromBytes(cid, cid === tampered ? flipByte(bytes, 10) : bytes);
  };
  return { fetchLayer, fetched };
}

/** A fetchLayer over a complete synthetic chain, cidTip -> cidMid -> cidBase, recording what it fetched. */
function syntheticFetcher() {
  const layers = {
    cidTip: layer({ previousCid: "cidMid" }),
    cidMid: layer({ previousCid: "cidBase" }),
    cidBase: layer({}),
  };
  const fetched = [];
  const fetchLayer = async (cid) => {
    fetched.push(cid);
    if (!layers[cid]) throw new Error(`could not fetch ${cid}`);
    return structuredClone(layers[cid]);
  };
  return { fetchLayer, fetched };
}

test("collectRegistryChain with stopAt stops before fetching the layer it names, keeping the layers above", async () => {
  const { fetchLayer, fetched } = realFetcher();
  const tip = await fetchLayer(MAINNET_HEAD);

  const result = await collectRegistryChain(tip, {
    fetchLayer,
    stopAt: new Set([OLD_MAINNET_HEAD]),
  });

  assert.deepEqual(fetched, [MAINNET_HEAD, MAINNET_HEAD_PARENT]);
  const above = [await fetchLayer(MAINNET_HEAD_PARENT), tip];
  assert.deepEqual(result, {
    layers: above,
    accumulated: flattenRegistryChain(above),
    accumulatedAbis: flattenRegistryAbis(above),
    complete: false,
    stoppedAt: OLD_MAINNET_HEAD,
    reason: null,
    fatal: false,
  });
});

const STOPS_NOT_REACHED = [
  ["is absent", undefined],
  ["names only the tip's own CID", "cidTip"],
  ["is not in the chain", "cidElsewhere"],
];

for (const [name, stop] of STOPS_NOT_REACHED) {
  test(`collectRegistryChain walks to the base and reports no stop when stopAt ${name}`, async () => {
    const { fetchLayer, fetched } = syntheticFetcher();

    const result = await collectRegistryChain(await fetchLayer("cidTip"), {
      fetchLayer,
      stopAt: stop && new Set([stop]),
    });

    assert.equal(result.stoppedAt, null);
    assert.equal(result.complete, true);
    assert.deepEqual(fetched, ["cidTip", "cidMid", "cidBase"]);
  });
}

test("collectRegistryChain stops at stopAt even when the layer below the tip is the stop", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const tip = layer({ chains: { 1: chain({ vault: "0xvault" }) }, previousCid: "cidBase" });

  const result = await collectRegistryChain(tip, {
    fetchLayer: ipfsFetcher(fetchImpl),
    stopAt: new Set(["cidBase"]),
  });

  assert.equal(calls.length, 0);
  assert.equal(result.stoppedAt, "cidBase");
  assert.deepEqual(Object.keys(result.accumulated["1"].contracts), ["vault"]);
});

test("collectRegistryChain reports no stop when the walk fails before reaching it", async () => {
  const tip = layer({ chains: {}, previousCid: "cidMissing" });

  const result = await collectRegistryChain(tip, {
    fetchLayer: ipfsFetcher(),
    stopAt: new Set(["cidFar"]),
  });

  assert.equal(result.stoppedAt, null);
  assert.equal(result.complete, false);
  assert.match(result.reason, /could not fetch cidMissing/);
});

const FETCH_REJECTIONS = [
  ["a LayerVerificationError", () => new LayerVerificationError("cidBad", "tampered"), true],
  [
    "a verification error from another copy of the package",
    () => Object.assign(new Error("x"), { name: "LayerVerificationError" }),
    true,
  ],
  ["an ordinary fetch failure", () => new Error("gateway down"), false],
  [
    "a plain error named like another class",
    () => Object.assign(new Error("x"), { name: "TypeError" }),
    false,
  ],
];

for (const [name, makeError, fatal] of FETCH_REJECTIONS) {
  test(`collectRegistryChain makes ${name} from fetchLayer ${fatal ? "fatal" : "non-fatal"}`, async () => {
    const error = makeError();
    const tip = layer({ chains: { 1: chain({ hub: "0xhub" }) }, previousCid: "cidBad" });

    const result = await collectRegistryChain(tip, {
      fetchLayer: async () => {
        throw error;
      },
    });

    assert.equal(result.fatal, fatal);
    assert.equal(result.reason, error.message);
    assert.equal(result.complete, false);
    if (fatal) {
      assert.deepEqual(result.layers, []);
      assert.deepEqual(result.accumulated, {});
    }
  });
}

test("slimLayer keeps which ABIs a layer carries and drops their bodies", () => {
  const full = { chains: {}, abis: { Hub: [{ type: "function", name: "x" }], Spoke: [] } };

  assert.deepEqual(slimLayer(full).abis, { Hub: [], Spoke: [] });
  assert.equal(full.abis.Hub.length, 1, "the input is not modified");
});

const FETCHERS = { real: realFetcher, synthetic: syntheticFetcher };

const ANSWERS = [
  ["true for a layer two steps below the head", "real", MAINNET_HEAD, OLD_MAINNET_HEAD, true, 2],
  ["true for the head itself, without fetching", "real", MAINNET_HEAD, MAINNET_HEAD, true, 0],
  ["true at the maxDepth bound", "real", MAINNET_HEAD, OLD_MAINNET_HEAD, true, 2, { maxDepth: 2 }],
  ["true for the base snapshot", "synthetic", "cidTip", "cidBase", true, 2],
  ["false for a CID the chain never reaches", "synthetic", "cidTip", "cidElsewhere", false, 3],
  ["false for a head's descendant", "synthetic", "cidMid", "cidTip", false, 2],
];

for (const [name, kind, head, ancestor, expected, fetches, options] of ANSWERS) {
  test(`isAncestor is ${name}, never fetching the ancestor`, async () => {
    const { fetchLayer, fetched } = FETCHERS[kind]();

    assert.equal(await isAncestor(head, ancestor, fetchLayer, options), expected);
    assert.equal(fetched.length, fetches);
    assert.ok(!fetched.includes(ancestor));
  });
}

const outage = new Error("gateway down");
const { fetchLayer: fromFixtures } = realFetcher();

// Each walk cannot finish, so isAncestor must throw rather than answer false.
const UNFINISHED_WALKS = [
  [
    "the chain is broken before the ancestor",
    [
      MAINNET_HEAD,
      OLD_MAINNET_HEAD,
      (cid) => (cid === MAINNET_HEAD_PARENT ? Promise.reject(outage) : fromFixtures(cid)),
    ],
    /gateway down/,
    (cause) => assert.equal(cause, outage),
  ],
  [
    "the head cannot be fetched",
    ["bafkreinothere", OLD_MAINNET_HEAD, fromFixtures],
    /could not fetch bafkreinothere/,
  ],
  [
    "the walk is longer than maxDepth",
    [MAINNET_HEAD, "cidElsewhere", fromFixtures, { maxDepth: 3 }],
    /longer than maxDepth 3/,
  ],
  [
    "the chain cycles",
    ["cidLoop", "cidElsewhere", async () => layer({ previousCid: "cidLoop" })],
    /cycle detected/,
  ],
  [
    "a layer fails the network check",
    [MAINNET_HEAD, OLD_MAINNET_HEAD, fromFixtures, { expectedNetwork: "testnet" }],
    /declares network "mainnet"/,
  ],
  [
    "the head is not a registry document",
    ["cidHead", "cidOther", async () => ({ detail: "error page" })],
    /tip document is not a registry/,
  ],
  [
    "a layer below the head fails verification",
    [MAINNET_HEAD, OLD_MAINNET_HEAD, realFetcher({ tampered: MAINNET_HEAD_PARENT }).fetchLayer],
    new RegExp(`${MAINNET_HEAD_PARENT}.*failed verification`),
    (cause) => {
      assert.ok(cause instanceof LayerVerificationError, String(cause));
      assert.equal(cause.cid, MAINNET_HEAD_PARENT);
    },
  ],
];

for (const [name, args, reason, checkCause] of UNFINISHED_WALKS) {
  test(`isAncestor throws when ${name}`, async () => {
    const error = await isAncestor(...args).catch((caught) => caught);

    assert.ok(error instanceof Error && !(error instanceof LayerVerificationError), String(error));
    assert.ok(error.message.startsWith(`cannot walk from ${args[0]}: `), error.message);
    assert.match(error.message, reason);
    checkCause?.(error.cause);
  });
}
