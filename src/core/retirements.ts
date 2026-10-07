/**
 * Retirement: the point at which the registry stops asking an indexer to listen to an address.
 *
 * A contract leaves env for many reasons that are not retirement: a release's REPLACE run drops every
 * contract it did not redeploy, a cleanup removes a key, a fresh config records only root. None of
 * those mean the contract stopped emitting events anyone needs, so absence never retires anything
 * (see ./delta.ts). Retirement is declared instead, per chain, in `env/<dir>/retired.json` beside the
 * network configs (see ./env.ts, retirementsOf), in one of two forms:
 *
 *     "ethereum": {
 *       "v3.2.0": { "endBlock": 25900000 },
 *       "0x2539e60b0b50d7bd004a09e9d2b7e8c86eb0aaf6": { "endBlock": 26000000 }
 *     }
 *
 * A version closes every address the chain's layers published at or before the last layer carrying
 * that version; an address closes that one address. Both publish the same thing under the chain:
 *
 *     "retired": { "0xabc…": { "contract": "hub", "blockNumber": 24319303, "endBlock": 25900000 } }
 *
 * keyed by lowercase address, because an address is what a listener is bound to, while a name is
 * reused across releases (`hub` names the v3.2 hub and then the v3.3 one).
 *
 * A version declaration does not close an address that
 *   - env still lists under any key (still current; Root, kept across a release, among them),
 *   - a later layer publishes again (re-registered, so current in a newer release),
 *   - `except` names, by contract name or by address,
 *   - a tombstone (`address: null`) under its name shadowed before that layer: retired the old way,
 *     with no end block to give, and left to the consumer's existing handling.
 *
 * The file is a ledger: declarations stay and are evaluated on every publish, so they are idempotent.
 * An address already published with the same end block is in force and not emitted again; a
 * declaration that closes nothing new for that reason is noted, not warned about. A different end
 * block is emitted again, as a correction. An address declaration takes precedence over a version
 * declaration for that address.
 *
 * A version key is the exact `version` label of a published layer, and only `vX.Y.Z` labels are
 * accepted: of the labels published so far (`3`, `v3.1`, `v3.1-rev2`, `v3.1.0`, `v3.2.0`) that is
 * `v3.1.0` and `v3.2.0`. Anything older is reached by address.
 *
 * Declarations are validated against what the chain actually published: an end block cannot precede
 * an address's deploy block, a version nothing published cannot be retired, an address never
 * published or still in env cannot be retired, and an `except` entry that matches nothing is an
 * error rather than a silent no-op, since a typo there would close what it meant to protect.
 */

import { addressOf } from "./delta.ts";
import type { ContractEntry, Layer, RetiredEntry } from "./types.ts";

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const REGISTRY_VERSION_REGEX = /^v\d+\.\d+\.\d+$/;

function blockNumberOf(entry: ContractEntry): number | null {
  return typeof entry === "string" ? null : (entry?.blockNumber ?? null);
}

function normalizeAddress(address: string | null | undefined): string | null {
  return typeof address === "string" ? address.toLowerCase() : null;
}

function isTombstone(entry: ContractEntry): boolean {
  return entry !== null && typeof entry === "object" && entry.address === null;
}

/** Whether a `retired` key declares one address rather than a version. */
export function isAddressDeclaration(key: string): boolean {
  return ADDRESS_REGEX.test(key);
}

/**
 * The shape errors of one declaration, as the env schema check reports them. Meaning (does the
 * version exist, is the address published, does `except` match anything) is checked against the
 * published chain by {@link computeChainRetirements} instead.
 *
 * @param key - A registry version or an address
 * @param label - Prefix for messages, e.g. `ethereum`
 */
