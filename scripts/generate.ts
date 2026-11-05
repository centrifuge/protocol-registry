/**
 * Generates and validates a registry layer locally, the way the Worker does, without publishing it.
 *
 *     node scripts/generate.ts <mainnet|testnet> --source-repo <protocol-internal checkout> \
 *       [--wrangler-profile <name>] [--mode auto|delta|patch|full] [--source-cid <cid>] \
 *       [--allow-partial-chain] [--allow-history-drop] [--out out]
 *
 * Env comes from the checkout's working tree, tags from its git, ABIs from the bundles
 * protocol-internal's build-abis.yml uploads to R2, read with wrangler under the operator's login (or
 * the given auth profile) and kept in cache/abis (see scripts/abi-bundles.ts). Fetched layers are
 * cached in cache/registry-chain.
 *
 * Writes <out>/registry-<network>.json and <out>/registry-<network>.validation.json; exits 1 when
 * generation is refused or validation finds errors.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { isReadEnvPath, type EnvTree } from "../src/core/env.ts";
import { generateRegistry, type Logger, type RegistryMode } from "../src/core/generate.ts";
import { validateRegistry } from "../src/core/validate.ts";
import { NETWORKS, type Network } from "../src/core/types.ts";
import { fetchRegistryFromIpfs, type LayerCache } from "../src/io/ipfs.ts";
import { collectRegistryChain, slimLayer } from "../src/core/chain.ts";
import { abiBundles, wranglerObject } from "./abi-bundles.ts";
import { HOSTNAMES, liveCid } from "./live-cid.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "source-repo": { type: "string" },
    "wrangler-profile": { type: "string" },
    mode: { type: "string", default: "auto" },
    "source-cid": { type: "string" },
    "allow-partial-chain": { type: "boolean", default: false },
    "allow-history-drop": { type: "boolean", default: false },
    out: { type: "string", default: "out" },
  },
});

const network = positionals[0] as Network;
const repo = values["source-repo"];
if (!NETWORKS.includes(network) || !repo) {
  console.error(
    "usage: node scripts/generate.ts <mainnet|testnet> --source-repo <checkout> [options]",
  );
  process.exit(2);
}
if (!["auto", "delta", "patch", "full"].includes(values.mode!)) {
  console.error(`--mode must be one of auto, delta, patch, full`);
  process.exit(2);
}

function envTreeFromDirectory(envDir: string): EnvTree {
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else paths.push(relative(envDir, path));
    }
  };
  walk(envDir);
  paths.sort();
  const files = new Map(
    paths.filter(isReadEnvPath).map((path) => [path, readFileSync(join(envDir, path), "utf8")]),
  );
  return { paths, files };
}

function directoryCache(dir: string): LayerCache {
  return {
    get: async (cid) => {
      const path = join(dir, `${cid}.json`);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    put: async (cid, text) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${cid}.json`), text);
    },
  };
}

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo!, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const log: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

const cache = directoryCache(join("cache", "registry-chain"));
const fetchLayer = async (cid: string) => slimLayer(await fetchRegistryFromIpfs(cid, { cache }));
const live = await liveCid(HOSTNAMES[network]);
const tipCid = values["source-cid"] ?? live;
const tip = tipCid
  ? { cid: tipCid, layer: await fetchRegistryFromIpfs(tipCid, { cache }).catch(() => null) }
  : null;

const abiAt = abiBundles({
  dir: join("cache", "abis"),
  tagCommit: (tag) => git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`),
  fetchObject: wranglerObject(values["wrangler-profile"]),
});

try {
  const generated = await generateRegistry(
    {
      network,
      env: envTreeFromDirectory(join(repo, "env")),
      tip: tip?.layer ? { cid: tip.cid, layer: tip.layer } : null,
      fetchLayer,
      mode: values.mode as RegistryMode,
      allowPartialChain: values["allow-partial-chain"],
      allowHistoryDrop: values["allow-history-drop"],
    },
    {
      log,
      tagExists: async (tag) =>
        git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`) !== null,
      abiAt,
    },
  );

  // Validation measures against the live tip, which is not the source when a CID was given
  const liveTip = live === tipCid ? tip?.layer : live ? await fetchLayer(live) : null;
  const liveChain =
    live === tipCid
      ? generated.chain
      : liveTip
        ? await collectRegistryChain(liveTip, { fetchLayer, expectedNetwork: network })
        : null;
  const report = validateRegistry({
    registry: generated.registry,
    liveTip: liveTip ?? null,
    liveChain,
    envChains: generated.envChains,
    fullSnapshot: generated.summary.mode === "full",
  });

  mkdirSync(values.out!, { recursive: true });
  writeFileSync(join(values.out!, `registry-${network}.json`), generated.text);
  writeFileSync(
    join(values.out!, `registry-${network}.validation.json`),
    JSON.stringify(report, null, 2),
  );
  for (const finding of report.errors)
    console.error(`  [ERROR] ${finding.path}: ${finding.message}`);
  for (const finding of report.warnings)
    console.warn(`  [WARN]  ${finding.path}: ${finding.message}`);
  console.log(
    `\n${generated.summary.mode} registry written to ${values.out}/registry-${network}.json ` +
      `(${report.summary.errors} error(s), ${report.summary.warnings} warning(s), ` +
      `publishable: ${report.summary.publishable})`,
  );
  process.exitCode = report.errors.length > 0 ? 1 : 0;
} catch (error) {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exitCode = 1;
}
