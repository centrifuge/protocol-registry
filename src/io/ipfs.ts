/**
 * Reading published registry layers from IPFS.
 *
 * Every reader of a published layer goes through here: CID validation, the multi-gateway fetch, the
 * check of each layer's bytes against its CID, and the layer cache. Keeping one copy matters because
 * the gateway list rots (cloudflare-ipfs.com was retired in 2024) and a caller left holding a stale
 * copy fails in a way that looks like IPFS being down.
 *
 * Published layers are content-addressed, so a CID's contents can never change, and a cached layer is
 * valid forever — without the cache a chain walk re-fetches every layer on every run (testnet is ~50
 * layers) and public gateways rate-limit.
 *
 * Neither a gateway nor the cache is trusted with the bytes. A forged ancestor would have the
 * generator measure its delta against state nobody published, so every layer, wherever it came from,
 * is verified against the CID it was asked for before it is parsed.
 */

import { LayerVerificationError } from "../core/layer-verification-error.ts";
import type { Layer } from "../core/types.ts";
import { layerFromBytes } from "../core/verify.ts";

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

/**
 * Where fetched layers are kept, by CID, as the bytes a gateway served: verification needs them
 * exactly. R2 in the Worker, a directory for local runs.
 */
export interface LayerCache {
  get(cid: string): Promise<Uint8Array | null>;
  put(cid: string, bytes: Uint8Array): Promise<void>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

/**
 * Reads a cached layer, or null on a miss. An entry that does not verify against its CID is a miss:
 * the gateway fetch that follows overwrites it, so a corrupt or poisoned entry cannot outlive a run
 * that can reach IPFS.
 */
async function readCachedLayer(cache: LayerCache, cid: string): Promise<Layer | null> {
  try {
    const bytes = await cache.get(cid);
    return bytes == null ? null : await layerFromBytes(cid, bytes);
  } catch {
    return null;
  }
}

/**
 * Fetches a single registry layer from the cache, or from IPFS trying each gateway in turn. Either
 * way the bytes are verified against `cid` with `layerFromBytes` before they are parsed: a gateway
 * serving other bytes is skipped like one that is down, and only verified bytes are cached.
 *
 * @throws {LayerVerificationError} If no gateway served matching bytes and at least one served
 *   other bytes. A chain walk makes it fatal: evidence against the layer, not an outage
 * @throws If every gateway fails otherwise, or the CID is not a plain CID
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
  let mismatched = false;

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
      // A gateway can serve anything for a CID: an error page, a different pinned file, a forged
      // layer. layerFromBytes refuses all of them, so none enters the cache or the walk.
      const bytes = new Uint8Array(await response.arrayBuffer());
      const document = await layerFromBytes(cid, bytes);
      log(`  Layer ${cid} — fetched from ${gateway}`);
      if (cache) {
        // Caching is an optimization; a failed write must not fail the fetch that already succeeded.
        await cache.put(cid, bytes).catch(() => {});
      }
      return document;
    } catch (error) {
      if (error instanceof LayerVerificationError) mismatched = true;
      failures.push(`${gateway} → ${(error as Error).message}`);
    }
  }

  const tried = failures.join("; ");
  if (mismatched) {
    throw new LayerVerificationError(cid, `no gateway served matching bytes (${tried})`);
  }
  throw new Error(`could not fetch ${cid} from any gateway (${tried})`);
}

/** Releases a response body we are not going to read, never throwing over it. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel?.();
  } catch {
    // Already errored or consumed; nothing to release.
  }
}
