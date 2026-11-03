/**
 * Proving that the bytes of a registry layer are the ones its CID names.
 *
 * Gateways are not trusted: every pointer in the chain is a CID, so bytes served under one are
 * checked against it. A raw CID's digest covers the bytes; a dag-pb CID's digest covers only the
 * root block of the file's DAG, so the DAG is rebuilt from the bytes and its root compared.
 */

import { equals } from "multiformats/bytes";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

import { isRegistryDocument } from "./chain.ts";
import { assertJsonSourceText, parseJson } from "./json.ts";
import { LayerVerificationError } from "./layer-verification-error.ts";
import type { Layer } from "./types.ts";

const RAW_CODEC = 0x55;
const DAG_PB_CODEC = 0x70;
const SHA2_256_CODE = 0x12;

/** How `ipfs add` splits a file into a DAG: chunk size in bytes, and links per node. */
export interface FileLayout {
  chunkSize: number;
  linksPerNode: number;
}

/** The layout of `ipfs add --cid-version 1`, which published every dag-pb layer. */
const IPFS_ADD_LAYOUT: FileLayout = { chunkSize: 262144, linksPerNode: 174 };

/**
 * Verifies that `bytes` are the content the CID `cid` addresses, and nothing more: not who published
 * it, and nothing about the layers it points to. Pass the bytes exactly as served, before parsing;
 * re-serialised JSON fails.
 *
 * Accepts only CIDv1 in its canonical string form (lower-case base32, so one layer has one name)
 * with sha2-256 and either
 *  - the raw codec, which `ipfs add` produces for a file of at most one chunk: the digest of the
 *    bytes; or
 *  - the dag-pb codec, which it produces for a larger file: the root of the UnixFS file rebuilt
 *    from the bytes with 262144-byte chunks, raw leaves, 174 links per node, a single chunk kept
 *    as itself and no wrapping directory.
 *
 * @param cid - The layer's CID string, as it appears in a `previousRegistry.ipfsHash`
 * @param bytes - The layer exactly as a gateway served it
 * @returns Resolves when the bytes match
 * @throws {LayerVerificationError} When the bytes do not match, or the CID is a CIDv0, not in
 *   canonical form, an unparsable string, or uses a codec or hash function other than the above
 */
export async function verifyLayer(cid: string, bytes: Uint8Array): Promise<void> {
  const parsed = parseCid(cid);
  const { code, multihash } = parsed;

  if (parsed.version === 0) {
    throw new LayerVerificationError(cid, "CIDv0 is refused, only CIDv1 layers are verified");
  }
  if (parsed.toString() !== cid) {
    throw new LayerVerificationError(cid, `not in canonical form, expected ${parsed.toString()}`);
  }
  if (multihash.code !== SHA2_256_CODE) {
    throw new LayerVerificationError(
      cid,
      `hash function 0x${multihash.code.toString(16)} is refused, only sha2-256 is verified`,
    );
  }

  if (code === RAW_CODEC) {
    const digest = await sha256.digest(bytes);
    if (!equals(digest.digest, multihash.digest)) {
      throw new LayerVerificationError(cid, "the sha2-256 digest of the bytes is not the CID's");
    }
    return;
  }
  if (code === DAG_PB_CODEC) {
    const rebuilt = await unixfsFileRoot(bytes);
    if (!equals(rebuilt.bytes, parsed.bytes)) {
      throw new LayerVerificationError(
        cid,
        `rebuilding the UnixFS file from the bytes gives ${rebuilt.toString()}`,
      );
    }
    return;
  }
  throw new LayerVerificationError(
    cid,
    `codec 0x${code.toString(16)} is refused, only raw and dag-pb are verified`,
  );
}

/**
 * Verifies `bytes` against `cid` with `verifyLayer`, then parses them as a registry layer. Call it
 * inside a `fetchLayer` on the raw response bytes; see `FetchLayer`.
 *
 * A pinned head vouches for the chain under it only when every layer's bytes, as served, were
 * checked with `verifyLayer` before any parse. This is the variant that also keeps integers above
 * 2^53 (a Chainlink `chainSelector`) exact: they come back as `JSON.rawJSON` values, which
 * `JSON.stringify` writes digit for digit but which cannot be coerced to a string or number and
 * which `structuredClone` refuses. A consumer that needs plain data verifies and parses itself.
 * Needs ES2025 JSON.parse source text access.
 *
 * @param cid - The layer's CID string
 * @param bytes - The layer exactly as a gateway served it
 * @returns The parsed layer
 * @throws {LayerVerificationError} Everything `verifyLayer` throws it for (a mismatch may be one
 *   gateway's fault), and when the verified bytes are not valid UTF-8, not JSON, or not a registry
 *   document (no `chains` object), which no other gateway can fix
 * @throws {Error} A plain error when the runtime lacks JSON.parse source text access: a fault of
 *   the runtime, not a verdict on the bytes
 */
