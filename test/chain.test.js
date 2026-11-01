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
import { fetchRegistryFromIpfs } from "../src/io/ipfs.ts";
import {
  MAINNET_HEAD,
  OLD_MAINNET_HEAD,
  TESTNET_HEAD,
  chain,
  contract,
  fakeFetch,
  ipfsFetcher,
  layer,
  realChain,
  realLayerBytes,
  realLayerFetch,
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

test("collectRegistryChain refuses a tip that declares no network when one is expected", async () => {
  const tip = layer({ version: "v2", network: null, chains: { 1: chain({ hub: "0xhub" }) } });

  const result = await collectRegistryChain(tip, {
    expectedNetwork: "mainnet",
    fetchLayer: ipfsFetcher(),
  });

  assert.equal(result.complete, false);
  assert.match(result.reason, /declares no network.*"mainnet" is being generated/);
  assert.equal(result.fatal, true);
  assert.deepEqual(result.accumulated, {});
  assert.deepEqual(result.layers, []);
});

test("collectRegistryChain refuses a mid-chain layer that declares no network when one is expected", async () => {
  const base = layer({ version: "v1", network: null, chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl } = fakeFetch({ cidBase: base });
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidBase" });

  const result = await collectRegistryChain(tip, {
    expectedNetwork: "mainnet",
    fetchLayer: ipfsFetcher(fetchImpl),
  });

  assert.equal(result.complete, false);
  assert.match(result.reason, /declares no network/);
  assert.equal(result.fatal, true);
  assert.deepEqual(result.accumulated, {});
});

test("collectRegistryChain refuses a layer whose network is not a string", async () => {
  const tip = layer({ version: "v2", network: 1, chains: {} });

  const result = await collectRegistryChain(tip, {
    expectedNetwork: "mainnet",
    fetchLayer: ipfsFetcher(),
  });

  assert.equal(result.fatal, true);
  assert.match(result.reason, /declares no network/);
});

test("collectRegistryChain accepts layers without a network when none is expected", async () => {
  const base = layer({ version: "v1", network: null, chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl } = fakeFetch({ cidBase: base });
  const tip = layer({ version: "v2", network: null, chains: {}, previousCid: "cidBase" });

  const result = await collectRegistryChain(tip, { fetchLayer: ipfsFetcher(fetchImpl) });

  assert.equal(result.complete, true);
  assert.equal(result.reason, null);
  assert.equal(result.accumulated["1"].contracts.hub.address, "0xhub");
});

test("collectRegistryChain walks both real chains under their own network, every layer declaring it", async () => {
  const { fetchImpl } = realLayerFetch();
  const fetchLayer = ipfsFetcher(fetchImpl);

  for (const [head, network, length] of [
    [MAINNET_HEAD, "mainnet", 14],
    [TESTNET_HEAD, "testnet", 53],
  ]) {
    const result = await collectRegistryChain(await fetchLayer(head), {
      fetchLayer,
      expectedNetwork: network,
    });
    assert.equal(result.complete, true, result.reason ?? "");
    assert.equal(result.layers.length, length);
  }
});

test("collectRegistryChain refuses the real testnet chain when mainnet is expected", async () => {
  const { fetchImpl } = realLayerFetch();
  const fetchLayer = ipfsFetcher(fetchImpl);

  const result = await collectRegistryChain(await fetchLayer(TESTNET_HEAD), {
    fetchLayer,
    expectedNetwork: "mainnet",
  });

  assert.equal(result.fatal, true);
  assert.match(result.reason, /declares network "testnet"/);
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

function countingFetcher() {
  const { fetchImpl } = realLayerFetch();
  const fetched = [];
  const fetchLayer = (cid) => {
    fetched.push(cid);
    return fetchRegistryFromIpfs(cid, { fetchImpl });
  };
  return { fetchLayer, fetched };
}

test("collectRegistryChain with stopAt stops before fetching the layer it names", async () => {
  const { fetchLayer, fetched } = countingFetcher();
  const tip = await fetchLayer(MAINNET_HEAD);

  const result = await collectRegistryChain(tip, {
    fetchLayer,
    stopAt: new Set([OLD_MAINNET_HEAD]),
  });

  assert.equal(result.stoppedAt, OLD_MAINNET_HEAD);
  assert.equal(result.layers.length, 2);
  assert.equal(fetched.length, 2, "the head and the one layer above the stop");
  assert.ok(!fetched.includes(OLD_MAINNET_HEAD));
  assert.equal(result.complete, false);
  assert.equal(result.reason, null);
  assert.equal(result.fatal, false);
});

test("collectRegistryChain with stopAt accumulates only the layers above the stop", async () => {
  const stop = realChain(MAINNET_HEAD).map(({ cid }) => cid)[2];
  assert.equal(stop, OLD_MAINNET_HEAD);
  const { fetchLayer } = countingFetcher();
  const tip = await fetchLayer(MAINNET_HEAD);
  const above = [await fetchLayer(tip.previousRegistry.ipfsHash), tip].map(slimLayer);

  const result = await collectRegistryChain(tip, {
    fetchLayer: async (cid) => slimLayer(await fetchLayer(cid)),
    stopAt: new Set([OLD_MAINNET_HEAD]),
  });

  assert.deepEqual(result.accumulated, flattenRegistryChain(above));
  assert.deepEqual([...result.accumulatedAbis], [...flattenRegistryAbis(above)]);
});

test("collectRegistryChain without stopAt walks the whole real chain and reports no stop", async () => {
  const { fetchLayer, fetched } = countingFetcher();
  const tip = await fetchLayer(MAINNET_HEAD);

  const result = await collectRegistryChain(tip, { fetchLayer });

  assert.equal(fetched.length, 14);
  assert.equal(result.complete, true);
  assert.equal(result.stoppedAt, null);
});

test("collectRegistryChain with stopAt never matches the tip's own CID", async () => {
  const { fetchLayer, fetched } = countingFetcher();
  const tip = await fetchLayer(MAINNET_HEAD);

  const result = await collectRegistryChain(tip, { fetchLayer, stopAt: new Set([MAINNET_HEAD]) });

  assert.equal(result.stoppedAt, null);
  assert.equal(result.complete, true);
  assert.equal(fetched.length, 14);
});

test("collectRegistryChain with a stopAt that is not in the chain walks to the base", async () => {
  const { fetchLayer } = countingFetcher();
  const tip = await fetchLayer(MAINNET_HEAD);

  const result = await collectRegistryChain(tip, {
    fetchLayer,
    stopAt: new Set([TESTNET_HEAD]),
  });

  assert.equal(result.stoppedAt, null);
  assert.equal(result.complete, true);
});

test("collectRegistryChain stops at stopAt even when the layer below the tip is the stop", async () => {
  const base = layer({ version: "v1", chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl, calls } = fakeFetch({ cidBase: base });
  const tip = layer({
    version: "v2",
    chains: { 1: chain({ vault: "0xvault" }) },
    previousCid: "cidBase",
  });

  const result = await collectRegistryChain(tip, {
    fetchLayer: ipfsFetcher(fetchImpl),
    stopAt: new Set(["cidBase"]),
  });

  assert.equal(calls.length, 0);
  assert.equal(result.stoppedAt, "cidBase");
  assert.deepEqual(Object.keys(result.accumulated["1"].contracts), ["vault"]);
});

test("collectRegistryChain reports no stop when the walk fails before reaching it", async () => {
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidMissing" });

  const result = await collectRegistryChain(tip, {
    fetchLayer: ipfsFetcher(fakeFetch({}).fetchImpl),
    stopAt: new Set(["cidFar"]),
  });

  assert.equal(result.stoppedAt, null);
  assert.equal(result.complete, false);
  assert.match(result.reason, /could not fetch cidMissing/);
});

test("isAncestor is true for a real layer two steps below the head", async () => {
  const { fetchLayer } = countingFetcher();

  assert.equal(await isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, fetchLayer), true);
});

test("isAncestor fetches the head and the ancestor's child, never the ancestor", async () => {
  const { fetchLayer, fetched } = countingFetcher();

  await isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, fetchLayer);

  assert.equal(fetched.length, 2);
  assert.ok(!fetched.includes(OLD_MAINNET_HEAD));
});

test("isAncestor is true when the ancestor is the head, without fetching", async () => {
  const { fetchLayer, fetched } = countingFetcher();

  assert.equal(await isAncestor(MAINNET_HEAD, MAINNET_HEAD, fetchLayer), true);
  assert.equal(fetched.length, 0);
});

test("isAncestor is true for the base snapshot of the chain", async () => {
  const { fetchLayer } = countingFetcher();
  const base = realChain(MAINNET_HEAD).at(-1).cid;

  assert.equal(await isAncestor(MAINNET_HEAD, base, fetchLayer), true);
});

test("isAncestor is false for a testnet layer against the mainnet head", async () => {
  const { fetchLayer } = countingFetcher();

  assert.equal(await isAncestor(MAINNET_HEAD, TESTNET_HEAD, fetchLayer), false);
});

test("isAncestor is false for a head's descendant", async () => {
  const { fetchLayer } = countingFetcher();

  assert.equal(await isAncestor(OLD_MAINNET_HEAD, MAINNET_HEAD, fetchLayer), false);
});

test("isAncestor throws when the chain is broken before it reaches the ancestor", async () => {
  const { fetchImpl } = realLayerFetch();
  const brokenAt = realChain(MAINNET_HEAD)[1].cid;
  const fetchLayer = (cid) =>
    fetchRegistryFromIpfs(cid, {
      fetchImpl: async (url) =>
        url.endsWith(brokenAt) ? new Response("gone", { status: 404 }) : fetchImpl(url),
    });

  await assert.rejects(
    () => isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, fetchLayer),
    new RegExp(`could not fetch ${brokenAt}`),
  );
});

test("isAncestor throws when the head cannot be fetched", async () => {
  const { fetchImpl } = realLayerFetch();

  await assert.rejects(
    () => isAncestor("bafkreinothere", OLD_MAINNET_HEAD, ipfsFetcher(fetchImpl)),
    /bafkreinothere/,
  );
});

test("isAncestor throws when the walk is longer than maxDepth", async () => {
  const { fetchLayer } = countingFetcher();

  await assert.rejects(
    () => isAncestor(MAINNET_HEAD, TESTNET_HEAD, fetchLayer, { maxDepth: 3 }),
    /longer than maxDepth 3/,
  );
});

test("isAncestor throws on a cycle rather than answering false", async () => {
  const looping = layer({ version: "v2", chains: {}, previousCid: "cidLoop" });
  const { fetchImpl } = fakeFetch({ cidLoop: looping });

  await assert.rejects(
    () => isAncestor("cidLoop", "cidElsewhere", ipfsFetcher(fetchImpl)),
    /cycle detected/,
  );
});

test("isAncestor throws on a network refusal rather than answering false", async () => {
  const { fetchLayer } = countingFetcher();

  await assert.rejects(
    () => isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, fetchLayer, { expectedNetwork: "testnet" }),
    /declares network "mainnet"/,
  );
});

test("isAncestor still answers true when the stop sits at the maxDepth bound", async () => {
  const { fetchLayer } = countingFetcher();

  assert.equal(await isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, fetchLayer, { maxDepth: 2 }), true);
});

test("isAncestor throws when the head is not a registry document", async () => {
  await assert.rejects(
    () => isAncestor("cidHead", "cidOther", async () => ({ detail: "error page" })),
    /cannot walk from cidHead: tip document is not a registry/,
  );
});

function verifyingFetcher(tamperedCid) {
  return async (cid) => {
    const bytes = new Uint8Array(realLayerBytes(cid));
    if (cid === tamperedCid) bytes[10] ^= 0x01;
    return layerFromBytes(cid, bytes);
  };
}

test("collectRegistryChain is fatal when a layer fails verification mid-chain", async () => {
  const tampered = realChain(MAINNET_HEAD)[5].cid;
  const fetchLayer = verifyingFetcher(tampered);

  const result = await collectRegistryChain(await fetchLayer(MAINNET_HEAD), { fetchLayer });

  assert.equal(result.fatal, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.layers, []);
  assert.deepEqual(result.accumulated, {});
  assert.ok(result.reason.includes(tampered), result.reason);
});

test("collectRegistryChain over verified fixtures with nothing tampered completes", async () => {
  const fetchLayer = verifyingFetcher(null);

  const result = await collectRegistryChain(await fetchLayer(MAINNET_HEAD), { fetchLayer });

  assert.equal(result.complete, true);
  assert.equal(result.layers.length, 14);
});

test("collectRegistryChain keeps an ordinary fetch failure non-fatal", async () => {
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidMissing" });

  const result = await collectRegistryChain(tip, {
    fetchLayer: async () => {
      throw new Error("gateway down");
    },
  });

  assert.equal(result.fatal, false);
  assert.equal(result.reason, "gateway down");
});

test("isAncestor throws when a layer fails verification before it reaches the ancestor", async () => {
  const tampered = realChain(MAINNET_HEAD)[1].cid;

  await assert.rejects(
    () => isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, verifyingFetcher(tampered)),
    new RegExp(`cannot walk from ${MAINNET_HEAD}: .*${tampered}.*failed verification`),
  );
});

