/**
 * The operations a run is made of, each one a workflow step (see ./workflow.ts): read env at a
 * commit, check it, make sure the ABIs it needs are built, generate and validate each network, and
 * publish. Kept apart from the Workflows runtime so they run, and are tested, under Node too.
 *
 * Large values (env snapshots, generated layers, reports) live in R2; what passes between steps is
 * small: shas, counts, findings.
 */

import { fetchRegistryFromIpfs, type LayerCache } from "./io/ipfs.ts";
import { collectRegistryChain, slimLayer } from "./core/chain.ts";
import { registryPointer, type EnvTree } from "./core/env.ts";
import { validateEnvTree } from "./core/env-schema.ts";
import { generateRegistry, RefusedError, type Logger, type RegistryMode } from "./core/generate.ts";
import { NETWORKS, type Network } from "./core/types.ts";
import { validateRegistry } from "./core/validate.ts";
import { publishedTags, versionTagErrors } from "./core/version-tags.ts";
import { r2AbiStore } from "./io/abis.ts";
import { commitInfo, envSnapshot, tagExists, type GitHub } from "./io/github.ts";
import { dnslinkCid, pinLayer, type Web3Gateway } from "./io/publish.ts";
import {
  contractsInLayer,
  retiredRows,
  type HostnameCheck,
  type NetworkOutcome,
} from "./report.ts";

export interface RunConfig {
  gh: GitHub;
  bucket: R2Bucket;
  /** Null unless the Worker holds the Web3 hostname token, which only PUBLISH_MODE live needs. */
  gateway: Web3Gateway | null;
  sourceRepo: string;
  hostnames: Record<Network, string>;
  hostnameRecords: HostnameRecords;
  /** Null unless the Worker holds a Pinata JWT, which PUBLISH_MODE pin and live need. */
  pinataJwt: string | null;
  log: Logger;
}

/**
 * The CID the Worker last pointed a network's hostname at. A hostname that serves anything else was
 * changed by someone holding the Web3 hostnames token, and nothing publishes that network on top of it
 * until an operator accepts it (see checkHostname).
 */
export interface HostnameRecord {
  cid: string;
  /** The CID the Worker is pointing the hostname at, set before the swap and cleared once it is seen. */
  pending?: string;
  /** How `cid` was recorded: a publish, the first live publish run, or an operator's acceptLiveCid. */
  how: "published" | "seeded" | "accepted";
  at: number;
}

/** Where the records live: the Publisher, whose storage only this Worker's code writes. */
export interface HostnameRecords {
  get(network: Network): Promise<HostnameRecord | null>;
  put(network: Network, record: HostnameRecord): Promise<void>;
}

/**
 * How far a publish run goes, from PUBLISH_MODE:
 *   - shadow: generate and report what would be published (the default, and any unknown value)
 *   - pin:    also pin the layer to IPFS, where nothing reads it until a hostname points at it
 *   - live:   also point the registry hostname at it
 * Each stage needs the credentials of what it does, and refuses without them rather than doing less.
 */
export type PublishMode = "shadow" | "pin" | "live";

export function publishMode(
  value: string | undefined,
  config: Pick<RunConfig, "gateway" | "pinataJwt">,
): PublishMode {
  if (value !== "pin" && value !== "live") return "shadow";
  if (!config.pinataJwt) throw new Error(`PUBLISH_MODE is ${value}, but PINATA_JWT is not set`);
  if (value === "live" && !config.gateway) {
    throw new Error(`PUBLISH_MODE is live, but CLOUDFLARE_API_TOKEN is not set`);
  }
  return value;
}

/** The CID a hostname serves: from the API when the Worker can publish, else from public DNS. */
function liveCidOf(config: RunConfig, network: Network): Promise<string | null> {
  const hostname = config.hostnames[network];
  return config.gateway ? config.gateway.currentCid(hostname) : dnslinkCid(hostname);
}

