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
import { MAINNET_HEAD, TESTNET_HEAD, realChain, realLayerBytes, realLayerCids } from "./helpers.js";

const RAW = 0x55;
const DAG_PB = 0x70;
const DAG_JSON = 0x0129;
const CHUNK_SIZE = 262144;
const LINKS_PER_NODE = 174;

function codecOf(cid) {
  return CID.parse(cid).code;
}

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

const mainnet = realChain(MAINNET_HEAD);
const testnet = realChain(TESTNET_HEAD);
const firstRaw = mainnet.find(({ cid }) => codecOf(cid) === RAW);
const firstDagPb = mainnet.find(({ cid }) => codecOf(cid) === DAG_PB);

test("verifyLayer accepts every layer of both live chains, raw and dag-pb alike", async () => {
  const counts = {
    mainnet: { [RAW]: 0, [DAG_PB]: 0 },
    testnet: { [RAW]: 0, [DAG_PB]: 0 },
  };
  for (const [name, layers] of [
    ["mainnet", mainnet],
    ["testnet", testnet],
  ]) {
    for (const { cid, bytes } of layers) {
      await verifyLayer(cid, bytes);
      counts[name][codecOf(cid)]++;
    }
  }

  assert.deepEqual(counts.mainnet, { [RAW]: 8, [DAG_PB]: 6 });
  assert.deepEqual(counts.testnet, { [RAW]: 25, [DAG_PB]: 28 });
  const walked = new Set([...mainnet, ...testnet].map(({ cid }) => cid));
  assert.deepEqual([...walked].sort(), realLayerCids());
});

test("verifyLayer rejects a raw layer with one flipped byte", async () => {
  await assertRefused(firstRaw.cid, flipByte(firstRaw.bytes, 10), /digest/);
});

test("verifyLayer rejects a dag-pb layer with one byte flipped past the first chunk", async () => {
  assert.ok(firstDagPb.bytes.length > CHUNK_SIZE + 10);
  await assertRefused(firstDagPb.cid, flipByte(firstDagPb.bytes, CHUNK_SIZE + 10), /rebuild/);
});

test("verifyLayer rejects a dag-pb layer with one byte flipped in the first chunk", async () => {
  await assertRefused(firstDagPb.cid, flipByte(firstDagPb.bytes, 10), /rebuild/);
});

test("verifyLayer rejects a dag-pb layer cut short", async () => {
  await assertRefused(firstDagPb.cid, firstDagPb.bytes.subarray(0, CHUNK_SIZE), /rebuild/);
});

test("verifyLayer rejects dag-pb bytes under a raw CID over the same root digest", async () => {
  const dagPb = CID.parse(firstDagPb.cid);
  const asRaw = CID.createV1(RAW, dagPb.multihash).toString();
  await assertRefused(asRaw, firstDagPb.bytes, /digest/);
});

test("verifyLayer rejects raw bytes under a dag-pb CID", async () => {
  const raw = CID.parse(firstRaw.cid);
  const asDagPb = CID.createV1(DAG_PB, raw.multihash).toString();
  await assertRefused(asDagPb, firstRaw.bytes, /rebuild/);
});

test("verifyLayer refuses a CIDv0 even when its digest matches the bytes", async () => {
  const digest = await sha256.digest(firstRaw.bytes);
  const v0 = CID.createV0(digest).toString();
  assert.match(v0, /^Qm/);
  await assertRefused(v0, firstRaw.bytes, /CIDv0/);
});

test("verifyLayer refuses a codec that is neither raw nor dag-pb, naming it", async () => {
  const digest = await sha256.digest(firstRaw.bytes);
  const dagJson = CID.createV1(DAG_JSON, digest).toString();
  await assertRefused(dagJson, firstRaw.bytes, /codec 0x129/);
});

test("verifyLayer refuses a hash other than sha2-256 even when its digest matches", async () => {
  const digest = await sha512.digest(firstRaw.bytes);
  const sha512Cid = CID.createV1(RAW, digest).toString();
  await assertRefused(sha512Cid, firstRaw.bytes, /hash function 0x13/);
});

test("verifyLayer refuses a base58btc spelling of a CID whose digest matches", async () => {
  const spelled = CID.parse(firstRaw.cid).toString(base58btc);
  assert.match(spelled, /^z/);
  await assertRefused(spelled, firstRaw.bytes, /canonical/);
});

test("verifyLayer refuses a base36 spelling of a dag-pb CID whose root matches", async () => {
  const spelled = CID.parse(firstDagPb.cid).toString(base36);
  assert.match(spelled, /^k/);
  await assertRefused(spelled, firstDagPb.bytes, /canonical/);
});

test("verifyLayer refuses a string that is not a CID", async () => {
  await assertRefused("not-a-cid", firstRaw.bytes, /not a CID/);
});

