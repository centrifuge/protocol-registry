import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { base36 } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { equals } from "multiformats/bytes";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";

import { LayerVerificationError } from "../src/core/layer-verification-error.ts";
import { layerFromBytes, unixfsFileRoot, verifyLayer } from "../src/core/verify.ts";
import { fetchRegistryFromIpfs } from "../src/io/ipfs.ts";
import { DAG_PB_LAYER, MAINNET_HEAD, flipByte, realLayerBytes } from "./helpers.js";

const RAW = 0x55;
const DAG_PB = 0x70;
const DAG_JSON = 0x0129;
const CHUNK_SIZE = 262144;
const LINKS_PER_NODE = 174;

async function assertRefused(cid, bytes, reason) {
  await assert.rejects(
    () => verifyLayer(cid, bytes),
    (error) => {
      assert.ok(error instanceof LayerVerificationError, `got ${error}`);
      assert.equal(error.cid, cid);
      assert.match(error.message, reason);
      return true;
    },
  );
}

const rawLayer = { cid: MAINNET_HEAD, bytes: realLayerBytes(MAINNET_HEAD) };
const dagPbLayer = { cid: DAG_PB_LAYER, bytes: realLayerBytes(DAG_PB_LAYER) };

const asCodec = (cid, codec) => CID.createV1(codec, CID.parse(cid).multihash).toString();

const { cid: rawCid, bytes: raw } = rawLayer;
const { cid: dagPbCid, bytes: dagPb } = dagPbLayer;

const MISMATCHES = [
  ["a raw layer with one flipped byte", rawCid, flipByte(raw, 10), /digest/],
  [
    "a dag-pb layer flipped past its first chunk",
    dagPbCid,
    flipByte(dagPb, CHUNK_SIZE + 10),
    /rebuild/,
  ],
  ["a dag-pb layer flipped in its first chunk", dagPbCid, flipByte(dagPb, 10), /rebuild/],
  ["a dag-pb layer cut short", dagPbCid, dagPb.subarray(0, CHUNK_SIZE), /rebuild/],
  ["dag-pb bytes under a raw CID of the root digest", asCodec(dagPbCid, RAW), dagPb, /digest/],
  ["raw bytes under a dag-pb CID", asCodec(rawCid, DAG_PB), raw, /rebuild/],
];

for (const [name, cid, bytes, reason] of MISMATCHES) {
  test(`verifyLayer rejects ${name}`, () => assertRefused(cid, bytes, reason));
}

// Every CID that parses matches the bytes' digest; only its form is refused.
const REFUSED_CIDS = [
  ["a CIDv0", async () => CID.createV0(await sha256.digest(rawLayer.bytes)), /CIDv0/],
  [
    "a codec other than raw and dag-pb, naming it",
    async () => CID.createV1(DAG_JSON, await sha256.digest(rawLayer.bytes)),
    /codec 0x129/,
  ],
  [
    "a hash other than sha2-256, naming it",
    async () => CID.createV1(RAW, await sha512.digest(rawLayer.bytes)),
    /hash function 0x13/,
  ],
  ["a base58btc spelling", async () => CID.parse(rawLayer.cid).toString(base58btc), /canonical/],
  ["a base36 spelling", async () => CID.parse(rawLayer.cid).toString(base36), /canonical/],
  ["a string that is not a CID", async () => "not-a-cid", /not a CID/],
  ["an empty CID", async () => "", /not a CID/],
];

for (const [name, makeCid, reason] of REFUSED_CIDS) {
  test(`verifyLayer refuses ${name}`, async () => {
    await assertRefused(String(await makeCid()), rawLayer.bytes, reason);
  });
}

test("verifyLayer accepts an empty raw layer only under the empty digest", async () => {
  const empty = new Uint8Array(0);
  const emptyCid = CID.createV1(RAW, await sha256.digest(empty)).toString();
  await verifyLayer(emptyCid, empty);
  await assertRefused(emptyCid, new Uint8Array([1]), /digest/);
});

/** The root `ipfs add --cid-version 1` gives, computed by the reference importer. */
async function importerRoot(bytes, { chunkSize = CHUNK_SIZE, linksPerNode = LINKS_PER_NODE } = {}) {
  const entries = importer(
    [{ content: bytes }],
    { put: async (cid) => cid },
    {
      cidVersion: 1,
      rawLeaves: true,
      reduceSingleLeafToSelf: true,
      wrapWithDirectory: false,
      chunker: fixedSize({ chunkSize }),
      layout: balanced({ maxChildrenPerNode: linksPerNode }),
    },
  );
  let root;
  for await (const entry of entries) root = entry.cid;
  return root;
}

function pseudoRandomBytes(length) {
  const out = new Uint8Array(length);
  let state = createHash("sha256").update("layer-verification").digest();
  for (let offset = 0; offset < length; offset += state.length) {
    out.set(state.subarray(0, Math.min(state.length, length - offset)), offset);
    state = createHash("sha256").update(state).digest();
  }
  return out;
}

