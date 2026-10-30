/**
 * Proving that the bytes of a registry layer are the ones its CID names.
 *
 * Gateways are not trusted: every pointer in the chain is a CID, so bytes served under one are
 * checked against it. A raw CID's digest covers the bytes; a dag-pb CID's digest covers only the
 * root block of the file's DAG, so the DAG is rebuilt from the bytes and its root compared. The
 * rebuild is pure computation: no block is stored and nothing is fetched.
 */

import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { equals } from "multiformats/bytes";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

import { isRegistryDocument } from "./chain.ts";
import { parseJson } from "./json.ts";
import { LayerVerificationError } from "./layer-verification-error.ts";
import type { Layer } from "./types.ts";

const RAW_CODEC = 0x55;
const DAG_PB_CODEC = 0x70;
const SHA2_256_CODE = 0x12;

// The `ipfs add --cid-version 1` parameters, passed explicitly so a moved library default cannot
// change CIDs.
const CHUNK_SIZE_BYTES = 262144;
const LINKS_PER_NODE = 174;

const discardingBlockstore = { put: async (key: CID) => key };

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
 * @throws {Error} A plain error when the importer yields nothing: a library fault, not a verdict
 *   on the bytes
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
    const rebuilt = await rebuildRoot(bytes);
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

/** Whether JSON.parse gives revivers the source text and JSON.rawJSON exists (what parseJson uses). */
function hasJsonSourceText(): boolean {
  let hasSource = false;
  JSON.parse("1", (_key, value, context?: { source?: string }) => {
    hasSource = context?.source === "1";
    return value;
  });
  return hasSource && typeof JSON.rawJSON === "function";
}

/**
 * Verifies `bytes` against `cid` with `verifyLayer`, then parses them as a registry layer. Call it
 * inside a `fetchLayer` on the raw response bytes; see `FetchLayer`.
 *
 * Integers above 2^53 (a Chainlink `chainSelector`) come back as `JSON.rawJSON` values:
 * `JSON.stringify` writes their exact digits and `.rawJSON` holds them as a string, but they cannot
 * be coerced to a string or number and `structuredClone` refuses them. Needs ES2025 JSON.parse
 * source text access: without it `layerFromBytes` throws, for any layer.
 *
 * @param cid - The layer's CID string
 * @param bytes - The layer exactly as a gateway served it
 * @returns The parsed layer
 * @throws {LayerVerificationError} Everything `verifyLayer` throws it for (a mismatch may be one
 *   gateway's fault), and when the verified bytes are not valid UTF-8, not JSON, or not a registry
 *   document (no `chains` object), which no other gateway can fix
 * @throws {Error} A plain error when the runtime lacks JSON.parse source text access, or the
 *   importer yields nothing: faults of the runtime or library, not verdicts on the bytes
 */
export async function layerFromBytes(cid: string, bytes: Uint8Array): Promise<Layer> {
  // Without source text access parseJson rounds integers above 2^53 and the layer still looks
  // verified.
  if (!hasJsonSourceText()) {
    throw new Error("layerFromBytes needs JSON.parse source text access (ES2025)");
  }
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

async function rebuildRoot(bytes: Uint8Array): Promise<CID> {
  const entries = importer([{ content: bytes }], discardingBlockstore, {
    cidVersion: 1,
    rawLeaves: true,
    reduceSingleLeafToSelf: true,
    wrapWithDirectory: false,
    chunker: fixedSize({ chunkSize: CHUNK_SIZE_BYTES }),
    layout: balanced({ maxChildrenPerNode: LINKS_PER_NODE }),
  });
  // The root is the last entry the importer yields, as it is the last line `ipfs add` prints.
  let root: CID | null = null;
  for await (const entry of entries) root = entry.cid;
  if (root === null) throw new Error("the importer yielded no entry");
  return root;
}