test("isAncestor honours expectedNetwork when it matches", async () => {
  const { fetchLayer } = countingFetcher();

  assert.equal(
    await isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, fetchLayer, { expectedNetwork: "mainnet" }),
    true,
  );
});

test("slimLayer keeps which ABIs a layer carries and drops their bodies", () => {
  const full = { chains: {}, abis: { Hub: [{ type: "function", name: "x" }], Spoke: [] } };

  assert.deepEqual(slimLayer(full).abis, { Hub: [], Spoke: [] });
  assert.equal(full.abis.Hub.length, 1, "the input is not modified");
});

class ForeignLayerVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LayerVerificationError";
  }
}

test("collectRegistryChain is fatal for a verification error from another copy of the package", async () => {
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidForeign" });

  const result = await collectRegistryChain(tip, {
    fetchLayer: async () => {
      throw new ForeignLayerVerificationError("layer cidForeign failed verification: tampered");
    },
  });

  assert.equal(result.fatal, true);
  assert.deepEqual(result.layers, []);
});

test("collectRegistryChain keeps a plain error named like another class non-fatal", async () => {
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidOutage" });

  const result = await collectRegistryChain(tip, {
    fetchLayer: async () => {
      throw Object.assign(new Error("gateway down"), { name: "TypeError" });
    },
  });

  assert.equal(result.fatal, false);
});

test("isAncestor keeps the verification error from a layer below the head as the cause", async () => {
  const tampered = realChain(MAINNET_HEAD)[1].cid;

  const error = await isAncestor(MAINNET_HEAD, OLD_MAINNET_HEAD, verifyingFetcher(tampered)).catch(
    (caught) => caught,
  );

  assert.ok(error instanceof Error && !(error instanceof LayerVerificationError));
  assert.ok(error.cause instanceof LayerVerificationError, String(error.cause));
  assert.equal(error.cause.cid, tampered);
});

test("isAncestor keeps the fetch failure from a layer below the head as the cause", async () => {
  const tip = layer({ version: "v2", chains: {}, previousCid: "cidMissing" });
  const outage = new Error("gateway down");
  const fetchLayer = async (cid) => {
    if (cid === "cidHead") return tip;
    throw outage;
  };

  const error = await isAncestor("cidHead", "cidOther", fetchLayer).catch((caught) => caught);

  assert.equal(error.cause, outage);
});