export function declarationErrors(key: string, declaration: unknown, label = ""): string[] {
  const errors: string[] = [];
  const at = `${label ? `${label}.` : ""}${key}`;
  const isVersion = REGISTRY_VERSION_REGEX.test(key);
  const isAddress = ADDRESS_REGEX.test(key);
  if (!isVersion && !isAddress) {
    errors.push(
      `"${at}": key must be a published registry version like "v3.2.0" or a 20-byte hex address`,
    );
  }
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
    errors.push(`"${at}" must be an object with "endBlock"`);
    return errors;
  }
  const fields = declaration as Record<string, unknown>;
  const allowed = isVersion ? ["endBlock", "except", "reason"] : ["endBlock", "reason"];
  for (const field of Object.keys(fields)) {
    if (!allowed.includes(field)) {
      errors.push(
        `"${at}.${field}": unknown key, expected ${allowed.map((f) => `"${f}"`).join(" or ")}`,
      );
    }
  }
  if (!Number.isInteger(fields.endBlock) || (fields.endBlock as number) < 1) {
    errors.push(
      `"${at}.endBlock" must be a positive integer, got ${JSON.stringify(fields.endBlock)}`,
    );
  }
  if (fields.reason != null && typeof fields.reason !== "string") {
    errors.push(`"${at}.reason" must be a string when present`);
  }
  if (fields.except != null) {
    if (
      !Array.isArray(fields.except) ||
      fields.except.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      errors.push(`"${at}.except" must be an array of contract names or addresses`);
    }
  }
  return errors;
}

export interface AddressRecord {
  /** The name it was last published under. */
  contract: string;
  /** Every name it was published under. */
  names: Set<string>;
  blockNumber: number | null;
  firstLayer: number;
  lastLayer: number;
}

export interface AddressHistory {
  /** Keyed by lowercase address. */
  addresses: Map<string, AddressRecord>;
  /** Contract name → the layer indices that set it to `address: null`. */
  tombstones: Map<string, number[]>;
}

/**
 * Every address a chain's layers published live, with where and under which names, plus where each
 * name was tombstoned.
 *
 * @param layers - Registry documents ordered oldest → newest
 */
export function chainAddressHistory(layers: Layer[], chainId: string): AddressHistory {
  const addresses = new Map<string, AddressRecord>();
  const tombstones = new Map<string, number[]>();

  layers.forEach((layer, index) => {
    const contracts = layer?.chains?.[chainId]?.contracts || {};
    for (const [name, entry] of Object.entries(contracts)) {
      if (isTombstone(entry)) {
        if (!tombstones.has(name)) tombstones.set(name, []);
        tombstones.get(name)!.push(index);
        continue;
      }
      const address = normalizeAddress(addressOf(entry));
      if (address === null) continue;

      const known = addresses.get(address);
      if (known) {
        known.lastLayer = index;
        known.contract = name;
        known.names.add(name);
        if (known.blockNumber == null) known.blockNumber = blockNumberOf(entry);
      } else {
        addresses.set(address, {
          contract: name,
          names: new Set([name]),
          blockNumber: blockNumberOf(entry),
          firstLayer: index,
          lastLayer: index,
        });
      }
    }
  });

  return { addresses, tombstones };
}

/** chainId → lowercase address → entry */
export type RetiredByChain = Record<string, Record<string, RetiredEntry>>;

/**
 * Retirements in force once the chain is flattened: chainId → lowercase address → entry, the newest
 * layer winning per address.
 *
 * @param layers - Registry documents in oldest → newest order
 */
export function flattenRetired(layers: Layer[]): RetiredByChain {
  const out: RetiredByChain = {};
  for (const layer of layers) {
    for (const [chainId, chainData] of Object.entries(layer?.chains || {})) {
      for (const [address, entry] of Object.entries(chainData?.retired || {})) {
        (out[chainId] ??= {})[address.toLowerCase()] = entry;
      }
    }
  }
  return out;
}

function lastLayerOfVersion(layers: Layer[], version: string): number {
  let found = -1;
  layers.forEach((layer, index) => {
    if (layer?.version === version) found = index;
  });
  return found;
}

