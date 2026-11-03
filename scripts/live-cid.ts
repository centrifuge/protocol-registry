/**
 * The CID each network's registry hostname serves, read from its dnslink in public DNS, for the
 * local scripts. The Worker reads the same hostnames from `wrangler.jsonc`.
 */

import { resolveTxt } from "node:dns/promises";

import type { Network } from "../src/core/types.ts";

export const HOSTNAMES: Record<Network, string> = {
  mainnet: "registry.centrifuge.io",
  testnet: "registry.testnet.centrifuge.io",
};

/** The CID `_dnslink.<hostname>` names, or null when it names none. */
export async function liveCid(hostname: string): Promise<string | null> {
  for (const record of await resolveTxt(`_dnslink.${hostname}`)) {
    const match = record.join("").match(/^dnslink=\/ipfs\/(.+)$/);
    if (match) return match[1];
  }
  return null;
}
