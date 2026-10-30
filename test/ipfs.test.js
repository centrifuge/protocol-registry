import { test } from "node:test";
import assert from "node:assert/strict";
import { IPFS_GATEWAYS, fetchRegistryFromIpfs, isValidIpfsHash } from "../src/io/ipfs.ts";
import { chain, fakeFetch, layer, memoryCache } from "./helpers.js";

test("gateway list has no retired gateways and leads with Centrifuge's own", () => {
  // cloudflare-ipfs.com was retired in 2024; a dead entry costs a timeout on every fetch.
  assert.ok(!IPFS_GATEWAYS.some((gateway) => gateway.includes("cloudflare-ipfs.com")));
  assert.match(IPFS_GATEWAYS[0], /centrifuge-files\.mypinata\.cloud/);
  assert.ok(IPFS_GATEWAYS.length >= 3, "keeps public fallbacks");
});

test("isValidIpfsHash accepts v0 and v1 CIDs and rejects other strings", () => {
  assert.ok(isValidIpfsHash("bafybeif4rypoowonna5fkrekaitqzi4c55g2fn2ky2y5cpp3bobvzijizi"));
  assert.ok(isValidIpfsHash("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"));
  assert.ok(!isValidIpfsHash("not-a-cid"));
  assert.ok(!isValidIpfsHash(""));
  assert.ok(!isValidIpfsHash(null));
});

test("fetchRegistryFromIpfs tries gateways in order and returns the first success", async () => {
  const document = layer({ chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl, calls } = fakeFetch({ cid1: document });

  const result = await fetchRegistryFromIpfs("cid1", { fetchImpl });

  assert.equal(result.chains["1"].contracts.hub.address, "0xhub");
  assert.equal(calls.length, 1, "stops at the first gateway that works");
  assert.ok(calls[0].startsWith(IPFS_GATEWAYS[0]));
});

test("fetchRegistryFromIpfs aggregates every gateway failure in the thrown error", async () => {
  const { fetchImpl, calls } = fakeFetch({}, { failGateways: IPFS_GATEWAYS, failStatus: 429 });

  await assert.rejects(
    () => fetchRegistryFromIpfs("cidX", { fetchImpl }),
    (error) => {
      assert.match(error.message, /could not fetch cidX from any gateway/);
      assert.match(error.message, /429/);
      return true;
    },
  );
  assert.equal(calls.length, IPFS_GATEWAYS.length, "tried every gateway before giving up");
});

test("fetchRegistryFromIpfs writes a fetched layer to the cache and then serves it without fetching", async () => {
  const cache = memoryCache();
  const document = layer({ version: "v9", chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl, calls } = fakeFetch({ cid1: document });

  const first = await fetchRegistryFromIpfs("cid1", { fetchImpl, cache });
  assert.equal(calls.length, 1);
  assert.deepEqual([...cache.store.keys()], ["cid1"], "layer was cached under its CID");

  const second = await fetchRegistryFromIpfs("cid1", { fetchImpl, cache });
  assert.equal(calls.length, 1, "cache hit performs no fetch");
  assert.deepEqual(second, first);
});

test("fetchRegistryFromIpfs refetches when a cached layer is corrupt", async () => {
  const cache = memoryCache({ cid1: "{ truncated" });
  const document = layer({ version: "v9", chains: {} });
  const { fetchImpl, calls } = fakeFetch({ cid1: document });

  const result = await fetchRegistryFromIpfs("cid1", { fetchImpl, cache });

  assert.equal(result.version, "v9");
  assert.equal(calls.length, 1, "a corrupt cache entry is a miss, not a failure");
});

test("fetchRegistryFromIpfs rejects a document that is not a registry layer", async () => {
  // A gateway can serve anything for a CID — an error page rendered as JSON, or a different
  // pinned file. Accepting it would flatten as an empty layer, understating published state.
  const { fetchImpl } = fakeFetch({ cid1: { error: "no such pin" } });

  await assert.rejects(() => fetchRegistryFromIpfs("cid1", { fetchImpl }), /no "chains" object/);
});

test("fetchRegistryFromIpfs does not cache a non-registry document", async () => {
  const cache = memoryCache();
  const { fetchImpl } = fakeFetch({ cid1: ["not", "a", "registry"] });

  await assert.rejects(() => fetchRegistryFromIpfs("cid1", { fetchImpl, cache }));
  assert.equal(cache.store.size, 0, "junk must not enter the layer cache");
});

test("fetchRegistryFromIpfs refuses a CID that would escape the layer cache", async () => {
  // Chain pointers are read from published layers, so a CID is not guaranteed to be well-formed.
  // One carrying path separators would read and write outside the layer cache's key space.
  const cache = memoryCache();
  const { fetchImpl, calls } = fakeFetch({});

  for (const hostile of ["../../etc/passwd", "/etc/passwd", "a/../../b"]) {
    await assert.rejects(
      () => fetchRegistryFromIpfs(hostile, { fetchImpl, cache }),
      /is not a plain CID/,
    );
  }

  assert.equal(calls.length, 0, "refused before any gateway was contacted");
  assert.equal(cache.store.size, 0, "nothing was written to the cache");
});

test("fetchRegistryFromIpfs treats a cached non-registry document as a miss", async () => {
  // Guards cache entries written before the shape check existed.
  const cache = memoryCache({ cid1: JSON.stringify({ detail: "gateway error" }) });
  const document = layer({ version: "v9", chains: { 1: chain({ hub: "0xhub" }) } });
  const { fetchImpl, calls } = fakeFetch({ cid1: document });

  const result = await fetchRegistryFromIpfs("cid1", { fetchImpl, cache });

  assert.equal(result.version, "v9");
  assert.equal(calls.length, 1);
});

test("fetchRegistryFromIpfs keeps integers above 2^53 exact", async () => {
  // chainSelector values exceed what a double holds; a plain JSON.parse would publish them corrupted.
  const text = '{"chains":{"1":{"adapters":{"chainlink":{"chainSelector":5009297550715157269}}}}}';
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => text });

  const result = await fetchRegistryFromIpfs("cid1", { fetchImpl });

  assert.equal(JSON.stringify(result), text);
});