test("verifyLayer refuses an empty CID", async () => {
  await assertRefused("", firstRaw.bytes, /not a CID/);
});

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
  const bytes = firstRaw.bytes;
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
  assert.equal(await expectedRoot(firstDagPb.bytes), firstDagPb.cid);
});

async function rawCidOf(bytes) {
  return CID.createV1(RAW, await sha256.digest(bytes)).toString();
}

const SELECTOR = "5009297550715157269";
const withSelector = realLayerCids().find((cid) =>
  new TextDecoder().decode(realLayerBytes(cid)).includes(SELECTOR),
);

test("layerFromBytes keeps an integer above 2^53 exact through a round trip", async () => {
  assert.ok(withSelector, "a real layer carries a chainSelector above 2^53");

  const layer = await layerFromBytes(withSelector, realLayerBytes(withSelector));

  assert.ok(JSON.stringify(layer).includes(SELECTOR));
  assert.ok(
    !JSON.stringify(JSON.parse(new TextDecoder().decode(realLayerBytes(withSelector)))).includes(
      SELECTOR,
    ),
  );
});

test("layerFromBytes returns the registry document the bytes hold", async () => {
  const layer = await layerFromBytes(firstRaw.cid, firstRaw.bytes);

  assert.deepEqual(
    Object.keys(layer.chains),
    Object.keys(JSON.parse(new TextDecoder().decode(firstRaw.bytes)).chains),
  );
});

test("layerFromBytes refuses a flipped byte on the digest, not on a parse error", async () => {
  const tampered = flipByte(firstRaw.bytes, 0);
  assert.throws(() => JSON.parse(new TextDecoder().decode(tampered)));

  await assert.rejects(
    () => layerFromBytes(firstRaw.cid, tampered),
    (error) => error instanceof LayerVerificationError && /digest/.test(error.message),
  );
});

test("layerFromBytes refuses valid JSON that is not a registry under a matching CID", async () => {
  const bytes = new TextEncoder().encode('{"error":"rate limited"}');
  const cid = await rawCidOf(bytes);

  await verifyLayer(cid, bytes);
  await assert.rejects(
    () => layerFromBytes(cid, bytes),
    (error) => error instanceof LayerVerificationError && /no "chains" object/.test(error.message),
  );
});

test("layerFromBytes refuses bytes that are not JSON under a matching CID", async () => {
  const bytes = new TextEncoder().encode("<html>gateway error</html>");
  const cid = await rawCidOf(bytes);

  await assert.rejects(() => layerFromBytes(cid, bytes), /UTF-8 JSON/);
});

test("layerFromBytes refuses bytes that are not UTF-8 under a matching CID", async () => {
  const bytes = Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x7b, 0x7d, 0x7d]);
  const cid = await rawCidOf(bytes);

  await assert.rejects(
    () => layerFromBytes(cid, bytes),
    (error) => error instanceof LayerVerificationError && /UTF-8 JSON/.test(error.message),
  );
});

test("layerFromBytes reads a layer behind a byte order mark as a gateway response would", async () => {
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
  const bytes = new Uint8Array([...bom, ...firstRaw.bytes]);
  const cid = await rawCidOf(bytes);
  const served = await fetchRegistryFromIpfs(cid, {
    fetchImpl: async () => new Response(bytes, { status: 200 }),
  });

  const layer = await layerFromBytes(cid, bytes);

  assert.deepEqual(layer, served);
  assert.equal(
    JSON.stringify(layer),
    JSON.stringify(await layerFromBytes(firstRaw.cid, firstRaw.bytes)),
  );
});

test("layerFromBytes refuses to run without JSON source text access rather than round integers", async () => {
  const original = JSON.rawJSON;
  JSON.rawJSON = undefined;
  try {
    await assert.rejects(
      () => layerFromBytes(firstRaw.cid, firstRaw.bytes),
      (error) =>
        error instanceof Error &&
        !(error instanceof LayerVerificationError) &&
        /source text/.test(error.message),
    );
  } finally {
    JSON.rawJSON = original;
  }
  assert.equal(typeof JSON.rawJSON, "function");
});

test("layerFromBytes refuses to run when JSON.parse drops the reviver's source text", async () => {
  const original = JSON.parse;
  JSON.parse = (text, reviver) => original(text, reviver && ((key, value) => reviver(key, value)));
  try {
    await assert.rejects(
      () => layerFromBytes(firstRaw.cid, firstRaw.bytes),
      (error) =>
        error instanceof Error &&
        !(error instanceof LayerVerificationError) &&
        /source text/.test(error.message),
    );
  } finally {
    JSON.parse = original;
  }
  await layerFromBytes(firstRaw.cid, firstRaw.bytes);
});
