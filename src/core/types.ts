/**
 * Shapes of the documents the generator reads and writes. The published schema is documented in
 * the README of centrifuge/protocol-registry ("Schema"); these types follow it, loosened where
 * old layers or env files are looser.
 */

export type Network = "mainnet" | "testnet";

export const NETWORKS: readonly Network[] = ["mainnet", "testnet"];

/** A contract entry as env records it or a layer publishes it. A bare string is an old shorthand. */
export type ContractEntry =
  | string
  | {
      address: string | null;
      blockNumber?: number | null;
      txHash?: string | null;
      version?: string;
    };

/** What a chain publishes under `retired`, keyed by lowercase address. */
export interface RetiredEntry {
  contract: string;
  blockNumber?: number;
  endBlock: number;
}

export interface LayerChain {
  network?: Record<string, unknown>;
  adapters?: Record<string, unknown>;
  contracts?: Record<string, ContractEntry>;
  retired?: Record<string, RetiredEntry>;
  deployment?: { deployedAt: number | null; startBlock: number | null };
}

/** One published registry document. */
export interface Layer {
  network?: string;
  version?: string | null;
  deploymentInfo?: { gitCommit?: string | null };
  previousRegistry?: { version: string | null; ipfsHash: string | null } | null;
  abis?: Record<string, unknown>;
  chains: Record<string, LayerChain>;
}

/** One chain's state with every layer merged, newest winning. */
export interface AccumulatedChain {
  network?: Record<string, unknown>;
  adapters?: Record<string, unknown>;
  contracts: Record<string, ContractEntry>;
  retired?: Record<string, RetiredEntry>;
}

export type AccumulatedState = Record<string, AccumulatedChain>;

/** A retirement declaration from `env/<environment>/retired.json`, under a version or an address. */
export interface RetirementDeclaration {
  endBlock: number;
  except?: string[];
  reason?: string;
}

/** network name → (registry version or address → declaration) */
export type Retirements = Record<string, Record<string, RetirementDeclaration>>;

/** A network config, `env/<environment>/<network>.json`, written by the deploy scripts. */
export interface EnvConfig {
  network: {
    chainId: number;
    environment: string;
    namespace?: string;
    [field: string]: unknown;
  };
  adapters?: Record<string, Record<string, unknown>>;
  contracts?: Record<string, ContractEntry>;
  deploymentInfo?: Record<string, DeploymentRecord>;
}

export interface DeploymentRecord {
  gitCommit?: string;
  startBlock?: number;
  timestamp?: string | number;
  deployedAt?: string | number;
  version?: string;
  [field: string]: unknown;
}

/** A finding on a generated registry, as the Registry Preview reports it. */
export interface Finding {
  path: string;
  message: string;
}