function driftMessage(config: RunConfig, network: Network, live: string | null, recorded: string) {
  const hostname = config.hostnames[network];
  const recover = live
    ? `If the change was deliberate, accept it with a manual publish run that sets ` +
      `"acceptLiveCid": "${live}". If not, point ${hostname} back at ${recorded} and rotate the ` +
      `Web3 hostnames token.`
    : `Point ${hostname} back at ${recorded}, and rotate the Web3 hostnames token unless the change ` +
      `was deliberate.`;
  return (
    `${network}: ${hostname} serves ${live ?? "no CID"}, not ${recorded}, the CID the Worker last ` +
    `pointed it at. Something other than the Worker changed it, so nothing publishes ${network} until ` +
    `someone acts. ${recover}`
  );
}

/** Thrown when a hostname serves a CID the Worker did not point it at; see checkHostname. */
export class HostnameDriftError extends Error {
  constructor(config: RunConfig, network: Network, live: string | null, recorded: string) {
    super(driftMessage(config, network, live, recorded));
    this.name = "HostnameDriftError";
  }
}

/**
 * Compares what a network's hostname serves with the CID the Worker last pointed it at, at the start
 * of a run. A CID that is neither the recorded one nor one the Worker was pointing the hostname at is
 * drift: the run reports it, and the network does not publish on top of it.
 *
 * Only a publish run writes the record (the Publisher runs one at a time; previews run beside them):
 *   - a pending CID the hostname now serves becomes the record, as the swap that run made
 *   - `acceptLiveCid`, when the hostname serves exactly that CID, becomes the record: an operator's
 *     acceptance of a change made by hand
 *   - with no record yet, PUBLISH_MODE live records what the hostname serves (trust on first use);
 *     shadow and pin do not, since until live something other than the Worker may still publish
 */
export async function checkHostname(
  config: RunConfig,
  network: Network,
  options: { mode: PublishMode | null; acceptLiveCid?: string },
): Promise<HostnameCheck> {
  const liveCid = await liveCidOf(config, network);
  const record = await config.hostnameRecords.get(network);
  const ok: HostnameCheck = { network, liveCid, drift: null, recorded: null };
  const publish = options.mode !== null;

  if (record && liveCid === record.cid) return ok;
  if (record && liveCid === record.pending) {
    if (publish) {
      await config.hostnameRecords.put(network, { cid: liveCid, how: "published", at: Date.now() });
      config.log.info(
        `${network}: the hostname serves ${liveCid}, which a publish was pointing it at`,
      );
    }
    return ok;
  }
  if (publish && liveCid !== null) {
    const how =
      liveCid === options.acceptLiveCid
        ? "accepted"
        : !record && options.mode === "live"
          ? "seeded"
          : null;
    if (how) {
      await config.hostnameRecords.put(network, { cid: liveCid, how, at: Date.now() });
      return { ...ok, recorded: how };
    }
  }
  if (!record) return ok;
  return { ...ok, drift: driftMessage(config, network, liveCid, record.cid) };
}

export interface GenerateOptions {
  mode?: RegistryMode;
  /** Build on this CID instead of the live tip (one network only). */
  sourceCid?: string;
  allowPartialChain?: boolean;
  allowHistoryDrop?: boolean;
}

/** A generated network, plus what publishing it needs to re-check. */
export interface GeneratedOutcome extends NetworkOutcome {
  /** What the hostname served when the layer was generated; a publish refuses if it has moved since. */
  liveCid: string | null;
  publishable: boolean;
}

const runKey = (runId: string, name: string) => `runs/${runId}/${name}`;

/**
 * One GitHub lookup per tag per run: env names the same handful of versions on hundreds of contracts.
 * A failed lookup is not remembered, so a retried step asks again.
 */
const tagLookups = new WeakMap<RunConfig, Map<string, Promise<boolean>>>();
function cachedTagExists(config: RunConfig): (tag: string) => Promise<boolean> {
  if (!tagLookups.has(config)) tagLookups.set(config, new Map());
  const cache = tagLookups.get(config)!;
  return (tag) => {
    if (!cache.has(tag)) {
      const lookup = tagExists(config.gh, config.sourceRepo, tag);
      lookup.catch(() => cache.delete(tag));
      cache.set(tag, lookup);
    }
    return cache.get(tag)!;
  };
}

