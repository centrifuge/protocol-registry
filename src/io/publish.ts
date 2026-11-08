/**
 * Where a layer goes once it is generated: pinned to IPFS through Pinata, then served by pointing the
 * registry hostname's dnslink at it (Cloudflare Web3 gateway), and announced on Slack.
 */

import type { Network } from "../core/types.ts";
import type { FetchLike } from "./ipfs.ts";

export interface PinResult {
  cid: string;
}

/**
 * Pins a layer as a public file, named and tagged as the scripts this replaces did
 * (`registry-<network>-<version>`, keyvalues env / sha / version), so earlier pins and new ones read
 * the same in the Pinata dashboard.
 */
export async function pinLayer(
  jwt: string,
  network: Network,
  text: string,
  meta: { version: string | null; sha: string },
  fetchImpl: FetchLike = fetch,
): Promise<PinResult> {
  const label = meta.version || "unknown";
  const name = `registry-${network}-${label}`;
  const form = new FormData();
  form.append("file", new File([text], `${name}.json`, { type: "application/json" }));
  form.append("network", "public");
  // Named rather than left to Pinata's default: v1 is raw leaves, 256 KiB chunks and 174 links per
  // node, what `ipfs add --cid-version=1` gives and what verifyLayer rebuilds a dag-pb CID from
  form.append("cid_version", "v1");
  form.append("name", name);
  form.append(
    "keyvalues",
    JSON.stringify({ env: network, sha: meta.sha, ...(label !== "unknown" && { version: label }) }),
  );

  const response = await fetchImpl("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      `Pinata upload failed: ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  const { data } = (await response.json()) as { data?: { cid?: string } };
  if (!data?.cid) throw new Error(`Pinata upload returned no CID`);
  return { cid: data.cid };
}

interface Web3Hostname {
  id: string;
  name: string;
  dnslink?: string;
  status?: string;
}

async function cloudflare<T>(
  token: string,
  method: string,
  path: string,
  body: unknown,
  fetchImpl: FetchLike,
): Promise<T> {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as { success: boolean; result: T; errors?: unknown };
  if (!response.ok || !json.success) {
    throw new Error(
      `Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(json.errors)}`,
    );
  }
  return json.result;
}

export interface Web3Gateway {
  /** The CID the hostname serves, from its dnslink, or null when it carries none. */
  currentCid(hostname: string): Promise<string | null>;
  /** Points the hostname at a CID. */
  setCid(hostname: string, cid: string): Promise<void>;
}

/** The Web3 hostnames of one zone. The token needs Web3 Hostnames Write on it. */
export function web3Gateway(
  token: string,
  zoneId: string,
  fetchImpl: FetchLike = fetch,
): Web3Gateway {
  const find = async (hostname: string) => {
    const hostnames = await cloudflare<Web3Hostname[]>(
      token,
      "GET",
      `/zones/${zoneId}/web3/hostnames`,
      undefined,
      fetchImpl,
    );
    const found = hostnames.find((h) => h.name === hostname);
    if (!found) throw new Error(`Web3 hostname ${hostname} not found in zone ${zoneId}`);
    return found;
  };
  return {
    currentCid: async (hostname) =>
      (await find(hostname)).dnslink?.match(/^\/ipfs\/(.+)$/)?.[1] ?? null,
    setCid: async (hostname, cid) => {
      const { id } = await find(hostname);
      await cloudflare(
        token,
        "PATCH",
        `/zones/${zoneId}/web3/hostnames/${id}`,
        { dnslink: `/ipfs/${cid}` },
        fetchImpl,
      );
    },
  };
}

/**
 * The CID a hostname's dnslink names, read from public DNS (`_dnslink.<hostname>`, which Cloudflare
 * keeps in step with the Web3 hostname). Needs no credentials, so a Worker that only generates never
 * holds the token that can change it. DNS may trail a swap by its TTL; publishing reads the API.
 */
export async function dnslinkCid(
  hostname: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const response = await fetchImpl(
    `https://cloudflare-dns.com/dns-query?name=_dnslink.${hostname}&type=TXT`,
    { headers: { Accept: "application/dns-json" } },
  );
  if (!response.ok)
    throw new Error(`DNS lookup of _dnslink.${hostname} failed: ${response.status}`);
  const { Answer = [] } = (await response.json()) as { Answer?: { type: number; data: string }[] };
  for (const answer of Answer) {
    const match = answer.data.replace(/"/g, "").match(/^dnslink=\/ipfs\/(.+)$/);
    if (match) return match[1];
  }
  return null;
}

/** Posts to the Slack channel behind an incoming webhook. Text is Slack mrkdwn. */
export async function notifySlack(
  webhookUrl: string | undefined,
  text: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (!webhookUrl) return;
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`Slack webhook failed: ${response.status}`);
}
