/**
 * Builds the next registry layer for one network: the env configs of the deployment it publishes,
 * compared against the accumulated state of the published chain.
 *
 * Output shape ("modes"):
 *   - delta: normal append onto the live tip; `version` is the new resolved version, and
 *            `previousRegistry` points at the tip. Used when the new version is strictly newer than
 *            the tip's (the common case).
 *   - patch: same `previousRegistry`, but `version` is **null**. The indexer
 *            (`api-v3/scripts/fetch-registry.mjs::mergeNullVersionPatchesIntoPredecessors`) merges a
 *            null-version layer into its chronological predecessor, so a patch effectively "replaces
 *            the last registry" without orphaning anything. Used when the env's version equals the
 *            tip's (a follow-up PR adding contracts to the same release, or a missed contract).
 *   - full:  no `previousRegistry`; a base snapshot of every contract.
 *
 * Auto mode picks `patch` when the env's version matches the tip's, otherwise `delta`.
 *
 * Everything that touches the network arrives through {@link GenerateDeps}, so this runs the same in
 * the Worker, in a local run, and under test.
 */

import { artifactNamesForContractKey, capitalize, resolveArtifactName } from "./abi-names.ts";
import {
  collectRegistryChain,
  summarizeAccumulatedState,
  type CollectedChain,
  type FetchLayer,
} from "./chain.ts";
import { addressOf, computeChainDelta } from "./delta.ts";
import {
  RETIRED_FILE,
  envFilesOf,
  parseEnvConfig,
  resolveEnvironmentDir,
  retirementsOf,
  versionAliasesOf,
  type EnvTree,
} from "./env.ts";
import type { EnvChains } from "./invariants.ts";
import { stringifyJson } from "./json.ts";
import {
  computeChainRetirements,
  flattenRetired,
  openAddressesOutsideEnv,
  type RetiredByChain,
} from "./retirements.ts";
import type {
  AccumulatedState,
  ContractEntry,
  EnvConfig,
  Layer,
  LayerChain,
  Network,
  RetiredEntry,
} from "./types.ts";
import {
  compareProtocolVersionStrings,
  deriveHighestContractVersion,
  getVersionFromChain,
  maxProtocolVersionLabel,
  normalizeRegistryVersionToVSemver,
  resolveVersionTag,
} from "./versions.ts";

export type RegistryMode = "auto" | "delta" | "patch" | "full";
export type EffectiveMode = Exclude<RegistryMode, "auto">;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GenerateDeps {
  log: Logger;
  /** Whether protocol has this tag. */
  tagExists(tag: string): Promise<boolean>;
  /** An artifact's ABI as built at a tag, or null when that build has no such artifact. */
  abiAt(tag: string, artifactName: string): Promise<unknown[] | null>;
}

/** The published tip the layer is measured against, by CID. */
export interface PublishedTip {
  cid: string;
  layer: Layer;
}

export interface GenerateInput {
  network: Network;
  env: EnvTree;
  /** The tip to build on; null when it could not be read. */
  tip: PublishedTip | null;
  fetchLayer: FetchLayer;
  mode?: RegistryMode;
  /** Generate even when the published chain cannot be fully walked. */
  allowPartialChain?: boolean;
  /** Let a full snapshot drop published contracts that are neither in env nor retired. */
  allowHistoryDrop?: boolean;
  maxDepth?: number;
}

export interface GenerateSummary {
  network: Network;
  mode: EffectiveMode;
  version: string | null;
  previousVersion: string | null;
  totalContracts: number;
  changedContracts: number;
  keptContracts: number;
  retirements: number;
  abiGapsHealed: number;
  chains: number;
  abis: number;
  missingAbis: string[];
  layersWalked: number;
}

export interface Generated {
  registry: Layer;
  /** The exact document to pin. */
  text: string;
  summary: GenerateSummary;
  /** The chain the layer was measured against; null for a snapshot with no tip. */
  chain: CollectedChain | null;
  /** chainId → contracts as env records them: what validation checks against. */
  envChains: EnvChains;
}

/** Generation stopped on purpose; `retryable` marks the conditions that can clear on their own. */
export class RefusedError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "RefusedError";
    this.retryable = retryable;
  }
}

interface ProcessedContract {
  address: string | null;
  blockNumber: number;
  txHash: null;
  version?: string;
}