function addressesInEnv(
  envContracts: Record<string, ContractEntry> | null | undefined,
): Set<string> {
  return new Set(
    Object.values(envContracts || {})
      .map((entry) => normalizeAddress(addressOf(entry)))
      .filter((address): address is string => Boolean(address)),
  );
}

function shadowedByTombstone(
  record: AddressRecord,
  tombstones: Map<string, number[]>,
  upTo = Infinity,
): boolean {
  const indices = tombstones.get(record.contract) || [];
  return indices.some((index) => index > record.lastLayer && index <= upTo);
}

function retiredEntry(record: AddressRecord, endBlock: number): RetiredEntry {
  return {
    contract: record.contract,
    ...(record.blockNumber != null && { blockNumber: record.blockNumber }),
    endBlock,
  };
}

function validEndBlock(endBlock: unknown): endBlock is number {
  return Number.isInteger(endBlock) && (endBlock as number) >= 1;
}

/**
 * Resolves a version declaration's `except` list to lowercase addresses, among the addresses the
 * declaration could close. Each entry must match something, by address or by any name an address
 * was published under at or before the version's last layer.
 */
function resolveExceptions(
  except: string[],
  addresses: Map<string, AddressRecord>,
  last: number,
  label: string,
  errors: string[],
): Set<string> {
  const excepted = new Set<string>();
  for (const item of except) {
    let matched = false;
    if (isAddressDeclaration(item)) {
      const address = item.toLowerCase();
      const record = addresses.get(address);
      if (record && record.firstLayer <= last) {
        excepted.add(address);
        matched = true;
      }
    } else {
      for (const [address, record] of addresses) {
        if (record.firstLayer <= last && record.names.has(item)) {
          excepted.add(address);
          matched = true;
        }
      }
    }
    if (!matched) {
      errors.push(
        `${label}.except: "${item}" matches no contract name or address published at or before ` +
          `that version on this chain`,
      );
    }
  }
  return excepted;
}

export interface ChainRetirementsParams {
  chainId: string;
  /** Registry documents ordered oldest → newest. */
  layers: Layer[];
  /** This chain's declarations from retired.json: version or address → { endBlock, except?, reason? }. */
  declared: Record<string, unknown> | null | undefined;
  /** The config's `contracts`. */
  envContracts: Record<string, ContractEntry> | null | undefined;
  /** Retirements the chain already published for this chain, lowercase address → entry. */
  retiredSoFar?: Record<string, RetiredEntry>;
}

export interface ChainRetirements {
  /** What to publish under the chain, keyed by lowercase address. */
  retired: Record<string, RetiredEntry>;
  errors: string[];
  warnings: string[];
  /** Declarations already in force. */
  notes: string[];
}