export async function layerFromBytes(cid: string, bytes: Uint8Array): Promise<Layer> {
  // Outside the try below, which turns every failure into a verdict on the bytes.
  assertJsonSourceText();
  await verifyLayer(cid, bytes);

  let document: unknown;
  try {
    // ignoreBOM false strips a leading BOM, as response.text() does.
    document = parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LayerVerificationError(cid, `the verified bytes are not UTF-8 JSON (${reason})`);
  }
  if (!isRegistryDocument(document)) {
    throw new LayerVerificationError(
      cid,
      'the verified bytes are not a registry (no "chains" object)',
    );
  }
  return document;
}

function parseCid(cid: string): CID {
  try {
    return CID.parse(cid);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LayerVerificationError(cid, `not a CID (${reason})`);
  }
}

/**
 * The root CID of `bytes` added as a UnixFS file the way `ipfs add --cid-version 1` adds it: chunks
 * of `layout.chunkSize` bytes as raw leaves, balanced under dag-pb nodes of at most
 * `layout.linksPerNode` links, and a file of one chunk kept as its raw leaf.
 *
 * Wire formats: https://ipld.io/specs/codecs/dag-pb/spec/ and
 * https://github.com/ipfs/specs/blob/main/UNIXFS.md. Not part of the package's entry point.
 *
 * @param bytes - The file
 * @param layout - Chunk size and links per node; `ipfs add`'s by default
 * @returns The root CID
 */
export async function unixfsFileRoot(
  bytes: Uint8Array,
  layout: FileLayout = IPFS_ADD_LAYOUT,
): Promise<CID> {
  if (bytes.length <= layout.chunkSize) return CID.createV1(RAW_CODEC, await sha256.digest(bytes));

  let level: DagNode[] = [];
  for (let offset = 0; offset < bytes.length; offset += layout.chunkSize) {
    const chunk = bytes.subarray(offset, offset + layout.chunkSize);
    const cid = CID.createV1(RAW_CODEC, await sha256.digest(chunk));
    level.push({ cid, tsize: chunk.length, fileSize: chunk.length });
  }
  while (level.length > 1) {
    const parents: DagNode[] = [];
    for (let start = 0; start < level.length; start += layout.linksPerNode) {
      parents.push(await fileNode(level.slice(start, start + layout.linksPerNode)));
    }
    level = parents;
  }
  return level[0]!.cid;
}

/** A node of the file DAG: its CID, the bytes of its subtree's blocks, and the file bytes under it. */
interface DagNode {
  cid: CID;
  tsize: number;
  fileSize: number;
}

// Protobuf keys, (field number << 3) | wire type, of the fields a UnixFS file node carries.
const PB_NODE_DATA = 0x0a;
const PB_NODE_LINKS = 0x12;
const PB_LINK_HASH = 0x0a;
const PB_LINK_NAME = 0x12;
const PB_LINK_TSIZE = 0x18;
const UNIXFS_TYPE = 0x08;
const UNIXFS_FILESIZE = 0x18;
const UNIXFS_BLOCKSIZE = 0x20;
const UNIXFS_TYPE_FILE = 2;

/**
 * The dag-pb node over `children`. Links precede Data, each link carries an empty Name, and the
 * UnixFS Data holds no mode or mtime: the bytes `ipfs add` writes.
 */
async function fileNode(children: DagNode[]): Promise<DagNode> {
  const links = children.flatMap(({ cid, tsize }) =>
    lengthDelimited(PB_NODE_LINKS, [
      ...lengthDelimited(PB_LINK_HASH, cid.bytes),
      ...lengthDelimited(PB_LINK_NAME, []),
      PB_LINK_TSIZE,
      ...varint(tsize),
    ]),
  );
  const fileSize = children.reduce((sum, child) => sum + child.fileSize, 0);
  const unixfs = [
    UNIXFS_TYPE,
    ...varint(UNIXFS_TYPE_FILE),
    UNIXFS_FILESIZE,
    ...varint(fileSize),
    ...children.flatMap((child) => [UNIXFS_BLOCKSIZE, ...varint(child.fileSize)]),
  ];
  const block = Uint8Array.from([...links, ...lengthDelimited(PB_NODE_DATA, unixfs)]);
  const cid = CID.createV1(DAG_PB_CODEC, await sha256.digest(block));
  const tsize = children.reduce((sum, child) => sum + child.tsize, block.length);
  return { cid, tsize, fileSize };
}

function lengthDelimited(key: number, payload: ArrayLike<number>): number[] {
  return [key, ...varint(payload.length), ...Array.from(payload)];
}

/** Unsigned LEB128, exact up to 2^53: a file size never reaches it. */
function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}
