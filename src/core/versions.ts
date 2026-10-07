/**
 * Protocol version labels: how env's per-contract `version` maps to a git tag, and how the registry's
 * top-level `version` is derived from env.
 *
 * Env records labels in several historical shapes (`3`, `v3.1`, `v3.1.0`, `v3.3.0-rc2` via an alias),
 * while the published registry always carries a normalized `vX.Y.Z`.
 */

import type { ContractEntry, EnvConfig, LayerChain } from "./types.ts";

/**
 * Ordered list of tag candidates for a contract version (no I/O).
 *
 * An alias replaces the list rather than heading it: a deployment that aliases `v3.3` to `v3.3.0-rc2`
 * is saying its contracts are the candidate and not the release, so falling back to the `v3.3` tag
 * once that exists would quietly serve the release's ABIs for code that was never it. Where the alias
 * names a tag that does not exist, the resolution fails and says so.
 *
 * @param aliases - version → git tag, from `env/<dir>/versions.json`
 */
export function versionTagCandidates(
  version: string,
  aliases: Record<string, string> = {},
): string[] {
  const alias = aliases?.[version];
  if (alias) return [alias];

  const candidates = [version];
  if (!version.startsWith("v")) {
    candidates.push(`v${version}`);
  }
  const withPatch = candidates.map((c) => `${c}.0`);
  candidates.push(...withPatch);
  return candidates;
}

/**
 * Resolves a contract version to the first candidate tag that exists.
 *
 * @param tagExists - Whether protocol-internal has that tag
 * @throws If no candidate exists
 */
export async function resolveVersionTag(
  version: string,
  aliases: Record<string, string>,
  tagExists: (tag: string) => Promise<boolean>,
): Promise<string> {
  const candidates = versionTagCandidates(version, aliases);
  for (const candidate of candidates) {
    if (await tagExists(candidate)) return candidate;
  }
  throw new Error(
    `No git tag found for contract version "${version}". ` +
      `Tried: ${candidates.join(", ")}. ` +
      (aliases?.[version]
        ? `That tag is what this deployment's versions.json aliases the version to, so either push it ` +
          `or point the alias at a tag that exists.`
        : `Every contract version in env files must have a corresponding git tag.`),
  );
}

/** "v3.1" → [3, 1], "3" → [3] */
function parseVersion(v: string): number[] {
  return v.replace(/^v/i, "").split(".").map(Number);
}

/** > 0 if a > b, < 0 if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The version a config records: deploymentInfo's first, else the highest per-contract one
 * (e.g. "v3.1" wins over "3").
 */
export function getVersionFromChain(chain: EnvConfig): string | null {
  const info = chain.deploymentInfo;
  if (info && typeof info === "object") {
    if (info["deploy:protocol"]?.version) {
      return info["deploy:protocol"].version;
    }
    for (const value of Object.values(info)) {
      if (value?.version) {
        return value.version;
      }
    }
  }

  const contracts = chain.contracts;
  if (contracts && typeof contracts === "object") {
    let highest: string | null = null;
    for (const value of Object.values(contracts)) {
      const v = typeof value === "string" ? undefined : value?.version;
      if (v && (!highest || compareVersions(v, highest) > 0)) {
        highest = v;
      }
    }
    return highest;
  }

  return null;
}

/** Env-style protocol labels ("3", "v3.1", "v3.1.0") as [major, minor, patch], for ordering. */
function protocolVersionTuple(s: string): [number, number, number] {
  const n = String(s).replace(/^v/i, "").trim().split("-")[0];
  const parts = n.split(".").map((p) => parseInt(p, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}

export function compareProtocolVersionStrings(a: string, b: string): number {
  const ta = protocolVersionTuple(a);
  const tb = protocolVersionTuple(b);
  for (let i = 0; i < 3; i++) {
    if (ta[i] !== tb[i]) return ta[i] - tb[i];
  }
  return 0;
}

/** Highest label by numeric major.minor.patch (for mixed "3" vs "v3.1" in env). */
export function maxProtocolVersionLabel(strings: (string | null | undefined)[]): string | null {
  const uniq = [
    ...new Set(strings.filter((s): s is string => Boolean(s) && typeof s === "string")),
  ];
  if (uniq.length === 0) return null;
  uniq.sort(compareProtocolVersionStrings);
  return uniq[uniq.length - 1] ?? null;
}

/** Canonical top-level registry.version: always vX.Y.Z (patch explicit). */
export function normalizeRegistryVersionToVSemver(label: string | null): string | null {
  if (!label || typeof label !== "string") return null;
  const [major, minor, patch] = protocolVersionTuple(label);
  return `v${major}.${minor}.${patch}`;
}

/**
 * Max of per-contract `version` across chains (skips tombstones). Used when deploymentInfo has no
 * protocol version — api-v3 `update-registry` expects a top-level version.
 */
export function deriveHighestContractVersion(chains: Record<string, LayerChain>): string | null {
  const labels: string[] = [];
  for (const chain of Object.values(chains)) {
    const contracts = chain?.contracts;
    if (!contracts || typeof contracts !== "object") continue;
    for (const data of Object.values(contracts) as ContractEntry[]) {
      if (!data || typeof data !== "object" || data.address === null) continue;
      if (data.version && typeof data.version === "string") labels.push(data.version);
    }
  }
  return maxProtocolVersionLabel(labels);
}
