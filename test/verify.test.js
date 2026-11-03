import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { base36 } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { sha256, sha512 } from "multiformats/hashes/sha2";

import { LayerVerificationError } from "../src/core/layer-verification-error.ts";
import { layerFromBytes, verifyLayer } from "../src/core/verify.ts";
import { fetchRegistryFromIpfs } from "../src/io/ipfs.ts";
import { DAG_PB_LAYER, MAINNET_HEAD, realLayerBytes } from "./helpers.js";

const RAW = 0x55;
const DAG_PB = 0x70;
const DAG_JSON = 0x0129;
const CHUNK_SIZE = 262144;
const LINKS_PER_NODE = 174;

function flipByte(bytes, offset) {
  const tampered = new Uint8Array(bytes);
  tampered[offset] ^= 0x01;
  return tampered;
}

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

for (const { cid, bytes } of [rawLayer, dagPbLayer]) {
  test(`verifyLayer accepts the published layer ${cid}`, async () => {
    await verifyLayer(cid, bytes);
  });
}

const asCodec = (cid, codec) => CID.createV1(codec, CID.parse(cid).multihash).toString();

const MISMATCHES = [
  [
    "a raw layer with one flipped byte",
    () => [rawLayer.cid, flipByte(rawLayer.bytes, 10)],
    /digest/,
  ],
  [
    "a dag-pb layer with one byte flipped past the first chunk",
    () => [dagPbLayer.cid, flipByte(dagPbLayer.bytes, CHUNK_SIZE + 10)],
    /rebuild/,
  ],
  [
    "a dag-pb layer with one byte flipped in the first chunk",
    () => [dagPbLayer.cid, flipByte(dagPbLayer.bytes, 10)],
    /rebuild/,
  ],
  [
    "a dag-pb layer cut short",
    () => [dagPbLayer.cid, dagPbLayer.bytes.subarray(0, CHUNK_SIZE)],
    /rebuild/,
  ],
  [
    "dag-pb bytes under a raw CID over the same root digest",
    () => [asCodec(dagPbLayer.cid, RAW), dagPbLayer.bytes],
    /digest/,
  ],
  [
    "raw bytes under a dag-pb CID",
    () => [asCodec(rawLayer.cid, DAG_PB), rawLayer.bytes],
    /rebuild/,
  ],
];

for (const [name, input, reason] of MISMATCHES) {
  test(`verifyLayer rejects ${name}`, async () => {
    const [cid, bytes] = input();
    await assertRefused(cid, bytes, reason);
  });
}

// Each CID matches its bytes by digest or rebuilt root; only the CID's form is refused.
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

// The published layers are at most four chunks, so they cannot tell 174 links per node from any
// larger number. The expected roots below are assembled by hand from the UnixFS and dag-pb wire
// formats, never through the importer.

function varint(value) {
  const out = [];
  let rest = BigInt(value);
  while (rest >= 0x80n) {
    out.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  out.push(Number(rest));
  return Uint8Array.from(out);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function field(tag, payload) {
  return concat([varint(tag), varint(payload.length), payload]);
}

/** A UnixFS file node over `children`: { cid, tsize, filesize }. Returns { block, cid, tsize, filesize }. */
async function fileNode(children) {
  const links = children.map((child) =>
    field(
      0x12,
      concat([
        field(0x0a, child.cid.bytes),
        field(0x12, new Uint8Array(0)),
        concat([varint(0x18), varint(child.tsize)]),
      ]),
    ),
  );
  const filesize = children.reduce((sum, child) => sum + child.filesize, 0);
  const unixfs = concat([
    concat([varint(0x08), varint(2)]),
    concat([varint(0x18), varint(filesize)]),
    ...children.map((child) => concat([varint(0x20), varint(child.filesize)])),
  ]);
  const block = concat([...links, field(0x0a, unixfs)]);
  const cid = CID.createV1(DAG_PB, await sha256.digest(block));
  const tsize = block.length + children.reduce((sum, child) => sum + child.tsize, 0);
  return { block, cid, tsize, filesize };
}

async function expectedRoot(bytes) {
  const leaves = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    const cid = CID.createV1(RAW, await sha256.digest(chunk));
    leaves.push({ cid, tsize: chunk.length, filesize: chunk.length });
  }
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += LINKS_PER_NODE) {
      next.push(await fileNode(level.slice(i, i + LINKS_PER_NODE)));
    }
    level = next;
  }
  return level[0].cid.toString();
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

test("verifyLayer rebuilds a file of exactly 174 chunks as one node with 174 links", async () => {
  const bytes = pseudoRandomBytes(LINKS_PER_NODE * CHUNK_SIZE);
  await verifyLayer(await expectedRoot(bytes), bytes);
});

test("verifyLayer rebuilds a file of 175 chunks as a root over two nodes", async () => {
  const bytes = pseudoRandomBytes(LINKS_PER_NODE * CHUNK_SIZE + 1);
  await verifyLayer(await expectedRoot(bytes), bytes);
});

test("verifyLayer refuses a dag-pb wrapper around a single chunk, which ipfs add keeps as the raw leaf", async () => {
  const bytes = rawLayer.bytes;
  assert.ok(bytes.length <= CHUNK_SIZE);
  const leaf = {
    cid: CID.createV1(RAW, await sha256.digest(bytes)),
    tsize: bytes.length,
    filesize: bytes.length,
  };
  const wrapped = (await fileNode([leaf])).cid.toString();
  await assertRefused(wrapped, bytes, /rebuild/);
});

test("the hand-assembled root agrees with a real published layer", async () => {
  // Guards the oracle itself: if it cannot reproduce a CID the network serves, it proves nothing.
  assert.equal(await expectedRoot(dagPbLayer.bytes), dagPbLayer.cid);
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
