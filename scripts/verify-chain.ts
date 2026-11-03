/**
 * Verifies every layer of a live registry chain against its CID, through the IPFS gateways.
 *
 *     node scripts/verify-chain.ts <mainnet|testnet> [--head <cid>]
 *
 * Starts at the CID the network's hostname serves, or `--head`, and follows each layer's
 * `previousRegistry.ipfsHash` to the base snapshot. Bytes come from `IPFS_GATEWAYS` in order; a
 * gateway whose bytes fail verification is skipped like one that is down. Prints one line per layer
 * and a count, and exits 1 naming the CID of a layer no gateway served verifiable bytes for.
 */

import { parseArgs } from "node:util";

import { CID } from "multiformats/cid";

import { DEFAULT_MAX_DEPTH } from "../src/core/chain.ts";
import { NETWORKS, type Layer, type Network } from "../src/core/types.ts";
import { layerFromBytes } from "../src/core/verify.ts";
import { IPFS_GATEWAYS } from "../src/io/ipfs.ts";
import { HOSTNAMES, liveCid } from "./live-cid.ts";

const FETCH_TIMEOUT_MS = 30000;
const RAW_CODEC = 0x55;

interface VerifiedLayer {
  layer: Layer;
  size: number;
  gateway: string;
}

/** The first gateway's bytes that verify against `cid`, parsed; throws naming the CID otherwise. */
async function fetchVerified(cid: string): Promise<VerifiedLayer> {
  const failures: string[] = [];
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const response = await fetch(`${gateway}${cid}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { layer: await layerFromBytes(cid, bytes), size: bytes.length, gateway };
    } catch (error) {
      failures.push(`${gateway} → ${(error as Error).message}`);
    }
  }
  throw new Error(`layer ${cid} verified from no gateway\n  ${failures.join("\n  ")}`);
}

async function verifyChain(head: string): Promise<{ raw: number; dagPb: number }> {
  const counts = { raw: 0, dagPb: 0 };
  const seen = new Set<string>();
  let cid: string | null = head;
  while (cid) {
    if (seen.has(cid)) throw new Error(`layer ${cid} appears twice in the chain`);
    if (seen.size >= DEFAULT_MAX_DEPTH) throw new Error(`chain longer than ${DEFAULT_MAX_DEPTH}`);
    seen.add(cid);

    const { layer, size, gateway } = await fetchVerified(cid);
    const isRaw = CID.parse(cid).code === RAW_CODEC;
    counts[isRaw ? "raw" : "dagPb"]++;
    console.log(`${cid} ${isRaw ? "raw" : "dag-pb"} ${size} bytes from ${gateway}`);
    cid = layer.previousRegistry?.ipfsHash ?? null;
  }
  return counts;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { head: { type: "string" } },
});
const network = positionals[0] as Network;
if (!NETWORKS.includes(network)) {
  console.error("usage: node scripts/verify-chain.ts <mainnet|testnet> [--head <cid>]");
  process.exit(2);
}

const head = values.head ?? (await liveCid(HOSTNAMES[network]));
if (!head) {
  console.error(`${HOSTNAMES[network]} serves no CID`);
  process.exit(1);
}

try {
  const { raw, dagPb } = await verifyChain(head);
  console.log(
    `${network}: ${raw + dagPb} layers verified (${raw} raw, ${dagPb} dag-pb) from ${head}`,
  );
} catch (error) {
  console.error(`${network}: ${(error as Error).message}`);
  process.exit(1);
}
