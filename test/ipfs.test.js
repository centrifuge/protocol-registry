import { test } from "node:test";
import assert from "node:assert/strict";
import { LayerVerificationError } from "../src/core/layer-verification-error.ts";
import { layerFromBytes } from "../src/core/verify.ts";
import { IPFS_GATEWAYS, fetchRegistryFromIpfs, isValidIpfsHash } from "../src/io/ipfs.ts";
import {
  MAINNET_HEAD,
  MAINNET_HEAD_PARENT,
  fakeFetch,
  flipByte,
  memoryCache,
  realLayerBytes,
} from "./helpers.js";

const headBytes = realLayerBytes(MAINNET_HEAD);
const head = await layerFromBytes(MAINNET_HEAD, headBytes);
const urlsOf = (gateways) => gateways.map((gateway) => `${gateway}${MAINNET_HEAD}`);

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
  const { fetchImpl, calls } = fakeFetch({ [MAINNET_HEAD]: headBytes });

  const result = await fetchRegistryFromIpfs(MAINNET_HEAD, { fetchImpl });

  assert.deepEqual(result, head);
  assert.deepEqual(
    calls,
    urlsOf(IPFS_GATEWAYS.slice(0, 1)),
    "stops at the first gateway that works",
  );
});

// A gateway can serve anything for a CID. Each of these is skipped like a gateway that is down.
const FIRST_GATEWAY_FAULTS = [
  ["answers 500", () => new Response(null, { status: 500 })],
  ["serves the layer with a byte flipped", () => new Response(flipByte(headBytes, 10))],
  ["serves another layer", () => new Response(realLayerBytes(MAINNET_HEAD_PARENT))],
  ["serves an error page", () => new Response("<html>rate limited</html>")],
];

for (const [name, firstResponse] of FIRST_GATEWAY_FAULTS) {
  test(`fetchRegistryFromIpfs skips a gateway that ${name}`, async () => {
    const cache = memoryCache();
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return url.startsWith(IPFS_GATEWAYS[0]) ? firstResponse() : new Response(headBytes);
    };

    const result = await fetchRegistryFromIpfs(MAINNET_HEAD, { fetchImpl, cache });

    assert.deepEqual(result, head);
    assert.deepEqual(calls, urlsOf(IPFS_GATEWAYS.slice(0, 2)));
    assert.deepEqual(cache.store.get(MAINNET_HEAD), headBytes, "only verified bytes are cached");
  });
}

test("fetchRegistryFromIpfs aggregates every gateway failure in the thrown error", async () => {
  const { fetchImpl, calls } = fakeFetch({}, { failGateways: IPFS_GATEWAYS, failStatus: 429 });

  await assert.rejects(
    () => fetchRegistryFromIpfs("cidX", { fetchImpl }),
    (error) => {
      assert.match(error.message, /could not fetch cidX from any gateway/);
      assert.match(error.message, /429/);
      assert.ok(!(error instanceof LayerVerificationError), "an outage is not a verdict on bytes");
      return true;
    },
  );
  assert.equal(calls.length, IPFS_GATEWAYS.length, "tried every gateway before giving up");
});

test("fetchRegistryFromIpfs throws a LayerVerificationError when no gateway serves matching bytes", async () => {
  // Bytes that do not match are evidence against the layer, not an outage: the chain walk makes a
  // LayerVerificationError fatal, so allowPartialChain cannot generate past a forged layer.
  const cache = memoryCache();
  const { fetchImpl, calls } = fakeFetch(
    { [MAINNET_HEAD]: flipByte(headBytes, 10) },
    { failGateways: [IPFS_GATEWAYS[1]], failStatus: 429 },
  );

  await assert.rejects(
    () => fetchRegistryFromIpfs(MAINNET_HEAD, { fetchImpl, cache }),
    (error) => {
      assert.ok(error instanceof LayerVerificationError, `got ${error}`);
      assert.equal(error.cid, MAINNET_HEAD);
      assert.match(error.message, /no gateway served matching bytes/);
      assert.match(error.message, /429/);
      return true;
    },
  );
  assert.equal(calls.length, IPFS_GATEWAYS.length, "tried every gateway before giving up");
  assert.equal(cache.store.size, 0, "tampered bytes never enter the cache");
});

test("fetchRegistryFromIpfs writes a fetched layer to the cache and then serves it without fetching", async () => {
  const cache = memoryCache();
  const { fetchImpl, calls } = fakeFetch({ [MAINNET_HEAD]: headBytes });

  const first = await fetchRegistryFromIpfs(MAINNET_HEAD, { fetchImpl, cache });
  assert.equal(calls.length, 1);
  assert.deepEqual([...cache.store.keys()], [MAINNET_HEAD], "layer was cached under its CID");

  const second = await fetchRegistryFromIpfs(MAINNET_HEAD, { fetchImpl, cache });
  assert.equal(calls.length, 1, "cache hit performs no fetch");
  assert.deepEqual(second, first);
});

// The cache is not trusted either: an entry that does not verify is fetched again and overwritten.
const POISONED_ENTRIES = [
  ["the layer with a byte flipped", () => flipByte(headBytes, 10)],
  ["another layer", () => realLayerBytes(MAINNET_HEAD_PARENT)],
  ["a truncated write", () => headBytes.subarray(0, 100)],
];

for (const [name, poisoned] of POISONED_ENTRIES) {
  test(`fetchRegistryFromIpfs replaces a cache entry holding ${name}`, async () => {
    const cache = memoryCache({ [MAINNET_HEAD]: poisoned() });
    const { fetchImpl, calls } = fakeFetch({ [MAINNET_HEAD]: headBytes });

    const result = await fetchRegistryFromIpfs(MAINNET_HEAD, { fetchImpl, cache });

    assert.deepEqual(result, head);
    assert.equal(calls.length, 1, "fetched again from a gateway");
    assert.deepEqual(cache.store.get(MAINNET_HEAD), headBytes, "overwritten with verified bytes");
  });
}

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

test("fetchRegistryFromIpfs keeps integers above 2^53 exact", async () => {
  // chainSelector values exceed what a double holds; a plain JSON.parse would publish them corrupted.
  const { fetchImpl } = fakeFetch({ [MAINNET_HEAD]: headBytes });

  const result = await fetchRegistryFromIpfs(MAINNET_HEAD, { fetchImpl });

  assert.match(JSON.stringify(result), /"chainSelector":11344663589394136015[,}]/);
});
