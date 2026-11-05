# The registry format

This file describes what a published layer contains, how the Worker computes a layer from
protocol-internal's `env/`, and every rule that a layer must pass. The code is in `src/core/`.
[how-it-works.md](how-it-works.md) describes the flow around it.

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

A registry is a chain of layers on IPFS. Each layer carries only what changed since the previous
layer, and names that layer by CID in `previousRegistry.ipfsHash`. The first layer is a base snapshot,
with `previousRegistry: null`. The chain makes three uses possible:

- selective loading: a layer is what changed at its version.
- version-aware indexing.
- full reconstruction, by a walk back to the base.

Every layer declares its `network`. Nothing else in the format ties a layer to an environment. So a
walk refuses a layer of the other network, with no override. Mixed networks would pass every later
check, the delta invariants too, because those checks compare against the same accumulated state. A
layer with no `network` field is unknown, not wrong, so an old base snapshot without the field cannot
fail a run.

A run refuses a CID from a published document (`previousRegistry.ipfsHash`) unless it is a plain
alphanumeric CID. The check happens before the CID reaches a gateway URL or a cache key.

The Worker fetches layers from the Pinata gateway of Centrifuge. The fallbacks are the shared gateway
of Pinata, `ipfs.io` and `dweb.link`, so one unreliable gateway cannot fail a run. The contents of a CID
never change, so the Worker caches every fetched layer by CID. The Worker uses `layers/<cid>.json` in
R2. Local runs use `cache/registry-chain/`.

## What "changed since" is measured against

The Worker computes a layer against the **accumulated state of the whole published chain**. The
generator walks `previousRegistry.ipfsHash` from the live layer back to the base snapshot. It merges
every layer, newest winning, to rebuild the state that an indexer holds. Only then does it compare
protocol-internal's `env/` against that state.

A comparison against the newest layer alone would be wrong. Each layer carries only its own changes, so
everything that the newest layer does not carry would read as new. A small deploy would then emit a
near-full snapshot. The next run would compare against that large layer, so successive publishes would
alternate between complementary halves of the contract set. The comparison would also lose the
retirements already in force, which only the whole chain knows.

- **The run cannot walk the whole chain:** a broken pointer, an unreachable layer, a cycle, or more
  than 500 layers. Generation then refuses to emit an inflated delta. `allowPartialChain` overrides this for a
  manual run. Then expect the run to emit published contracts again, and to emit retirements in force
  again or miss them.
- **The run cannot read the live layer:** generation refuses, with no override. There would be nothing
  to compare against, and every contract would read as new. The layer would also carry
  `previousRegistry: null`, so an outage would look like a base registry. To publish a base snapshot on
  purpose, use full mode.

The walk costs one fetch per layer that is not in the cache. Mainnet has about 15 layers, testnet about 50.

## Modes

| Mode    | `version`                              | `previousRegistry` | When                                                                                                 |
| ------- | -------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| `delta` | the env's version, normalized `vX.Y.Z` | the live layer     | the env's version is newer than the version of the live layer                                        |
| `patch` | `null`                                 | the live layer     | the env's version equals the version of the live layer: a multi-PR release, a missed contract, a fix |
| `full`  | the env's version                      | `null`             | a base snapshot, on request                                                                          |

`auto`, the default, picks `patch` when the env's version equals the version of the live layer. It picks
`delta` otherwise. A live patch layer has no version, so after a patch, `auto` picks `delta`. api-v3
collapses consecutive layers with the same version, so an indexer sees one version either way.

To force a mode, give a manual run a `mode`:

- `delta` appends a layer even when the versions match.
- `patch` forces a null-version layer. It is refused when nothing is live.
- `full` makes a snapshot.

The **env's version** is the highest contract `version` that a config of the network records in
protocol-internal's `env/`. So a
layer built from configs that record only an older contract (`root`, for example) carries the version
of that contract. The Worker does not publish a layer that changes nothing, whatever its version says.