/** Expands a chain's declarations into the addresses they close. */
export function computeChainRetirements({
  chainId,
  layers,
  declared,
  envContracts,
  retiredSoFar = {},
}: ChainRetirementsParams): ChainRetirements {
  const retired: Record<string, RetiredEntry> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  const declarations = Object.entries(declared || {}) as [
    string,
    { endBlock?: unknown; except?: string[] } | undefined,
  ][];
  if (declarations.length === 0) return { retired, errors, warnings, notes };

  const { addresses, tombstones } = chainAddressHistory(layers, chainId);
  const inEnv = addressesInEnv(envContracts);
  const publishedVersions = [
    ...new Set(
      layers.map((layer) => layer?.version).filter((v): v is string => typeof v === "string"),
    ),
  ];

  // Already published with this end block: nothing to emit. A different end block is a correction.
  const alreadyPublished = (address: string, endBlock: number) =>
    retiredSoFar[address]?.endBlock === endBlock;

  // Version declarations first, so an address declaration can override what they close.
  for (const [version, declaration] of declarations.filter(([key]) => !isAddressDeclaration(key))) {
    const label = `retired.${version}`;
    const endBlock = declaration?.endBlock;
    if (!validEndBlock(endBlock)) {
      errors.push(`${label}.endBlock must be a positive integer, got ${JSON.stringify(endBlock)}`);
      continue;
    }

    const last = lastLayerOfVersion(layers, version);
    if (last === -1) {
      errors.push(
        `${label}: no published layer carries version "${version}" ` +
          `(published: ${publishedVersions.join(", ") || "none"})`,
      );
      continue;
    }

    const excepted = resolveExceptions(declaration?.except || [], addresses, last, label, errors);

    let closed = 0;
    let inEffect = 0;
    for (const [address, record] of addresses) {
      if (record.firstLayer > last) continue; // published only after that release
      if (record.lastLayer > last) continue; // re-registered by a later release: still current
      if (inEnv.has(address)) continue; // env still lists it: still current
      if (excepted.has(address)) continue;
      if (shadowedByTombstone(record, tombstones, last)) continue; // retired the old way
      if (alreadyPublished(address, endBlock)) {
        inEffect++;
        continue;
      }

      if (record.blockNumber != null && endBlock < record.blockNumber) {
        errors.push(
          `${label}: endBlock ${endBlock} precedes ${record.contract} ${address}, ` +
            `deployed at block ${record.blockNumber}`,
        );
        continue;
      }

      retired[address] = retiredEntry(record, endBlock);
      closed++;
    }

    if (closed === 0 && inEffect > 0) {
      notes.push(
        `${label}: in force, ${inEffect} address(es) already published with end block ${endBlock}`,
      );
    } else if (closed === 0) {
      warnings.push(
        `${label}: closes nothing on this chain — everything published at or before it is still ` +
          `listed in env, re-registered by a later release, excepted, or retired by tombstone`,
      );
    }
  }

  for (const [key, declaration] of declarations.filter(([key]) => isAddressDeclaration(key))) {
    const address = key.toLowerCase();
    const label = `retired.${key}`;
    const endBlock = declaration?.endBlock;
    if (!validEndBlock(endBlock)) {
      errors.push(`${label}.endBlock must be a positive integer, got ${JSON.stringify(endBlock)}`);
      continue;
    }
    if (declaration?.except !== undefined) {
      errors.push(`${label}.except: only a version declaration takes "except"`);
      continue;
    }

    const record = addresses.get(address);
    if (!record) {
      errors.push(`${label}: no published layer carries this address on chain ${chainId}`);
      continue;
    }
    if (inEnv.has(address)) {
      errors.push(
        `${label}: env still lists this address as live (${record.contract}); remove it from env first`,
      );
      continue;
    }
    if (record.blockNumber != null && endBlock < record.blockNumber) {
      errors.push(`${label}: endBlock ${endBlock} precedes its deploy block ${record.blockNumber}`);
      continue;
    }
    if (alreadyPublished(address, endBlock)) {
      delete retired[address]; // a version declaration may have queued a different end block
      notes.push(`${label}: in force, published with end block ${endBlock}`);
      continue;
    }

    retired[address] = retiredEntry(record, endBlock);
  }

  return { retired, errors, warnings, notes };
}

export interface OpenAddress {
  address: string;
  contract: string;
  blockNumber: number | null;
}

/**
 * Addresses the chain has published live that are neither in env nor retired: the listeners a
 * snapshot built from env alone would drop, and the "kept" set a delta leaves as published.
 */
export function openAddressesOutsideEnv({
  chainId,
  layers,
  envContracts,
  retiredSoFar = {},
}: {
  chainId: string;
  layers: Layer[];
  envContracts: Record<string, ContractEntry> | null | undefined;
  retiredSoFar?: Record<string, RetiredEntry>;
}): OpenAddress[] {
  const { addresses, tombstones } = chainAddressHistory(layers, chainId);
  const inEnv = addressesInEnv(envContracts);
  const open: OpenAddress[] = [];
  for (const [address, record] of addresses) {
    if (inEnv.has(address) || retiredSoFar[address]) continue;
    if (shadowedByTombstone(record, tombstones)) continue;
    open.push({ address, contract: record.contract, blockNumber: record.blockNumber });
  }
  return open;
}
