# The registry format

What a published layer contains, how one is computed from `env/`, and every rule it is checked
against. The code is in `src/core/`; the flow around it is in [how-it-works.md](how-it-works.md).

- [Layers and the chain](#layers-and-the-chain)
- [What "changed since" is measured against](#what-changed-since-is-measured-against)
- [Modes](#modes)
- [What counts as a change](#what-counts-as-a-change)
- [A contract missing from env is kept](#a-contract-missing-from-env-is-kept)
- [Retirement](#retirement)
- [Versions, tags and ABIs](#versions-tags-and-abis)
- [ABI gaps and how they heal](#abi-gaps-and-how-they-heal)
- [The chain's start block](#the-chains-start-block)
- [Schema](#schema)
- [Indexer hard requirements](#indexer-hard-requirements)
- [Delta invariants](#delta-invariants)
- [Examples](#examples)
- [Reading the registry](#reading-the-registry)

## Layers and the chain

A registry is a chain of layers on IPFS. Each layer carries only what changed since the previous one
and names it by CID in `previousRegistry.ipfsHash`; the first is a base snapshot with
`previousRegistry: null`. The chain enables selective loading (a layer is what changed at its
version), version-aware indexing, and full reconstruction by walking back to the base.

Every layer declares its `network`. Nothing else in the format ties a layer to an environment, so a
walk refuses a layer of the other network with no override: mixing them would pass every later check,
the delta invariants included, since those compare against the same accumulated state. A layer with no
`network` field at all is treated as unknown rather than wrong, so an old base snapshot that predates
the field cannot fail a run.

A CID read from a published document (`previousRegistry.ipfsHash`) is refused unless it is a plain
alphanumeric CID, before it reaches a gateway URL or a cache key. Layers are fetched from Centrifuge's
Pinata gateway, with Pinata's shared gateway, `ipfs.io` and `dweb.link` as fallbacks, so one flaky
gateway cannot fail a run. A CID's contents never change, so every fetched layer is cached by CID:
in R2 at `layers/<cid>.json` for the Worker, in `cache/registry-chain/` for local runs.

## What "changed since" is measured against

A layer is computed against the **accumulated state of the whole published chain**: the generator
walks `previousRegistry.ipfsHash` from the live layer back to the base snapshot and merges every
layer, newest winning, to reconstruct the state an indexer holds. Only then does it compare `env/`
against it.

Comparing against the newest layer alone would be wrong. Each layer carries only its own changes, so
everything the newest layer happens not to carry would read as new: a small deploy would emit a
near-full snapshot, and since the next run would compare against that large layer, successive
publishes would oscillate between complementary halves of the contract set. It would also lose the
retirements already in force, which only the whole chain knows.

- **The chain cannot be walked in full** (a broken pointer, an unreachable layer, a cycle, or more than
  500 layers): generation is refused rather than emitting an inflated delta. `allowPartialChain`
  overrides this for a manual run, and then expect published contracts to be emitted again and
  retirements in force to be emitted again or missed.
- **The live layer itself cannot be read:** generation is refused with no override. There would be
  nothing to measure against, every contract would read as new, and the layer would carry
  `previousRegistry: null`, presenting an outage as a base registry. Publishing a base snapshot on
  purpose is what full mode is for.

The walk costs one fetch per layer it has not cached; mainnet is about 15 layers, testnet about 50.

## Modes

| Mode    | `version`                              | `previousRegistry` | When                                                                                    |
| ------- | -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `delta` | the env's version, normalized `vX.Y.Z` | the live layer     | the env's version is newer than the live layer's                                        |
| `patch` | `null`                                 | the live layer     | the env's version equals the live layer's: a multi-PR release, a missed contract, a fix |
| `full`  | the env's version                      | `null`             | a base snapshot, on request                                                             |

`auto`, the default, picks `patch` when the env's version equals the live layer's and `delta`
otherwise. A live layer that is itself a patch has no version, so after one `auto` picks `delta`;
api-v3 collapses consecutive layers with the same version, so an indexer sees one version either way.
Forcing a mode is a manual run's `mode`: `delta` to append even when versions match, `patch` to force a
null-version layer (refused when nothing is live), `full` for a snapshot.

The **env's version** is the highest contract `version` any config of the network records, so a layer
built from configs that record only an older contract (`root`, say) carries that contract's version.
A layer that changes nothing is not published whatever its version says.

A **patch** has `version: null` and points at the live layer; api-v3's
`mergeNullVersionPatchesIntoPredecessors` folds it into its predecessor, so it effectively replaces the
last layer without orphaning anything on IPFS.

`previousRegistry.version` labels the link with the newest version the walked chain names, which is
the live layer's own version unless it is a patch. It is informational: readers follow `ipfsHash`.

A **full snapshot** restarts the chain, so an indexer rebuilding from it never sees what came before.
Full mode therefore still reads the published chain: it refuses when the snapshot would drop a
published contract that is still live and unretired (one `env/` no longer lists), naming them, and it
carries every published retirement forward. `allowHistoryDrop` overrides the refusal for the one case
where dropping is the point: `env/registry.json` switching a registry to another deployment, which
changes every address in it. A snapshot taken while no layer is reachable carries no history and says
so. While a registry is live, only a testnet snapshot passes the orphan rule (see
[Indexer hard requirements](#indexer-hard-requirements)).

The chosen mode is in the run's report and in the validation report's `summary.mode`.

## What counts as a change

A contract in `env/` is part of the layer when the accumulated state does not already hold it as
written:

- it is new on that chain, or its address differs; or
- `env/` states a `blockNumber` the accumulated state does not resolve to, including when the chain
  carried `null` and `env/` now has a number. Without that, a corrected block could never reach the
  chain, and the indexer would keep starting that listener from the chain's start block.

The reverse is deliberately not a change: `env/` dropping a `blockNumber` the chain has. The entry
would be published with `blockNumber: null`, and an indexer's merge takes leaf nulls literally, which
would erase the published number.

## A contract missing from env is kept

A contract live in the accumulated state but absent from `env/` is **kept** exactly as published. The
generator lists it, the projection invariant reports it (`stats.keptByChain` in the validation report,
not a warning), and the preview shows it in a collapsed section.

`env/` is written by deploy scripts that record what they deployed and nothing else: a release's
`REPLACE` run drops every contract it did not redeploy, and a cleanup can drop a key, with no bearing
on whether the contract is in use. Treating absence as retirement is what once retired the v3.1
on/off-ramp factory while 93 managers still used it (protocol-internal#407), and what once published a
layer retiring the whole protocol from configs that recorded only `root`. Retirement is declared.

## Retirement

Contracts are retired on a chain once nothing needs their events any more: a whole release once every
pool has migrated off it, or one contract confirmed out of use. That is a decision about a previous
release, made after the fact, so it is written down rather than inferred, and beside the configs
rather than in one, since a deploy run rewrites a config wholesale.

The file is `env/<environment>/retired.json`, keyed by network name and resolved through the configs in
the same directory: a key matching no `<network>.json` there is an error, never a skip. A `retired`
key inside a config is refused by the schema check.

```json
{
  "ethereum": { "v3.2.0": { "endBlock": 25900000, "reason": "All pools migrated to v3.3" } },
  "base": { "v3.2.0": { "endBlock": 41900000, "except": ["spoke", "vaultRegistry"] } },
  "arbitrum": { "0x2539e60b0b50d7bd004a09e9d2b7e8c86eb0aaf6": { "endBlock": 430000000 } }
}
```

Under a network, a key is either a layer version or one address.

**A version** closes every address a layer at or before the last layer of that version published for
the chain, except one that

- `env/` still lists under any key (Root, kept across a release and re-registered at the same address,
  among them),
- a later layer publishes again (re-registered, so current in a newer release),
- `except` names, by contract name or address, or
- an old tombstone under its name already shadowed (retired the old way, left to the consumer).

A version key is the exact `version` label of a layer, and only `vX.Y.Z` labels are accepted: of the
labels published so far (`3`, `v3.1`, `v3.1-rev2`, `v3.1.0`, `v3.2.0`, `v3.3.0`) that means `v3.1.0`
onwards. A contract from an older layer is retired by address.

**An address** closes that one address. It must have been published on that chain and must not be in
`env/`, and it overrides a version declaration for the same address.

A fully migrated chain needs nothing more than its version line: the v3.3 migration announces every
carried-over share token and vault again on the v3.3 `spokeRegistry`, so the v3.2 `spoke` and
`vaultRegistry` close with the rest and the indexer finds tokens and vaults through their new factory.
A chain with a pool left behind is the one case for `except`; an `except` entry that matches nothing is
an error, since a typo there would close what it meant to protect.

Both forms publish the same entry under the chain, keyed by lowercase address because a name is
reused across releases, so a consumer never sees how it was declared:

```json
"retired": {
  "0xa4a7bb3831958463b3fe3e27a6a160f764341953": { "contract": "hub", "blockNumber": 24319335, "endBlock": 25900000 }
}
```

**The file is a ledger.** Declarations stay once published and are evaluated on every publish, so they
are idempotent: an address already published with the same `endBlock` is in force and not emitted
again (logged as in force, not warned about), and a changed `endBlock` is emitted again as a
correction. The published chain is the record indexers read; the file and its git history are the
record of who decided what and why (`reason` is never published).

Each declaration is checked against what the chain published. Errors: a version no layer carries, an
`endBlock` before an address's deploy block, closing an address `env/` lists, an address no layer
published, an `except` entry matching nothing. A declaration that closes nothing at all is a warning.
The preview counts the retirements a PR would publish, so the list is reviewed before it goes out.

**Old tombstones** (`address: null` under a contract name, written by earlier releases) stay valid in
published layers and still shadow; they carry no ABI. Nothing writes new ones.

## Versions, tags and ABIs

Each contract in a config records a `version`, which resolves to a git tag of protocol-internal (`3` →
`v3`, `v3.1` → `v3.1.0`), and its ABI comes from that tag's build, so a chain mixing releases gets
the right ABI for every contract. Every version must resolve to a tag that exists, and the run waits
for that tag's ABI bundle (see [operations.md](operations.md#abis)).

### Deployments made before their release is tagged

A testnet brought up on a release still being closed records `"version": "v3.3"` for a `v3.3` tag
that does not exist yet, and must not borrow that tag once it does: its contracts are the release
candidate, not the release. The directory says which tag backs each version, in
`env/<environment>/versions.json`:

```json
{ "tags": { "v3.3": "v3.3.0-rc2" } }
```

Per directory, because that is per deployment: the same `v3.3` means the release in `env/mainnet/` and
the candidate in a testnet directory that ran ahead of it. An alias replaces the candidate list rather
than heading it, so a tag of the version's own name is never reached behind it, and the file sits with
the configs so it outlives `env/registry.json` pointing elsewhere.

The tag has to hold the source the deployment ran, and the alias is the only record of which commit
that was: a config records no deployment metadata, so nothing can check the alias against what was
deployed. The order is: deploy, tag that commit, point the alias at the tag, and reviewing the alias
is reviewing that claim. The `env/` check holds what it can: the tag exists, and every alias redirects
a version some contract records. A later deploy from different source needs its own tag and version
label.

**Retire an alias by re-pointing it, never by deleting it.** Dropping the entry once `v3.3.0` exists
hands the deployment to the release's tag, which must not silently claim the candidate's contracts.
Point it at the release instead (`{ "tags": { "v3.3": "v3.3.0" } }`); the check then proves the release
carries the deployed source, or fails. An alias lives as long as its directory.

Two limits. A delta ships only contracts whose address or block changed, and ABIs only for those, so
re-pointing an alias at unchanged addresses publishes no new ABIs: correcting a published alias needs
a full snapshot. And a `versions.json` belongs in the same PR as the configs it describes, which before
the release tag exists it must be anyway: without it, the tag check fails.

### ABI names

ABIs are keyed by artifact name: the contract key capitalized, with a few aliases kept in one table,
`src/core/abi-names.ts` (`token` → `ShareToken`, `fullRestrictionsHook` → `FullRestrictions`,
`navManager` → `NAVManager`, the hook names, and each `<adapter>Standby` → `StandbyAdapter` with its
`<adapter>StandbyUnderlying` → the adapter it wraps). A factory also ships its product's ABI
(`tokenFactory` → `TokenFactory` + `ShareToken`). Generation, validation and the ABI-gap check all use
that table.

## ABI gaps and how they heal

A layer could once publish with an ABI missing, leaving a contract in the chain no indexer could
decode. While layers were computed against the newest layer alone, that healed by accident: nearly
every contract counted as changed on every run, so its ABI was shipped again. Comparing against the
accumulated state removed the accident, which would make such a gap permanent, since nothing re-emits
an unchanged contract. Two mechanisms replace it:

1. **Healing.** A contract active in `env/` whose required ABI names appear in no layer's `abis` is
   pulled into the layer even when its address has not moved, and counted separately in the summary.
2. **Detection.** The ABI-coverage invariant errors if a live contract still has no ABI after the
   layer, so a gap that cannot heal (a misnamed artifact, say) fails instead of shipping.

Healing deliberately restates an unchanged contract, which the minimality invariant would otherwise
reject; that case is a warning naming the ABI it ships. Retired contracts need no ABI.

## The chain's start block

`chains.<chainId>.deployment.startBlock` is the only deployment metadata a layer carries: the earliest
`blockNumber` among every active contract the chain's config records, not only the ones in the layer,
derived when the layer is generated. Configs hold `network`, `adapters` and `contracts` and nothing
else, every contract with an integer `blockNumber`; the schema check refuses any other top-level key
and a contract without a block, and generation refuses a config that has one. Deploy-time fields
(`network.environment`, `network.namespace`, per-contract `version`) are stripped from published
layers. Layers published before configs stopped recording deployment metadata also carry
`deploymentInfo: { gitCommit }` and `deployment.deployedAt`.

## Schema

```typescript
interface Registry {
  network: "mainnet" | "testnet";
  // vX.Y.Z for delta and full layers; null for a patch, which api-v3 folds into its predecessor
  version: string | null;
  previousRegistry: {
    version: string | null; // the newest version the chain names; informational
    ipfsHash: string; // the previous layer's CID
  } | null; // null for a full snapshot
  abis: { [artifactName: string]: AbiItem[] }; // ABIs of the contracts this layer carries
  chains: { [chainId: string]: ChainConfig }; // only chains this layer changes
}

interface ChainConfig {
  network: {
    chainId: number;
    centrifugeId: number; // Centrifuge's own chain identifier
    protocolAdmin?: string; // multisig safe
    opsAdmin?: string; // multisig safe
  };
  adapters: { [adapter: string]: object }; // deploy-only fields removed
  contracts: {
    [contractName: string]: {
      address: string | null; // null only in old tombstones
      blockNumber: number | null; // creation block
      txHash: string | null; // no longer recorded; older layers carry it
    };
  };
  retired?: {
    // addresses this layer closes; merged per address across layers, newest winning
    [lowercaseAddress: string]: {
      contract: string; // the name it was published under
      blockNumber?: number; // its deploy block, when the chain recorded one
      endBlock: number; // the last block its listener needs; an address with no entry is open
    };
  };
  deployment: { startBlock: number | null }; // earliest blockNumber the chain's config records
}
```

Integers above 2^53 (an adapter's `chainSelector`) are kept exact through generation and publishing.

## Indexer hard requirements

`src/core/validate.ts` checks every layer against what indexers need. The rules apply to **active**
contracts (a non-null `address`); old tombstones skip the address, block and ABI rules.

| Field                                           | Rule                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                       | A non-empty string for delta and full layers; `null` for a patch, and only with `previousRegistry.ipfsHash` set.                                                                                          |
| `previousRegistry.ipfsHash`                     | Set whenever a registry is live for the network: a layer without it would be an orphan. Absent only for a base snapshot, which a live registry allows on testnet alone.                                   |
| `chains.<chainId>.deployment.startBlock`        | A number.                                                                                                                                                                                                 |
| `chains.<chainId>.contracts.<name>.address`     | A 20-byte address for every active contract.                                                                                                                                                              |
| `chains.<chainId>.contracts.<name>.blockNumber` | A number for every active contract; a null block is a warning when the chain has a start block to fall back to.                                                                                           |
| `abis.<ArtifactName>`                           | Present for every active contract the layer carries, and a factory's product, by the names in `src/core/abi-names.ts`.                                                                                    |
| `chains.<chainId>.retired.<address>`            | A lowercase address some layer published live; a string `contract`, a positive integer `endBlock` at or after `blockNumber` when present. An address `env/` lists, or a restated retirement, is an error. |

`txHash`, `previousRegistry.version` and `adapters` are soft fields. Retired entries carry no ABI:
the layer that published the address did.

A full snapshot has no `previousRegistry` by design. A layer records no mode, so the validator cannot
tell a deliberate snapshot from a layer that lost its link by mistake; the run tells it instead
(`fullSnapshot`, set when the generator built a full snapshot, which it only does when the run asks for
one). On **testnet**, a snapshot the run asked for passes with a warning that it replaces the published
chain: testnet is reset from time to time. On **mainnet** it is refused like any unlinked layer, and
`POST /runs` refuses `"mode": "full"` for mainnet up front: a mainnet reset would strand every consumer
walking its chain, and is not something a run does. An unlinked layer nobody asked for is an orphan on
both.

## Delta invariants

Structural validity is not enough: a layer restating contracts already published is well-formed, which
is how a near-full snapshot once shipped as a delta three times. `src/core/invariants.ts` also checks
what a layer means, against the accumulated chain:

| Invariant                                                                                                 | Severity | Catches                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projection**: the chain plus the layer reproduces every contract `env/` lists, at its address and block | error    | an omitted change, an invented address, a block that disagrees with `env/`. A published contract `env/` no longer lists is kept and reported, not warned |
| **Retirements**: each `retired` entry closes a published address `env/` does not list, once               | error    | ending a current contract, an address never published, restating a published retirement (a changed `endBlock` is a correction and warns)                 |
| **Minimality**: no entry restates the published address and block                                         | error    | a delta inflated toward a snapshot; re-tombstoning a retired contract                                                                                    |
| **ABI coverage**: every live contract resolves to an ABI in the chain or the layer                        | error    | a contract no indexer can decode                                                                                                                         |
| **Size**: the layer carries more than 30% of published contracts                                          | warning  | the symptom a human notices first; expected for a release that redeploys everything                                                                      |

The stats land in the validation report's `summary.delta` and in the preview's **Delta size** row.
The invariants are skipped for full snapshots, and warn instead of failing when the chain cannot be
reconstructed (generation refuses in that case anyway).

## Examples

### A delta carrying old tombstones

A trimmed delta from when some v3.0 contracts were removed in v3.1, back when the generator wrote
`address: null` for a key missing from `env/`. Such layers are part of the published chains, so
consumers still meet them. Only chains with changes appear under `chains`, and `abis` lists only the
ABIs the layer needs:

```json
{
  "network": "mainnet",
  "version": "v3.1",
  "previousRegistry": {
    "version": "3",
    "ipfsHash": "bafybeief457bljpdmydiyizgyck6bwf2a5y2rfnlhxsqzxosdlaecokogu"
  },
  "abis": { "Hub": ["..."], "Spoke": ["..."] },
  "chains": {
    "1": {
      "network": { "chainId": 1, "centrifugeId": 0 },
      "adapters": {},
      "contracts": {
        "guardian": { "address": null, "blockNumber": null, "txHash": null },
        "globalEscrow": { "address": null, "blockNumber": null, "txHash": null },
        "hub": {
          "address": "0xA4A7Bb3831958463b3FE3E27A6a160F764341953",
          "blockNumber": 24319335,
          "txHash": "0xcd4e039f241549031a78668d74cc76c4cbd7398c2686c42969a69be73c963976"
        }
      },
      "deployment": { "startBlock": 24319298 }
    }
  }
}
```

### A delta that only retires

This is how a release is closed today. No contract changes, only `retired` entries:

```json
{
  "network": "mainnet",
  "version": "v3.3.0",
  "previousRegistry": { "version": "v3.3.0", "ipfsHash": "bafy…" },
  "abis": {},
  "chains": {
    "1": {
      "network": { "chainId": 1, "centrifugeId": 1 },
      "adapters": {},
      "contracts": {},
      "retired": {
        "0xa4a7bb3831958463b3fe3e27a6a160f764341953": {
          "contract": "hub",
          "blockNumber": 24319335,
          "endBlock": 25900000
        },
        "0x19a524d03aa94ecee41a80341537bcfcb47d3172": {
          "contract": "gateway",
          "blockNumber": 24319303,
          "endBlock": 25900000
        }
      },
      "deployment": { "startBlock": 24319298 }
    }
  }
}
```

## Reading the registry

- **Full reconstruction:** walk `previousRegistry.ipfsHash` back from the newest layer, then merge
  `abis` and `chains` oldest first, newer overriding, and `retired` per address.
- **Selective loading:** from a layer you already hold, the next one is exactly what changed at its
  version: swap ABIs only for the contracts it carries.
- **One layer on its own:** `registry.abis.<ArtifactName>`,
  `registry.chains[chainId].contracts.<name>.address`, and `blockNumber` for where its listener starts.
- **Retired contracts:** end the listener for an address at its `endBlock`, and never derive an end
  block from the next release on your own. An address with no `retired` entry is open.
- **Old tombstones** keep their meaning for consumers that handle them.
- **Verifying what you read:** `@centrifuge/registry-core`'s `verifyLayer` proves the bytes are the
  ones a CID names, so a consumer that pins a head can trust every layer under it (see the README's
  Package section).
