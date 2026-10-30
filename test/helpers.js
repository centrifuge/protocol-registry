/**
 * @fileoverview Fixture builders for the registry script tests.
 *
 * Most registry documents are small enough to build inline, which keeps each test's input visible
 * next to its assertions. The real published layers of both chains live under
 * test/fixtures/layers/ and are read through the helpers at the bottom.
 */

import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fetchRegistryFromIpfs } from "../src/io/ipfs.ts";

/**
 * Builds a contract entry. `address: null` produces a tombstone.
 */
export function contract(address, blockNumber = 100, txHash = "0xtx") {
  return address === null
    ? { address: null, blockNumber: null, txHash: null }
    : { address, blockNumber, txHash };
}

/**
 * Builds a chain entry from a { name: address | entry } map.
 */
export function chain(contracts, extra = {}) {
  const built = {};
  for (const [name, value] of Object.entries(contracts)) {
    built[name] = typeof value === "object" && value !== null ? value : contract(value);
  }
  return { contracts: built, ...extra };
}

/**
 * Builds a registry layer.
 *
 * @param {Object} opts
 * @param {string|null} [opts.version] - Layer version; null models a patch layer
 * @param {Object} [opts.chains] - chainId → chain entry
 * @param {string|null} [opts.previousCid] - previousRegistry.ipfsHash; omit for a base snapshot
 * @param {string} [opts.previousVersion]
 * @param {Object|null} [opts.previousRegistry] - Set explicitly to model a malformed pointer
 * @param {string|null} [opts.network] - Declared network; null omits the field entirely, modelling
 *        a layer published before it existed
 */
export function layer({
  version = "v1",
  chains = {},
  previousCid,
  previousVersion = "v0",
  previousRegistry,
  network = "mainnet",
}) {
  const doc = { version, chains, deploymentInfo: { gitCommit: "abc123" } };
  if (network !== null) doc.network = network;
  if (previousRegistry !== undefined) {
    doc.previousRegistry = previousRegistry;
  } else if (previousCid) {
    doc.previousRegistry = { version: previousVersion, ipfsHash: previousCid };
  } else {
    doc.previousRegistry = null;
  }
  return doc;
}

/**
 * Builds a fetch-shaped function serving documents by CID, with failure injection.
 *
 * @param {Object} cidMap - CID → document (or Error to throw for that CID)
 * @param {Object} [options]
 * @param {string[]} [options.failGateways] - Gateway substrings that always fail
 * @param {number} [options.failStatus] - Status returned by failing gateways (default 500)
 * @returns {{fetchImpl: Function, calls: string[]}}
 */
export function fakeFetch(cidMap, options = {}) {
  const { failGateways = [], failStatus = 500 } = options;
  const calls = [];

  async function fetchImpl(url) {
    calls.push(url);

    if (failGateways.some((gateway) => url.includes(gateway))) {
      return { ok: false, status: failStatus, statusText: "Injected failure" };
    }

    const cid = url.split("/").pop();
    const document = cidMap[cid];
    if (document instanceof Error) throw document;
    if (!document) return { ok: false, status: 404, statusText: "Not Found" };

    return {
      ok: true,
      status: 200,
      json: async () => structuredClone(document),
      text: async () => JSON.stringify(document),
    };
  }

  return { fetchImpl, calls };
}

/**
 * A layer cache held in memory, with the entries it holds exposed for assertions.
 */
export function memoryCache(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: async (cid) => store.get(cid) ?? null,
    put: async (cid, text) => {
      store.set(cid, text);
    },
  };
}

/**
 * The chain walk's layer fetcher, over a fake fetch and no cache.
 */
export function ipfsFetcher(fetchImpl = fakeFetch({}).fetchImpl) {
  return (cid) => fetchRegistryFromIpfs(cid, { fetchImpl });
}

const LAYER_FIXTURES = new URL("./fixtures/layers/", import.meta.url);

/** Head of the mainnet chain the fixtures hold. */
export const MAINNET_HEAD = "bafkreig62ekjinmxgc47a262ohy7l3vk7r4xqibbdi3xmhdqgknbfx4xpi";
/** Head of the testnet chain the fixtures hold. */
export const TESTNET_HEAD = "bafkreifwkz42zr3vxqo3767ifis32nuhsfbm4h7ubd5aei45wthawxdumm";
/** The mainnet layer published before the last two; the head's grandparent. */
export const OLD_MAINNET_HEAD = "bafkreif3upmmqo5ulmu2clbgkgoy2w5qtw5frrm5hzj5tqme4rczlpgf7m";

/** Every CID that has a real layer committed under test/fixtures/layers/. */
export function realLayerCids() {
  return readdirSync(LAYER_FIXTURES)
    .filter((name) => name.endsWith(".json.gz"))
    .map((name) => name.slice(0, -".json.gz".length))
    .sort();
}

/** The bytes a gateway served for this CID, exactly as committed. */
export function realLayerBytes(cid) {
  return new Uint8Array(gunzipSync(readFileSync(new URL(`${cid}.json.gz`, LAYER_FIXTURES))));
}

/** The parsed document of a real layer. */
export function realLayer(cid) {
  return JSON.parse(new TextDecoder().decode(realLayerBytes(cid)));
}

/**
 * Every real layer from a head back to its base snapshot, newest first, with the bytes each CID
 * addresses.
 */
export function realChain(headCid) {
  const chain = [];
  let cid = headCid;
  while (cid) {
    const bytes = realLayerBytes(cid);
    chain.push({ cid, bytes });
    cid = JSON.parse(new TextDecoder().decode(bytes)).previousRegistry?.ipfsHash ?? null;
  }
  return chain;
}

/**
 * A fetch-shaped function serving the real layer bytes by CID, as a gateway would; an unknown CID
 * is a 404. Plug it into fetchRegistryFromIpfs for the exact parse path a gateway response takes.
 *
 * @returns {{fetchImpl: Function, calls: string[]}} `calls` holds the CID of each request
 */
export function realLayerFetch() {
  const known = new Set(realLayerCids());
  const calls = [];

  async function fetchImpl(url) {
    const cid = url.split("/").pop();
    calls.push(cid);
    if (!known.has(cid)) return new Response("not found", { status: 404 });
    return new Response(realLayerBytes(cid), { status: 200 });
  }

  return { fetchImpl, calls };
}