function r2LayerCache(bucket: R2Bucket): LayerCache {
  return {
    get: async (cid) => (await bucket.get(`layers/${cid}.json`))?.text() ?? null,
    put: async (cid, text) => {
      await bucket.put(`layers/${cid}.json`, text);
    },
  };
}

/** `env/` at a commit, cached by sha: a commit's tree never changes. */
export async function loadEnv(config: RunConfig, sha: string): Promise<EnvTree> {
  const key = `snapshots/${sha}.json`;
  const cached = await config.bucket.get(key);
  if (cached) {
    const { paths, files } = (await cached.json()) as {
      paths: string[];
      files: [string, string][];
    };
    return { paths, files: new Map(files) };
  }
  const tree = await envSnapshot(config.gh, config.sourceRepo, sha);
  await config.bucket.put(key, JSON.stringify({ paths: tree.paths, files: [...tree.files] }));
  return tree;
}

/** Everything wrong with env as a whole: schema, the files beside the configs, version tags. */
export async function checkEnv(config: RunConfig, tree: EnvTree): Promise<string[]> {
  const schema = validateEnvTree(tree);
  if (schema.fatal) return [schema.fatal];
  const problems = schema.files.flatMap(({ file, errors }) =>
    errors.map((error) => `env/${file}: ${error}`),
  );
  problems.push(...(await versionTagErrors(tree, { tagExists: cachedTagExists(config) })));
  return problems;
}

/**
 * The tags the published deployments use that have no complete ABI bundle, built from the commit the
 * tag points at now. protocol-internal's build-abis.yml builds a tag when it is pushed.
 */
export async function missingAbis(config: RunConfig, tree: EnvTree): Promise<string[]> {
  const store = r2AbiStore(config.bucket);
  const pointer = registryPointer(tree);
  const tags = await publishedTags(
    tree,
    NETWORKS.map((n) => pointer[n]),
    cachedTagExists(config),
  );

  const missing: string[] = [];
  for (const tag of tags) {
    const [manifest, commit] = await Promise.all([
      store.manifest(tag),
      commitInfo(config.gh, config.sourceRepo, tag),
    ]);
    if (manifest && commit && manifest.commit === commit.sha) continue;
    config.log.info(
      manifest
        ? `ABIs for ${tag} were built from ${manifest.commit}, but the tag now points at ${commit?.sha}`
        : `No ABIs built for ${tag}`,
    );
    missing.push(tag);
  }
  return missing;
}

/**
 * Generates and validates one network's next layer, storing it under the run, and reports what it
 * holds. A refusal is an outcome, not a failure; a refusal that can clear on its own (IPFS
 * unreachable) is thrown, so the step retries it.
 */
