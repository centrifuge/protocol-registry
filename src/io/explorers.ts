/**
 * Contract creation blocks from block explorers, for contracts env records without a blockNumber.
 *
 * Etherscan's v2 API covers most chains with one key. BNB and Base are not on the free tier, so they
 * get nothing and keep whatever env records; Avalanche and Plume have explorers of their own.
 */

import type { FetchLike } from "./ipfs.ts";

/** Chains the free Etherscan v2 tier does not serve; env must carry their blockNumbers. */
const UNSUPPORTED_ETHERSCAN_CHAINS = new Set([
  56, // BNB Smart Chain mainnet
  97, // BNB Smart Chain testnet
  8453, // Base mainnet
  84532, // Base Sepolia
]);

const AVALANCHE = 43114;
const PLUME = 98866;

/** Etherscan allows a few calls a second on the free tier. */
const API_DELAY_MS = 250;

export interface ExplorerOptions {
  etherscanApiKey: string | null;
  fetchImpl?: FetchLike;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function etherscanCreationBlock(
  chainId: number,
  address: string,
  options: Required<ExplorerOptions>,
  retried = false,
): Promise<number | null> {
  const url =
    `https://api.etherscan.io/v2/api?apikey=${options.etherscanApiKey}&chainid=${chainId}` +
    `&module=contract&action=getcontractcreation&contractaddresses=${address}`;
  const data = (await (await options.fetchImpl(url)).json()) as {
    status?: string;
    message?: string;
    result?: unknown;
  };

  if (data.status === "1" && Array.isArray(data.result) && data.result.length > 0) {
    return toBlock((data.result[0] as { blockNumber?: unknown }).blockNumber);
  }
  if (data.status === "0") {
    if (data.message === "No data found") {
      // CREATE3 contracts often have no creation record; expected
      options.log(`    ℹ ${address}: no creation record on Etherscan (probably CREATE3)`);
    } else if (String(data.result).includes("rate limit") && !retried) {
      options.log(`    ⚠ Etherscan rate limit hit, waiting...`);
      await options.sleep(2000);
      return etherscanCreationBlock(chainId, address, options, true);
    } else {
      options.log(`    ⚠ Etherscan error: ${data.result || data.message || "unknown"}`);
    }
  }
  return null;
}

async function routescanCreationBlock(
  address: string,
  options: Required<ExplorerOptions>,
): Promise<number | null> {
  const base = `https://api.routescan.io/v2/network/mainnet/evm/${AVALANCHE}`;
  const data = (await (
    await options.fetchImpl(
      `${base}/etherscan/api?module=contract&action=getcontractcreation&contractaddresses=${address}`,
    )
  ).json()) as { status?: string; result?: { txHash?: string }[] };
  const txHash = data.status === "1" ? data.result?.[0]?.txHash : undefined;
  if (!txHash) return null;
  const tx = (await (await options.fetchImpl(`${base}/transactions/${txHash}`)).json()) as {
    blockNumber?: unknown;
  };
  return toBlock(tx.blockNumber);
}

async function plumeCreationBlock(
  address: string,
  options: Required<ExplorerOptions>,
): Promise<number | null> {
  const base = "https://explorer-plume-mainnet-1.t.conduit.xyz/api/v2";
  const account = (await (await options.fetchImpl(`${base}/addresses/${address}`)).json()) as {
    creation_transaction_hash?: string;
  };
  const txHash = account.creation_transaction_hash;
  if (!txHash) return null;
  const tx = (await (await options.fetchImpl(`${base}/transactions/${txHash}`)).json()) as {
    block_number?: unknown;
  };
  return toBlock(tx.block_number);
}

function toBlock(value: unknown): number | null {
  const block = Number(value);
  return value != null && Number.isInteger(block) && block > 0 ? block : null;
}

/**
 * A `creationBlock` for the generator: null wherever no explorer answers, never a throw, since a
 * missing block falls back to the chain's deployment startBlock rather than failing a publish.
 */
export function explorerCreationBlocks(
  options: ExplorerOptions,
): (chainId: number, address: string) => Promise<number | null> {
  const resolved: Required<ExplorerOptions> = {
    fetchImpl: fetch,
    log: () => {},
    sleep: defaultSleep,
    ...options,
  };

  return async (chainId, address) => {
    if (UNSUPPORTED_ETHERSCAN_CHAINS.has(chainId)) return null;
    if (chainId !== AVALANCHE && chainId !== PLUME && !resolved.etherscanApiKey) return null;
    try {
      if (chainId === AVALANCHE) return await routescanCreationBlock(address, resolved);
      if (chainId === PLUME) return await plumeCreationBlock(address, resolved);
      return await etherscanCreationBlock(chainId, address, resolved);
    } catch (error) {
      resolved.log(`    ⚠ Explorer lookup failed for ${address}: ${(error as Error).message}`);
      return null;
    } finally {
      await resolved.sleep(API_DELAY_MS);
    }
  };
}