// The published layers span at most four chunks, so the layout past them is checked on synthetic
// files, the deepest with one-byte chunks to keep three levels of 174 links small.
const ROOTS = [
  ["the published raw layer", () => rawLayer.bytes],
  ["the published dag-pb layer", () => dagPbLayer.bytes],
  ["an empty file", () => new Uint8Array(0)],
  ["one chunk", () => pseudoRandomBytes(CHUNK_SIZE)],
  ["two chunks, the second one byte", () => pseudoRandomBytes(CHUNK_SIZE + 1)],
  ["174 chunks under one node", () => pseudoRandomBytes(LINKS_PER_NODE * CHUNK_SIZE)],
  ["175 chunks under two nodes", () => pseudoRandomBytes(LINKS_PER_NODE * CHUNK_SIZE + 1)],
  [
    "two 128-byte chunks, the smallest two-byte varint",
    () => pseudoRandomBytes(256),
    { chunkSize: 128 },
  ],
  ["174*174 one-byte chunks", () => pseudoRandomBytes(LINKS_PER_NODE ** 2), { chunkSize: 1 }],
  ["174*174+1 one-byte chunks", () => pseudoRandomBytes(LINKS_PER_NODE ** 2 + 1), { chunkSize: 1 }],
];

for (const [name, makeBytes, layout] of ROOTS) {
  test(`unixfsFileRoot matches the reference importer for ${name}`, async () => {
    const bytes = makeBytes();
    const expected = await importerRoot(bytes, layout);

    const root = await unixfsFileRoot(bytes, layout && { ...layout, linksPerNode: LINKS_PER_NODE });

    assert.equal(root.toString(), expected.toString());
    assert.ok(equals(root.bytes, expected.bytes));
    if (!layout) await verifyLayer(expected.toString(), bytes);
  });
}

test("verifyLayer refuses a dag-pb wrapper around a single chunk, which ipfs add keeps as the raw leaf", async () => {
  const wrapped = await importer(
    [{ content: rawLayer.bytes }],
    { put: async (cid) => cid },
    { cidVersion: 1, rawLeaves: true, reduceSingleLeafToSelf: false },
  ).next();
  assert.equal(wrapped.value.cid.code, DAG_PB);

  await assertRefused(wrapped.value.cid.toString(), rawLayer.bytes, /rebuild/);
});

async function rawCidOf(bytes) {
  return CID.createV1(RAW, await sha256.digest(bytes)).toString();
}

test("layerFromBytes returns the registry document the bytes hold", async () => {
  const layer = await layerFromBytes(rawLayer.cid, rawLayer.bytes);

  assert.deepEqual(
    Object.keys(layer.chains),
    Object.keys(JSON.parse(new TextDecoder().decode(rawLayer.bytes)).chains),
  );
});

test("layerFromBytes refuses a flipped byte on the digest, not on a parse error", async () => {
  const tampered = flipByte(rawLayer.bytes, 0);
  assert.throws(() => JSON.parse(new TextDecoder().decode(tampered)));

  await assert.rejects(
    () => layerFromBytes(rawLayer.cid, tampered),
    (error) => error instanceof LayerVerificationError && /digest/.test(error.message),
  );
});

const NOT_A_REGISTRY = [
  [
    "valid JSON that is not a registry",
    new TextEncoder().encode('{"error":"rate limited"}'),
    /no "chains" object/,
  ],
  ["bytes that are not JSON", new TextEncoder().encode("<html>gateway error</html>"), /UTF-8 JSON/],
  [
    "bytes that are not UTF-8",
    Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x7b, 0x7d, 0x7d]),
    /UTF-8 JSON/,
  ],
];

for (const [name, bytes, reason] of NOT_A_REGISTRY) {
  test(`layerFromBytes refuses ${name} under a matching CID`, async () => {
    const cid = await rawCidOf(bytes);

    await verifyLayer(cid, bytes);
    await assert.rejects(
      () => layerFromBytes(cid, bytes),
      (error) => error instanceof LayerVerificationError && reason.test(error.message),
    );
  });
}

test("layerFromBytes reads a layer behind a byte order mark as a gateway response would", async () => {
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
  const bytes = new Uint8Array([...bom, ...rawLayer.bytes]);
  const cid = await rawCidOf(bytes);
  const served = await fetchRegistryFromIpfs(cid, {
    fetchImpl: async () => new Response(bytes, { status: 200 }),
  });

  const layer = await layerFromBytes(cid, bytes);

  assert.deepEqual(layer, served);
  assert.equal(
    JSON.stringify(layer),
    JSON.stringify(await layerFromBytes(rawLayer.cid, rawLayer.bytes)),
  );
});