/**
 * The contracts a config records, in the registry's shape. Every entry has to carry a block number:
 * the deploy script writes one for everything it registers, and the registry asks no explorer for
 * what a config leaves out, so a missing one is a config error rather than a lookup to attempt.
 */
function normalizeContracts(
  chain: EnvConfig,
  networkFile: string,
): Record<string, ProcessedContract> {
  const contracts: Record<string, ProcessedContract> = {};
  const missing: string[] = [];
  for (const [contractName, contractData] of Object.entries(chain.contracts || {})) {
    if (
      !contractData ||
      typeof contractData !== "object" ||
      typeof contractData.blockNumber !== "number"
    ) {
      missing.push(contractName);
      continue;
    }
    contracts[contractName] = {
      address: contractData.address,
      blockNumber: contractData.blockNumber,
      // Always null: env no longer records txHash, and the field stays so the published schema does
      // not change for consumers
      txHash: null,
      ...(contractData.version && { version: contractData.version }),
    };
  }
  if (missing.length > 0) {
    throw new RefusedError(
      `env/${networkFile}: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no numeric blockNumber. ` +
        `The deploy script records one for every contract it registers; a hand-added entry needs it too.`,
    );
  }
  return contracts;
}

/**
 * The block indexing a chain starts from: the earliest `blockNumber` among its active contracts, over
 * every contract the config records and not only the ones this layer carries. A config stores no
 * deployment metadata, so this is derived at publish time rather than copied. Null when no contract
 * has a block number.
 */
function deriveStartBlock(contracts: Record<string, ProcessedContract>): number | null {
  let min: number | null = null;
  for (const data of Object.values(contracts)) {
    if (data.address === null) continue;
    if (min === null || data.blockNumber < min) min = data.blockNumber;
  }
  return min;
}

/**
 * Contract name → the tag its ABI is built from, over the contracts a registry carries. A factory
 * also maps its product (`TokenFactory` → `Token`), which ships beside it.
 */