A **patch** has `version: null` and points at the live layer. api-v3's
`mergeNullVersionPatchesIntoPredecessors` folds it into its predecessor. So a patch replaces the last
layer, and orphans nothing on IPFS.

`previousRegistry.version` labels the link with the newest version that the walked chain names. That is
the version of the live layer, unless the live layer is a patch. The label is informational. Readers
follow `ipfsHash`.

A **full snapshot** starts the chain again, so an indexer that rebuilds from it never sees the earlier
layers. For this reason, full mode still reads the published chain:

- It refuses a snapshot that would drop a published contract that is live and unretired (one that
  protocol-internal's `env/` no longer lists). The refusal names those contracts.
- It keeps every published retirement in the snapshot.

`allowHistoryDrop` overrides the refusal for the one case where the drop is the purpose. That case is
a switch of protocol-internal's `env/registry.json` to another deployment, which changes every address
in the registry. A snapshot made while no layer is reachable carries no history, and says so. While a
registry is live, only a testnet snapshot passes the orphan rule (see
[Indexer hard requirements](#indexer-hard-requirements)).

The report of the run and the `summary.mode` of the validation report give the chosen mode.

## What counts as a change

A contract in protocol-internal's `env/` is part of the layer when the accumulated state does not
already hold it as written. That is, when:

- it is new on that chain, or its address is different.
- `env/` states a `blockNumber` that the accumulated state does not resolve to. This includes a chain
  that carried `null` while `env/` now has a number. Without this rule, a corrected block could never
  reach the chain. The indexer would then keep starting that listener from the start block of the
  chain.

The reverse is not a change, on purpose: `env/` drops a `blockNumber` that the chain has. The entry
would then publish with `blockNumber: null`. An indexer merge takes leaf nulls literally, so it would
erase the published number.

## A contract missing from env is kept

A contract that is live in the accumulated state but absent from protocol-internal's `env/` stays
**kept**, exactly as published:

- the generator lists it.
- the projection invariant reports it (`stats.keptByChain` in the validation report), not as a warning.
- the preview shows it in a collapsed section.

Deploy scripts write `env/`, and they record what they deployed and nothing else. The `REPLACE` run of a
release drops every contract it did not deploy again. A cleanup can drop a key. Neither tells whether
the contract is in use.

A retirement by absence once retired the v3.1 on/off-ramp factory while 93 managers still used it
(protocol-internal#407). It also once published a layer that retired the whole protocol, from configs
that recorded only `root`. So retirement is a declaration.

## Retirement

A chain retires contracts once nothing needs their events. That is a whole release once every pool
migrated from it, or one contract that is confirmed out of use. This is a decision about a previous
release, made after the fact. So someone writes it down, and the Worker does not infer it. The
declaration sits beside the configs, not in one, because a deploy run writes a config again in full.

The file is protocol-internal's `env/<environment>/retired.json`. Its keys are network names, which
resolve through the configs in the same directory. A key that matches no `<network>.json` there is an
error, never a skip. The schema check refuses a `retired` key inside a config.

```json
{
  "ethereum": { "v3.2.0": { "endBlock": 25900000, "reason": "All pools migrated to v3.3" } },
  "base": { "v3.2.0": { "endBlock": 41900000, "except": ["spoke", "vaultRegistry"] } },
  "arbitrum": { "0x2539e60b0b50d7bd004a09e9d2b7e8c86eb0aaf6": { "endBlock": 430000000 } }
}
```

Under a network, a key is a layer version or one address.

**A version** closes every address that a layer published for the chain, up to the last layer of that
version. It does not close an address that:

- `env/` still lists under any key. Root, kept across a release and registered again at the same
  address, is one example.
- a later layer publishes again. Such an address is registered again, so it is current in a newer
  release.
- `except` names, by contract name or address.
- an old tombstone under its name already shadowed. The old way retired it, and the consumer handles it.

A version key is the exact `version` label of a layer. Only `vX.Y.Z` labels are accepted. Of the labels
published so far (`3`, `v3.1`, `v3.1-rev2`, `v3.1.0`, `v3.2.0`, `v3.3.0`), that means `v3.1.0` and
later. Retire a contract from an older layer by address.

**An address** closes that one address. The chain must have published it, and `env/` must not list it.
An address declaration overrides a version declaration for the same address.

A fully migrated chain needs only its version line. The v3.3 migration announces every share token and
vault that moves to v3.3 again, on the v3.3 `spokeRegistry`. So the v3.2 `spoke` and `vaultRegistry` close
with the rest, and the indexer finds tokens and vaults through their new factory. A chain with a pool
left behind is the one case for `except`. An `except` entry that matches nothing is an error, because a
typo there would close what the entry meant to protect.

Both forms publish the same entry under the chain. The key is the lowercase address, because releases
use a name again. So a consumer never sees how the retirement was declared:

```json
"retired": {
  "0xa4a7bb3831958463b3fe3e27a6a160f764341953": { "contract": "hub", "blockNumber": 24319335, "endBlock": 25900000 }
}
```

**The file is a ledger.** Declarations stay once published, and every publish run evaluates them again.
So they are idempotent:

- An address already published with the same `endBlock` is in force. The run does not emit it again,
  and logs it as in force, not as a warning.
- A changed `endBlock` is emitted again, as a correction.

The published chain is the record that indexers read. The file and its git history are the record of
who decided what, and why. The run never publishes `reason`.

The run checks each declaration against what the chain published. These are errors:

- a version that no layer carries.
- an `endBlock` before the deploy block of an address.
- a declaration that closes an address that `env/` lists.
- an address that no layer published.
- an `except` entry that matches nothing.

A declaration that closes nothing at all is a warning. The preview counts the retirements that a PR
would publish, so reviewers see the list before the run publishes it.

**Old tombstones** (`address: null` under a contract name, written by earlier releases) stay valid in
published layers, and still shadow. They carry no ABI. Nothing writes new ones.

## Versions, tags and ABIs

Each contract in a config in protocol-internal's `env/` records a `version`. The version resolves to a git tag of protocol-internal
(`3` → `v3`, `v3.1` → `v3.1.0`), and the ABI comes from the build of that tag. So a chain that mixes
releases gets the right ABI for every contract. Every version must resolve to a tag that exists. The run
waits for the ABI bundle of that tag (see [operations.md](operations.md#abis)).

### Deployments made before their release is tagged

A testnet deployed on a release that is still open records `"version": "v3.3"` for a `v3.3` tag that
does not exist yet. Once the tag exists, the testnet must not borrow it, because its contracts are the
release candidate, not the release. The directory states which tag backs each version, in
protocol-internal's `env/<environment>/versions.json`:

```json
{ "tags": { "v3.3": "v3.3.0-rc2" } }
```

The file is per directory, because a directory is a deployment. The same `v3.3` means the release in
protocol-internal's `env/mainnet/`, and the candidate in a testnet directory that deployed before the release. An
alias replaces the candidate list, and does not prepend to it. So the lookup never reaches a tag with
the name of the version behind the alias. The file sits with the configs, so it stays valid after
`env/registry.json` points elsewhere.

The tag must hold the source that the deployment ran, and the alias is the only record of that commit.
A config records no deployment metadata, so nothing can check the alias against what was deployed. The
order is:

1. Deploy.
2. Tag the commit.
3. Point the alias at the tag.

A review of the alias is a review of that claim. The `env/` check verifies what it can: the tag exists,
and every alias redirects a version that some contract records. A later deploy from different source
needs its own tag and version label.

**Retire an alias by pointing it at the release, never by deleting it.** If you drop the entry once
`v3.3.0` exists, the tag of the release then backs the deployment. That tag must not claim the
contracts of the candidate without notice. Point the alias at the release instead
(`{ "tags": { "v3.3": "v3.3.0" } }`). The check then proves that the release carries the deployed
source, or fails. An alias lives as long as its directory.

There are two limits:

- A delta ships only the contracts whose address or block changed, and ABIs only for those. So when you
  point an alias at a new tag for unchanged addresses, the run ships no new ABIs. To correct a published alias,
  publish a full snapshot.
- A `versions.json` goes in the same PR as the configs it describes. Before the release tag exists, it
  must, because without it the tag check fails.

### ABI names

ABIs use the artifact name as key: the contract key, capitalized. A few aliases are in one table,
`src/core/abi-names.ts`:

- `token` → `ShareToken`, `fullRestrictionsHook` → `FullRestrictions`, `navManager` → `NAVManager`, and
  the hook names.
- each `<adapter>Standby` → `StandbyAdapter`, and its `<adapter>StandbyUnderlying` → the adapter it
  wraps.

A factory also ships the ABI of its product (`tokenFactory` → `TokenFactory` + `ShareToken`).
Generation, validation and the ABI-gap check all use that table.

## ABI gaps and how they heal

A layer could once publish with an ABI missing. That left a contract in the chain that no indexer could
decode. While the Worker computed layers against the newest layer alone, such a gap healed by accident.
Nearly every contract counted as changed on every run, so its ABI shipped again. The comparison against
the accumulated state removed that accident. A gap would then stay forever, because nothing emits an
unchanged contract again. Two mechanisms replace the accident:

1. **Healing.** A run adds to the layer a contract that is active in protocol-internal's `env/` and
   whose required ABI names are in no layer's `abis`. It does so even when the address did not move. The
   summary counts these contracts separately.
2. **Detection.** The ABI-coverage invariant gives an error if a live contract still has no ABI after
   the layer. So a gap that cannot heal (a misnamed artifact, for example) fails and does not ship.

Healing restates an unchanged contract on purpose, which the minimality invariant would otherwise
refuse. For that case, the invariant gives a warning that names the ABI the layer ships. Retired
contracts need no ABI.

## The chain's start block

`chains.<chainId>.deployment.startBlock` is the only deployment metadata that a layer carries. It is the
earliest `blockNumber` among every active contract that the config of the chain records, not only the
contracts in the layer. Generation derives it.

Configs in protocol-internal's `env/` hold `network`, `adapters` and `contracts`, and nothing else.
Every contract has an integer `blockNumber`. The schema check refuses any other top-level key, and a
contract without a block. Generation also refuses a config with a contract that has no block. Published layers do not
carry deploy-time fields (`network.environment`, `network.namespace`, per-contract `version`). Layers
published before configs stopped recording deployment metadata also carry `deploymentInfo: { gitCommit }`
and `deployment.deployedAt`.

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

Generation and publishing keep integers above 2^53 (the `chainSelector` of an adapter) exact.

## Indexer hard requirements

`src/core/validate.ts` checks every layer against what indexers need. The rules apply to **active**
contracts, which have a non-null `address`. Old tombstones skip the address, block and ABI rules.

| Field                                           | Rule                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                       | A non-empty string for delta and full layers. `null` for a patch, and only with `previousRegistry.ipfsHash` set.                                                                                                                         |
| `previousRegistry.ipfsHash`                     | Set whenever a registry is live for the network, because a layer without it would be an orphan. Absent only for a base snapshot, which a live registry allows on testnet alone.                                                          |
| `chains.<chainId>.deployment.startBlock`        | A number.                                                                                                                                                                                                                                |
| `chains.<chainId>.contracts.<name>.address`     | A 20-byte address for every active contract.                                                                                                                                                                                             |
| `chains.<chainId>.contracts.<name>.blockNumber` | A number for every active contract. A null block is a warning when the chain has a start block to use instead.                                                                                                                           |
| `abis.<ArtifactName>`                           | Present for every active contract that the layer carries, and for the product of a factory, by the names in `src/core/abi-names.ts`.                                                                                                     |
| `chains.<chainId>.retired.<address>`            | A lowercase address that some layer published live. A string `contract`. A positive integer `endBlock`, at or after `blockNumber` when present. An address that protocol-internal's `env/` lists, or a restated retirement, is an error. |

`txHash`, `previousRegistry.version` and `adapters` are soft fields. Retired entries carry no ABI,
because the layer that published the address carried it.

A full snapshot has no `previousRegistry`, by design. A layer records no mode, so the validator cannot
tell a deliberate snapshot from a layer that lost its link by mistake. The run tells the validator
instead, with `fullSnapshot`. The run sets it when the generator built a full snapshot, which the
generator does only when the run asks for one.

- On **testnet**, a snapshot that the run asked for passes, with a warning that it replaces the
  published chain. Testnet is reset from time to time.
- On **mainnet**, the validator refuses it like any unlinked layer. `POST /runs` also refuses
  `"mode": "full"` for mainnet before the run starts. A mainnet reset would strand every consumer that
  walks its chain, and a run never does one.
- On both networks, an unlinked layer that nobody asked for is an orphan.

## Delta invariants

Structural validity is not enough. A layer that restates contracts already published is well-formed,
and a near-full snapshot once shipped as a delta three times that way. So `src/core/invariants.ts` also
checks what a layer means, against the accumulated chain:

| Invariant                                                                                                                     | Severity | Catches                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Projection**: the chain plus the layer gives every contract that protocol-internal's `env/` lists, at its address and block | error    | an omitted change, an invented address, a block that does not agree with `env/`. A published contract that `env/` no longer lists stays kept, and is reported, not warned about |
| **Retirements**: each `retired` entry closes, once, a published address that `env/` does not list                             | error    | the end of a current contract, an address never published, a restated published retirement (a changed `endBlock` is a correction, and warns)                                    |
| **Minimality**: no entry restates the published address and block                                                             | error    | a delta inflated toward a snapshot, or a tombstone again on a retired contract                                                                                                  |
| **ABI coverage**: every live contract resolves to an ABI in the chain or the layer                                            | error    | a contract that no indexer can decode                                                                                                                                           |
| **Size**: the layer carries more than 30% of published contracts                                                              | warning  | the symptom a person notices first. Expected for a release that deploys everything again                                                                                        |

The stats go into `summary.delta` of the validation report, and into the **Delta size** row of the
preview. Full snapshots skip the invariants. When the run cannot rebuild the chain, the invariants warn
and do not fail, and generation refuses in that case anyway.

## Examples

### A delta carrying old tombstones

This is a shortened delta from the time when v3.1 removed some v3.0 contracts. Back then, the generator
wrote `address: null` for a key missing from protocol-internal's `env/`. Such layers are part of the
published chains, so consumers still meet them. Only chains with changes appear under `chains`. `abis`
lists only the ABIs that the layer needs:

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

This is how a release closes today. No contract changes. The layer carries only `retired` entries:

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

- **Full reconstruction:** walk `previousRegistry.ipfsHash` back from the newest layer. Then merge
  `abis` and `chains`, oldest first, newer overriding. Merge `retired` per address.
- **Selective loading:** from a layer you already hold, the next layer is exactly what changed at its
  version. Replace the ABIs only for the contracts it carries.
- **One layer on its own:** read `registry.abis.<ArtifactName>`,
  `registry.chains[chainId].contracts.<name>.address`, and `blockNumber`, where the listener starts.
- **Retired contracts:** end the listener for an address at its `endBlock`. Never derive an end block
  from the next release on your own. An address with no `retired` entry is open.
- **Old tombstones** keep their meaning for consumers that handle them.
- **Verifying what you read:** `verifyLayer` in `@centrifuge/registry-core` proves that the bytes are
  the ones a CID names. So a consumer that pins a head can trust every layer under it (see the README's
  Package section).
