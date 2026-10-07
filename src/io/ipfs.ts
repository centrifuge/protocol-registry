/**
 * Reading published registry layers from IPFS.
 *
 * Every reader of a published layer goes through here: CID validation, the multi-gateway fetch, and
 * the layer cache. Keeping one copy matters because the gateway list rots (cloudflare-ipfs.com was
 * retired in 2024) and a caller left holding a stale copy fails in a way that looks like IPFS being
 * down.
 *
 * Published layers are content-addressed, so a CID's contents can never change, and a cached layer is
 * valid forever — without the cache a chain walk re-fetches every layer on every run (testnet is ~50
 * layers) and public gateways rate-limit.
 */

import { isRegistryDocument } from "../core/chain.ts";
import { parseJson } from "../core/json.ts";
import type { Layer } from "../core/types.ts";

/**
 * IPFS gateways to try, in order. Centrifuge's dedicated Pinata gateway first (registries are pinned
 * to that account, so it serves them without the public rate limits), then the shared Pinata gateway
 * and public fallbacks so one gateway's weather cannot truncate a chain walk.
 */
export const IPFS_GATEWAYS = [
  "https://centrifuge-files.mypinata.cloud/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
];

const FETCH_TIMEOUT_MS = 20000;

/** Where fetched layers are kept, by CID. R2 in the Worker, a directory for local runs. */
export interface LayerCache {
  get(cid: string): Promise<string | null>;
  put(cid: string, text: string): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Validates that a string is an IPFS CID: v0 (Qm...) or v1 (baf...). */
export function isValidIpfsHash(input: unknown): boolean {
  if (!input || typeof input !== "string") return false;

  // v0: Qm followed by 44 base58 characters (base58 excludes 0, O, I, l).
  // v1: baf followed by 50+ base32 characters; kept permissive to tolerate other encodings.
  const base58Char = "[1-9A-HJ-NP-Za-km-z]";
  const cidV0Pattern = new RegExp(`^Qm${base58Char}{44}$`);
  const cidV1Pattern = /^baf[a-z0-9]{50,}$/i;

  return cidV0Pattern.test(input) || cidV1Pattern.test(input);
}

/**
 * Reports whether a CID is a plain path segment, safe to interpolate into a gateway URL and a cache
 * key.
 *
 * Not every CID reaching the fetch is hand-supplied: chain pointers come out of published documents
 * and the live CID out of a dnslink record. Real CIDs are alphanumeric, so requiring a single segment
 * costs nothing and keeps a value carrying path separators from reaching outside the layer cache.
 */
export function isPlainCid(cid: unknown): cid is string {
  return typeof cid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(cid);
}

export interface FetchLayerOptions {
  fetchImpl?: FetchLike;
  gateways?: string[];
  timeoutMs?: number;
  cache?: LayerCache | null;
  log?: (message: string) => void;
}

/** Reads a cached layer, or null on a miss. A corrupt entry is a miss, so it cannot poison later runs. */
async function readCachedLayer(cache: LayerCache, cid: string): Promise<Layer | null> {
  try {
    const text = await cache.get(cid);
    if (text == null) return null;
    const cached = parseJson(text);
    return isRegistryDocument(cached) ? cached : null;
  } catch {
    return null;
  }
}

/**
 * Fetches a single registry document from IPFS, trying each gateway in turn.
 *
 * @throws If every gateway fails, or the CID is not a plain CID
 */
export async function fetchRegistryFromIpfs(
  cid: string,
  options: FetchLayerOptions = {},
): Promise<Layer> {
  const {
    fetchImpl = fetch,
    gateways = IPFS_GATEWAYS,
    timeoutMs = FETCH_TIMEOUT_MS,
    cache = null,
    log = () => {},
  } = options;

  // Before the cache is touched and before any gateway is contacted: the CID becomes both a cache key
  // and a URL below, and a chain pointer is only as trustworthy as the layer carrying it.
  if (!isPlainCid(cid)) {
    throw new Error(`${JSON.stringify(cid)} is not a plain CID — refusing to fetch it`);
  }

  if (cache) {
    const cached = await readCachedLayer(cache, cid);
    if (cached) {
      log(`  Layer ${cid} — cache hit`);
      return cached;
    }
  }

  const failures: string[] = [];

  for (const gateway of gateways) {
    try {
      const response = await fetchImpl(`${gateway}${cid}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        failures.push(`${gateway} → ${response.status} ${response.statusText}`);
        // Nothing reads an error page, but leaving it undrained holds the connection.
        await discardBody(response);
        continue;
      }
      const text = await response.text();
      const document = parseJson(text);
      // A gateway can serve anything for a CID (an error page rendered as JSON, a different pinned
      // file). Reject non-registry documents here so they neither enter the layer cache nor get
      // flattened as an empty layer — which would silently understate the published state and
      // inflate the delta.
      if (!isRegistryDocument(document)) {
        failures.push(`${gateway} → served a document with no "chains" object`);
        continue;
      }
      log(`  Layer ${cid} — fetched from ${gateway}`);
      if (cache) {
        // Caching is an optimization; a failed write must not fail the fetch that already succeeded.
        await cache.put(cid, text).catch(() => {});
      }
      return document;
    } catch (error) {
      failures.push(`${gateway} → ${(error as Error).message}`);
    }
  }

  throw new Error(`could not fetch ${cid} from any gateway (${failures.join("; ")})`);
}

/** Releases a response body we are not going to read, never throwing over it. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel?.();
  } catch {
    // Already errored or consumed; nothing to release.
  }
}

/** The same layer without its ABI bodies: a chain walk needs which ABIs a layer carries, not them. */
export function slimLayer(layer: Layer): Layer {
  if (!layer.abis) return layer;
  return { ...layer, abis: Object.fromEntries(Object.keys(layer.abis).map((name) => [name, []])) };
}