export async function generateNetwork(
  config: RunConfig,
  runId: string,
  network: Network,
  tree: EnvTree,
  options: GenerateOptions = {},
): Promise<GeneratedOutcome> {
  const cache = r2LayerCache(config.bucket);
  const fetchLayer = async (cid: string) => slimLayer(await fetchRegistryFromIpfs(cid, { cache }));

  const liveCid = await liveCidOf(config, network);
  const tipCid = options.sourceCid ?? liveCid;
  const tipLayer = tipCid ? await fetchRegistryFromIpfs(tipCid, { cache }).catch(() => null) : null;
  const store = r2AbiStore(config.bucket);

  try {
    const generated = await generateRegistry(
      {
        network,
        env: tree,
        tip: tipCid && tipLayer ? { cid: tipCid, layer: tipLayer } : null,
        fetchLayer,
        mode: options.mode,
        allowPartialChain: options.allowPartialChain,
        allowHistoryDrop: options.allowHistoryDrop,
      },
      {
        log: config.log,
        tagExists: cachedTagExists(config),
        abiAt: (tag, name) => store.abi(tag, name),
      },
    );

    // Validation measures against the live tip, which is not the source when a CID was given
    const liveTip = liveCid === tipCid ? tipLayer : liveCid ? await fetchLayer(liveCid) : null;
    const liveChain =
      liveCid === tipCid
        ? generated.chain
        : liveTip
          ? await collectRegistryChain(liveTip, { fetchLayer, expectedNetwork: network })
          : null;
    const validation = validateRegistry({
      registry: generated.registry,
      liveTip,
      liveChain,
      envChains: generated.envChains,
      fullSnapshot: generated.summary.mode === "full",
    });

    await config.bucket.put(runKey(runId, `registry-${network}.json`), generated.text);
    await config.bucket.put(
      runKey(runId, `registry-${network}.validation.json`),
      JSON.stringify(validation, null, 2),
    );

    return {
      network,
      summary: generated.summary,
      validation,
      previousVersion: generated.registry.previousRegistry?.version ?? null,
      contractsInLayer: contractsInLayer(generated.registry),
      retired: retiredRows(generated.registry),
      liveCid,
      publishable: validation.summary.publishable,
    };
  } catch (error) {
    if (error instanceof RefusedError && !error.retryable) {
      return { network, refused: error.message, liveCid, publishable: false };
    }
    throw error;
  }
}

/** Thrown when the hostname no longer serves the tip a layer was built on. */
export class TipMovedError extends Error {
  constructor(network: Network, expected: string | null, actual: string | null) {
    super(
      `${network}: the registry hostname now serves ${actual ?? "nothing"}, not ${expected ?? "nothing"} ` +
        `as when this layer was generated. Something else published in between; nothing was changed.`,
    );
    this.name = "TipMovedError";
  }
}

async function assertTip(config: RunConfig, network: Network, expected: string | null) {
  const current = await liveCidOf(config, network);
  if (current !== expected) throw new TipMovedError(network, expected, current);
}

/** Pins a generated layer, after checking the tip it builds on is still the one served. */
export async function pinNetwork(
  config: RunConfig,
  runId: string,
  outcome: GeneratedOutcome,
  sha: string,
): Promise<string> {
  await assertTip(config, outcome.network, outcome.liveCid);
  const stored = await config.bucket.get(runKey(runId, `registry-${outcome.network}.json`));
  if (!stored) throw new Error(`run ${runId} has no generated ${outcome.network} registry`);
  const text = await stored.text();
  const layer = JSON.parse(text) as { version?: string | null };
  if (!config.pinataJwt) throw new Error("PINATA_JWT is not set");
  const { cid } = await pinLayer(config.pinataJwt, outcome.network, text, {
    version: layer.version ?? null,
    sha,
  });
  return cid;
}

/**
 * Points the hostname at a pinned layer and records it, unless the tip moved since the layer was built
 * or the hostname serves a CID the Worker did not point it at.
 */
export async function pointHostname(
  config: RunConfig,
  outcome: GeneratedOutcome,
  cid: string,
): Promise<void> {
  const { gateway } = config;
  if (!gateway) throw new Error("CLOUDFLARE_API_TOKEN is not set");
  const { network } = outcome;
  const hostname = config.hostnames[network];
  const current = await gateway.currentCid(hostname);
  // On a retry after the change already landed, only the record is left to write
  if (current !== cid) {
    if (current !== outcome.liveCid) throw new TipMovedError(network, outcome.liveCid, current);
    // The run checked the hostname when it started; this catches a change made since
    const record = await config.hostnameRecords.get(network);
    if (record && current !== record.cid) {
      throw new HostnameDriftError(config, network, current, record.cid);
    }
    // Before the swap, so a run that stops after it still leaves the CID recognisable as its own
    if (record) await config.hostnameRecords.put(network, { ...record, pending: cid });
    await gateway.setCid(hostname, cid);
    const after = await gateway.currentCid(hostname);
    if (after !== cid)
      throw new Error(`${hostname} still serves ${after} after pointing it at ${cid}`);
  }
  await config.hostnameRecords.put(network, { cid, how: "published", at: Date.now() });
}