async function collectContractTags(
  chains: Record<string, LayerChain>,
  aliases: Record<string, string>,
  deps: GenerateDeps,
): Promise<Map<string, string>> {
  const contractToTag = new Map<string, string>();
  const errors: string[] = [];

  for (const [chainId, chain] of Object.entries(chains)) {
    for (const [name, data] of Object.entries(chain.contracts || {})) {
      if (addressOf(data) === null) continue;

      const capitalized = capitalize(name);
      if (contractToTag.has(capitalized)) continue;

      const version = typeof data === "string" ? undefined : data?.version;
      if (!version) {
        errors.push(`${capitalized} on chain ${chainId} is missing a "version" field`);
        continue;
      }

      try {
        const tag = await resolveVersionTag(version, aliases, deps.tagExists);
        contractToTag.set(capitalized, tag);

        if (capitalized.endsWith("Factory")) {
          const baseName = capitalized.replace(/Factory$/, "");
          if (!contractToTag.has(baseName)) contractToTag.set(baseName, tag);
        }
      } catch (err) {
        errors.push(`${capitalized} (version "${version}"): ${(err as Error).message}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new RefusedError(
      `Failed to resolve version tags for contracts:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return contractToTag;
}

/** ABIs for the contracts a registry carries, from the per-tag builds. */
async function packAbis(
  chains: Record<string, LayerChain>,
  aliases: Record<string, string>,
  deps: GenerateDeps,
): Promise<{ abis: Record<string, unknown[]>; missing: string[] }> {
  const contractToTag = await collectContractTags(chains, aliases, deps);
  const uniqueTags = new Set(contractToTag.values());
  deps.log.info(
    `\nResolving ABIs for ${contractToTag.size} contracts across ${uniqueTags.size} version tag(s): ${[...uniqueTags].join(", ")}`,
  );

  const abis: Record<string, unknown[]> = {};
  const missing: string[] = [];
  for (const [contractName, tag] of contractToTag) {
    const artifactName = resolveArtifactName(contractName);
    const abi = await deps.abiAt(tag, artifactName);
    if (abi) {
      abis[artifactName] = abi;
    } else {
      missing.push(`${contractName} (artifact: ${artifactName}, tag: ${tag})`);
    }
  }

  if (missing.length > 0) deps.log.warn(`⚠ ABIs not found for: ${missing.join(", ")}`);
  deps.log.info(`Packed ${Object.keys(abis).length} ABIs for deployed contracts`);
  return { abis, missing };
}

/**
 * The version a link to the tip carries: the newest one the walked chain names, so a null-version
 * patch tip is labelled with the version api-v3 folds it into. Null only on a partial chain that
 * read no labelled layer.
 */
function newestLabel(layers: Layer[]): string | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const label = layers[i]?.version || layers[i]?.deploymentInfo?.gitCommit;
    if (label) return label;
  }
  return null;
}

/** Drops per-contract `version`: it is only needed to pick ABIs, and keeps the published layers smaller. */
function stripContractVersions(chains: Record<string, LayerChain>): void {
  for (const chain of Object.values(chains)) {
    for (const data of Object.values(chain?.contracts || {})) {
      if (
        data &&
        typeof data === "object" &&
        Object.prototype.hasOwnProperty.call(data, "version")
      ) {
        delete data.version;
      }
    }
  }
}

/** Builds the next registry layer for one network. */
export async function generateRegistry(
  input: GenerateInput,
  deps: GenerateDeps,
): Promise<Generated> {
  const {
    network,
    env,
    tip,
    fetchLayer,
    allowPartialChain = false,
    allowHistoryDrop = false,
  } = input;
  const registryMode = input.mode ?? "auto";
  const fullMode = registryMode === "full";
  const { log } = deps;

  log.info(
    fullMode
      ? `Generating FULL registry snapshot for ${network}...`
      : `Generating delta registry for ${network}...`,
  );

  let accumulated: AccumulatedState = {};
  let accumulatedAbis = new Set<string>();
  let publishedLayers: Layer[] = []; // oldest → newest; retirements are resolved against it
  let publishedRetired: RetiredByChain = {};
  let previousVersion: string | null = null;
  let walked: CollectedChain | null = null;

  if (!fullMode) {
    // No tip means no published state to measure against, and every env contract then reads as new —
    // an inflated snapshot-as-a-delta that also leaves previousRegistry null and so presents itself as
    // a base registry. An outage must not be able to publish that; deliberately publishing a base
    // snapshot is what full mode is for, which is why there is no override here.
    if (!tip) {
      throw new RefusedError(
        `Refusing to generate the ${network} registry: could not read the published tip. A delta is ` +
          `measured against published state; without it every contract would be re-emitted as new and ` +
          `the result would be pinned as a base registry. Retry once IPFS is reachable, or publish a ` +
          `full snapshot on purpose.`,
        true,
      );
    }
    log.info(`  ✓ Tip ${tip.cid}, version ${tip.layer.version || "null (patch layer)"}`);

    // Compare against the accumulated state of the whole published chain, not just the tip. Each
    // layer only carries what changed in that publish, so the tip alone would make every contract it
    // omits look new — a "delta" that is really a full snapshot.
    log.info(`  Reconstructing published state from the registry chain...`);
    const collected = await collectRegistryChain(tip.layer, {
      fetchLayer,
      maxDepth: input.maxDepth,
      expectedNetwork: network,
    });

    if (!collected.complete) {
      if (collected.fatal) {
        // Not a transient condition — the chain belongs to another environment, so there is nothing
        // to retry and no override that would make it safe.
        throw new RefusedError(
          `Refusing to generate the ${network} registry: ${collected.reason}. Check the source CID ` +
            `(or the live ${network} dnslink) points at a ${network} registry.`,
        );
      }
      const message =
        `Could not reconstruct the full registry chain for ${network}: ${collected.reason}. ` +
        `Comparing against a partial chain would emit contracts that are already published and ` +
        `would miss retirements already in force.`;
      if (!allowPartialChain) throw new RefusedError(message, true);
      log.warn(`  ⚠ ${message}`);
      log.warn(`  ⚠ allowPartialChain — continuing with ${collected.layers.length} layer(s).`);
    }

    accumulated = collected.accumulated;
    accumulatedAbis = collected.accumulatedAbis;
    publishedLayers = collected.layers;
    publishedRetired = flattenRetired(collected.layers);
    walked = collected;
    previousVersion = newestLabel(collected.layers);
    const summary = summarizeAccumulatedState(accumulated);
    log.info(
      `  ✓ Accumulated state from ${collected.layers.length} layer(s): ${summary.contracts} contracts ` +
        `across ${summary.chains} chain(s), ${accumulatedAbis.size} ABIs`,
    );
  } else if (!tip) {
    log.warn(`  ⚠ No published ${network} registry reachable: this snapshot carries no history`);
  } else {
    // A snapshot restarts the chain: previousRegistry is null, and an indexer rebuilding from it sees
    // nothing published before it. The published chain is still read, to refuse a snapshot that
    // would drop listeners still open and to carry retirements forward.
    log.info(
      `  Reading the published chain, so the snapshot cannot silently drop what it holds...`,
    );
    const collected = await collectRegistryChain(tip.layer, {
      fetchLayer,
      maxDepth: input.maxDepth,
      expectedNetwork: network,
    });
    if (!collected.complete) {
      throw new RefusedError(
        `Could not reconstruct the full ${network} registry chain: ${collected.reason}. A snapshot ` +
          `that cannot see what is published cannot tell what it would drop.`,
        !collected.fatal,
      );
    }
    publishedLayers = collected.layers;
    publishedRetired = flattenRetired(collected.layers);
    walked = collected;
  }

  if (registryMode === "patch" && !tip) {
    throw new RefusedError(`Patch mode needs a published ${network} registry to patch onto`);
  }

  // The configs of the deployment this registry publishes: the directory env/registry.json points at
  const environmentDir = resolveEnvironmentDir(env, network);
  const networkFiles = envFilesOf(env, network);
  if (environmentDir !== network) {
    log.info(`Publishing env/${environmentDir}/ as the ${network} registry (env/registry.json)`);
  }

  // Which tag backs each version this deployment records, where it is not the tag of that name
  const versionAliases = versionAliasesOf(env, environmentDir);
  for (const [version, tag] of Object.entries(versionAliases)) {
    log.info(
      `  ABIs for version ${version} come from tag ${tag} (env/${environmentDir}/versions.json)`,
    );
  }
  // What this deployment declares retired, per network: a ledger re-read on every publish
  const retirementsByNetwork = retirementsOf(env, environmentDir);
  const declaredNetworks = Object.keys(retirementsByNetwork);
  if (declaredNetworks.length > 0) {
    log.info(
      `  Retirements declared for ${declaredNetworks.join(", ")} (env/${environmentDir}/${RETIRED_FILE})`,
    );
  }

  const chains: Record<string, LayerChain> = {};
  const envChains: EnvChains = {};
  const versions = new Set<string>();
  let totalChangedContracts = 0;
  let totalKept = 0; // published, live, absent from env: left as published
  let totalRetirements = 0;
  let totalAbiGapsHealed = 0;
  let totalContracts = 0;
  const droppedBySnapshot: string[] = []; // full mode: open listeners env no longer lists

  for (const networkFile of networkFiles) {
    const chain = parseEnvConfig(env, networkFile);
    const chainId = chain.network.chainId;

    // Every config restates the directory it sits in as its environment; one that does not is a
    // config the deployment did not write
    if (chain.network.environment !== environmentDir) {
      throw new RefusedError(
        `env/${networkFile} declares environment "${chain.network.environment}", not "${environmentDir}"`,
      );
    }

    // Local development chains (Anvil/Hardhat)
    if (chainId === 31337) {
      log.info(`\nSkipping local dev chain ${chainId} (${networkFile})...`);
      continue;
    }

    log.info(`\nProcessing chain ${chainId} (${networkFile})...`);

    // Deploy-time fields the indexer has no use for: the environment is the registry itself, and the
    // namespace only shapes addresses that are already listed
    const { environment: _environment, namespace: _namespace, ...networkFields } = chain.network;
    const cleanedAdapters: Record<string, unknown> = {};
    for (const [adapterName, adapterConfig] of Object.entries(chain.adapters || {})) {
      const { deploy: _deploy, ...adapterFields } = adapterConfig;
      cleanedAdapters[adapterName] = adapterFields;
    }

    const allProcessedContracts = normalizeContracts(chain, networkFile);
    envChains[String(chainId)] = { contracts: chain.contracts || {} };

    let processedContracts: Record<string, ProcessedContract> = {};
    // What this chain closes: expanded from this network's declarations in delta mode, carried
    // forward from the published chain in full mode (see ./retirements.ts)
    let chainRetired: Record<string, RetiredEntry> = {};
    if (fullMode) {
      processedContracts = allProcessedContracts;
      totalContracts += Object.keys(allProcessedContracts).length;
      totalChangedContracts += Object.keys(allProcessedContracts).length;
      log.info(
        `  Including all ${Object.keys(allProcessedContracts).length} contracts (full mode)`,
      );

      if (publishedLayers.length > 0) {
        const open = openAddressesOutsideEnv({
          chainId: String(chainId),
          layers: publishedLayers,
          envContracts: chain.contracts || {},
          retiredSoFar: publishedRetired[chainId],
        });
        for (const { contract, address } of open) {
          droppedBySnapshot.push(`chain ${chainId}: ${contract} ${address}`);
        }
        chainRetired = publishedRetired[chainId] || {};
        if (Object.keys(chainRetired).length > 0) {
          log.info(`  Carrying ${Object.keys(chainRetired).length} retirement(s) forward`);
        }
      }
    } else {
      const allContracts = chain.contracts || {};
      const { changed, kept, abiGaps } = computeChainDelta(allContracts, accumulated[chainId], {
        publishedAbiNames: accumulatedAbis,
        abiNamesForContract: artifactNamesForContractKey,
      });

      totalContracts += Object.keys(allContracts).length;
      totalChangedContracts += changed.size;
      totalKept += kept.size;

      // Until a release is retired, every publish keeps the names the next release did not reuse, so
      // the count is what the log carries
      if (kept.size > 0) {
        log.info(`    · ${kept.size} published contract(s) not in env, kept as published`);
      }
      for (const contractName of abiGaps) {
        totalAbiGapsHealed++;
        log.info(
          `    ⟲ ${contractName}: unchanged, re-emitted to ship an ABI the chain never carried`,
        );
      }

      const networkName = networkFile.split("/").pop()!.slice(0, -".json".length);
      const retirements = computeChainRetirements({
        chainId: String(chainId),
        layers: publishedLayers,
        declared: retirementsByNetwork[networkName],
        envContracts: allContracts,
        retiredSoFar: publishedRetired[chainId],
      });
      for (const message of retirements.notes) log.info(`    · ${message}`);
      for (const message of retirements.warnings) log.warn(`    ⚠ ${message}`);
      for (const message of retirements.errors) log.error(`    ✗ ${message}`);
      if (retirements.errors.length > 0) {
        throw new RefusedError(
          `env/${environmentDir}/${RETIRED_FILE}: the declaration(s) for ${networkName} do not match ` +
            `what is published:\n  - ${retirements.errors.join("\n  - ")}`,
        );
      }
      chainRetired = retirements.retired;
      totalRetirements += Object.keys(chainRetired).length;
      for (const [address, entry] of Object.entries(chainRetired)) {
        log.info(
          `    ⊘ ${entry.contract} ${address}: retired, listeners end at block ${entry.endBlock}`,
        );
      }

      log.info(
        `  Found ${changed.size}/${Object.keys(allContracts).length} changed contracts` +
          (abiGaps.size > 0 ? ` (${abiGaps.size} to heal missing ABIs)` : "") +
          (kept.size > 0 ? `, ${kept.size} kept` : "") +
          (Object.keys(chainRetired).length > 0
            ? `, ${Object.keys(chainRetired).length} retired`
            : ""),
      );

      for (const [name, data] of Object.entries(allProcessedContracts)) {
        if (changed.has(name)) processedContracts[name] = data;
      }
    }

    // A chain is included when it has contracts (all in full mode, changed in delta mode) or retirements
    if (Object.keys(processedContracts).length > 0 || Object.keys(chainRetired).length > 0) {
      chains[chainId] = {
        network: networkFields,
        adapters: cleanedAdapters,
        contracts: processedContracts as Record<string, ContractEntry>,
        ...(Object.keys(chainRetired).length > 0 && { retired: chainRetired }),
      };
      // Derived from every contract the config records, not only the ones this delta carries: an
      // indexer starting after the earliest of them misses its history
      const startBlock = deriveStartBlock(allProcessedContracts);
      if (startBlock === null) {
        log.warn(
          `  ⚠ Chain ${chainId} (env/${networkFile}): no contract has a blockNumber, deployment.startBlock is null`,
        );
      }
      chains[chainId].deployment = { startBlock };
    }

    const chainVersion = getVersionFromChain(chain);
    if (chainVersion) versions.add(chainVersion);
  }

  // A snapshot built from env alone would drop every listener env no longer lists, and an indexer
  // rebuilding from it would lose their history. Switching which deployment a registry publishes is
  // the one case where that is the point; it says so explicitly.
  if (fullMode && droppedBySnapshot.length > 0) {
    const lines = droppedBySnapshot.map((line) => `    ${line}`).join("\n");
    if (!allowHistoryDrop) {
      throw new RefusedError(
        `A full snapshot would drop ${droppedBySnapshot.length} published contract(s) that are ` +
          `neither in env nor retired:\n${lines}\n  Retire them first (declare the release in ` +
          `env/<environment>/${RETIRED_FILE} and publish a delta), or allow the history drop when the ` +
          `published deployment is being replaced on purpose.`,
      );
    }
    log.warn(
      `  ⚠ allowHistoryDrop — this snapshot drops ${droppedBySnapshot.length} published contract(s):\n${lines}`,
    );
  }

  // Top-level version: max of per-contract versions across every env chain and across the chains
  // this registry carries (indexer codegen expects it)
  const fromDeploy = maxProtocolVersionLabel([...versions]);
  if (versions.size > 1) {
    log.warn(
      `⚠ Multiple protocol versions across chains: ${[...versions].join(", ")}. Using highest: ${fromDeploy}`,
    );
  }
  const fromContracts = deriveHighestContractVersion(chains);
  const resolvedVersionRaw = maxProtocolVersionLabel([fromDeploy, fromContracts]);
  const resolvedVersion = normalizeRegistryVersionToVSemver(resolvedVersionRaw);

  // Auto picks `patch` when versions match, so the indexer's null-version merge "replaces the last
  // registry" without orphaning it; otherwise `delta`
  const liveVersion = tip?.layer.version ?? null;
  let effectiveMode: EffectiveMode;
  if (registryMode !== "auto") {
    effectiveMode = registryMode;
  } else if (
    tip &&
    typeof resolvedVersion === "string" &&
    typeof liveVersion === "string" &&
    compareProtocolVersionStrings(resolvedVersion, liveVersion) === 0
  ) {
    effectiveMode = "patch";
  } else {
    effectiveMode = "delta";
  }
  log.info(
    effectiveMode === "patch"
      ? `\nMode: patch — local ${resolvedVersion} matches live ${liveVersion}; emitting a null-version patch.`
      : effectiveMode === "delta"
        ? `\nMode: delta — local ${resolvedVersion || "unknown"} append onto live ${liveVersion || "(none)"}.`
        : "\nMode: full — base snapshot, no previousRegistry.",
  );

  // In patch mode the top-level version is intentionally null: api-v3 treats a null-version layer as
  // a patch on the chronologically previous entry
  const registry: Layer = {
    network,
    version: effectiveMode === "patch" ? null : resolvedVersion || null,
    // Outside full mode a layer always links to the tip's CID, also when the tip is a null-version
    // patch: keyed on the version, the next layer after one would be an orphan
    previousRegistry: fullMode ? null : { version: previousVersion, ipfsHash: tip!.cid },
    chains,
  };

  const { abis, missing } = await packAbis(chains, versionAliases, deps);
  registry.abis = abis;
  stripContractVersions(chains);

  const summary: GenerateSummary = {
    network,
    mode: effectiveMode,
    version: registry.version ?? null,
    previousVersion,
    totalContracts,
    changedContracts: totalChangedContracts,
    keptContracts: totalKept,
    retirements: totalRetirements,
    abiGapsHealed: totalAbiGapsHealed,
    chains: Object.keys(chains).length,
    abis: Object.keys(abis).length,
    missingAbis: missing,
    layersWalked: publishedLayers.length,
  };
  log.info(
    `\n=== ${effectiveMode} registry: ${summary.changedContracts}/${summary.totalContracts} contracts, ` +
      `${summary.retirements} retirement(s), ${summary.chains} chain(s), ${summary.abis} ABIs ===`,
  );

  return {
    registry,
    text: stringifyJson(registry),
    summary,
    chain: walked,
    envChains,
  };
}
