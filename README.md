# protocol-registry

Publishes the Centrifuge contract registry: every deployed protocol contract, per chain, with its ABI,
deploy block and, once out of use, the block its indexer listener ends at. Indexers such as
[api-v3](https://github.com/centrifuge/api-v3) read it from **registry.centrifuge.io** (mainnet) and
**registry.testnet.centrifuge.io** (testnet).

The registry is generated from the env configs that protocol-internal's deploy scripts write. This
repository holds the generator and runs it as a Cloudflare Worker, triggered by GitHub. It replaces
`script/registry/` and the `registry.yml` workflow, which each live branch of protocol-internal used to
carry a copy of.

- [How it works](#how-it-works)
- [Inputs: protocol-internal's env/](#inputs-protocol-internals-env)
- [The published registry](#the-published-registry)
- [ABIs](#abis)
- [Setup](#setup)
- [Operations](#operations)
- [Moving off protocol-internal's pipeline](#moving-off-protocol-internals-pipeline)
- [Development](#development)

## How it works

```
GitHub App webhooks ──► Worker ──► Publisher (Durable Object, one publish at a time)
  push to the release branch          │
  pull request into it                ▼
  release tag created            RegistryRun (Workflow, durable steps, each retried on its own)
cron, every 6 hours                   1. the commit: the PR head, or the release branch head
manual POST /runs                     2. env/ at that commit, checked: schema, retired.json, version tags
                                      3. ABIs for every tag env uses, built on demand (build-abis.yml)
                                      4. each network: walk the published chain, generate, validate
                                      5a. preview → the PR's "Registry preview" check run
                                      5b. publish → pin to Pinata, point the hostname's dnslink, Slack
```

- **Pushes** to the release branch (`SOURCE_BRANCH` in `wrangler.jsonc`) that touch `env/` start a
  publish. A publish always generates from the branch head, so triggers that arrive while one runs
  collapse into a single run after it.
- **Pull requests** into the release branch get a **Registry preview** check run on their head: the
  layer each network would get, its retirements, and every finding. It fails when the layer would
  break the indexer, so making it a required check keeps bad env out of the branch.
- **The cron** reconciles every six hours: a delivery GitHub dropped or a run that failed is retried
  without anyone noticing it first. A run that finds nothing to publish says nothing; one refused for
  the same reason as the last time does not repeat itself.
- **Before swapping the dnslink**, a publish checks the hostname still serves the CID its layer was
  built on. If anything else published in between, it stops and says so rather than orphaning that
  layer.
- **`PUBLISH_ENABLED`** set to anything but `"true"` stops a publish after generation and posts what
  it would have published; the layers stay in R2 under `runs/<run id>/`.

The generator (`src/core/`) is a port of `script/registry/` from protocol-internal at
[centrifuge/protocol-internal#460](https://github.com/centrifuge/protocol-internal/pull/460), verified
to produce byte-identical layers and validation reports (see the commit that added it). It has no
I/O of its own: env arrives as a snapshot, the chain through a layer fetcher, tags, commits, ABIs and
explorer data through injected functions. `src/io/` holds those clients, `src/run.ts` the steps, and
`scripts/generate.ts` runs the same thing locally.

## Inputs: protocol-internal's env/

Everything the registry says comes from `env/` on the release branch of
[protocol-internal](https://github.com/centrifuge/protocol-internal):

| File                               | Written by     | Says                                                                                                                                                       |
| ---------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env/<environment>/<network>.json` | deploy scripts | what is deployed on a chain: contracts with address, block and `version`                                                                                   |
| `env/registry.json`                | people         | which directory each registry publishes: `{ "mainnet": "mainnet", "testnet": "testnet-rev2" }`; a missing entry means the directory of the registry's name |
| `env/<environment>/versions.json`  | people         | which git tag backs a version, for a deployment made before its release was tagged: `{ "tags": { "v3.3": "v3.3.0-rc2" } }`                                 |
| `env/<environment>/retired.json`   | people         | which contracts are out of use, and the block their listeners end at (see [Retirement](#retirement))                                                       |

A contract's `version` resolves to a git tag (`3` → `v3`, `v3.1` → `v3.1.0`, or the alias), and its
ABI is built from that tag. An aliased tag must hold the same `src/` (minus `src/spell/`) and
`src-ir/` as the commit the deployment recorded under `deploymentInfo`: the check compares the two
source trees, so a wrong alias fails rather than quietly publishing ABIs of other code. Retire an alias
by re-pointing it at the release tag, never by deleting it: only an aliased version is checked.

## The published registry

### Delta format

Each published document — a **layer** — carries only what changed since the previous one and points
at it with `previousRegistry.ipfsHash`, forming a chain back to a base snapshot. An indexer walks the
chain and merges every layer, newest winning.

A delta is computed against that **accumulated state of the whole chain**, never against the tip
document alone: the tip carries only its own changes, so comparing against it marks everything it
omits as new, and successive publishes oscillate between complementary halves of the contract set.
If the chain cannot be walked in full — a broken pointer, an unreachable layer, a cycle, more than 500
layers — generation is refused rather than emitting an inflated delta (`allowPartialChain` overrides
this for a manual run). If the tip itself cannot be read, generation is refused with no override:
there is nothing to measure against, and the result would present an outage as a base registry. Every
layer must declare the network being generated; a layer of the other network fails the run.

Fetched layers are cached in R2 by CID (`layers/<cid>.json`), since a CID's contents never change.

### Modes

| Mode    | `version`                              | `previousRegistry` | When                                                                                                                 |
| ------- | -------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `delta` | the env's version, normalized `vX.Y.Z` | the tip            | the env's version is newer than the tip's                                                                            |
| `patch` | `null`                                 | the tip            | the env's version equals the tip's; api-v3's `mergeNullVersionPatchesIntoPredecessors` folds it into its predecessor |
| `full`  | the env's version                      | `null`             | a base snapshot, on request                                                                                          |

`auto` (the default) picks `patch` or `delta`. A full snapshot restarts the chain, so it still reads
the published chain: it refuses when it would drop a published, unretired contract env no longer lists,
and carries every retirement forward. `allowHistoryDrop` overrides the refusal for the one case where
dropping is the point, `env/registry.json` switching a registry to another deployment.

### Retirement

**A contract missing from env is kept**, exactly as published. Env is written by deploy scripts that
record what they deployed, and a release's `REPLACE` run drops every contract it did not redeploy, so a
missing key says nothing about whether a contract is still in use. (Tombstoning on absence once retired
the v3.1 on/off-ramp factory while 93 managers still used it.)

Retirement is declared, per chain, in `env/<environment>/retired.json`, keyed by network name:

```json
{
  "ethereum": { "v3.2.0": { "endBlock": 25900000, "reason": "All pools migrated to v3.3" } },
  "base": { "v3.2.0": { "endBlock": 41900000, "except": ["spoke", "vaultRegistry"] } },
  "arbitrum": { "0x2539e60b0b50d7bd004a09e9d2b7e8c86eb0aaf6": { "endBlock": 430000000 } }
}
```

- **A version** (an exact `vX.Y.Z` layer label) closes every address published at or before the last
  layer of that version, except one env still lists, one a later layer publishes again, one `except`
  names (by contract name or address), or one an old tombstone already shadowed.
- **An address** closes that address; it must have been published on the chain and not be in env.
  It overrides a version declaration for the same address.

Both publish the same entry under the chain, keyed by lowercase address because a name is reused
across releases:

```json
"retired": {
  "0xa4a7bb3831958463b3fe3e27a6a160f764341953": { "contract": "hub", "blockNumber": 24319335, "endBlock": 25900000 }
}
```

The file is a ledger: declarations stay, and are evaluated on every publish. One already published
with the same `endBlock` is in force and not emitted again; a changed `endBlock` is published as a
correction. A version no layer carries, an `endBlock` before a deploy block, an address env still
lists or no layer published, and an `except` entry that matches nothing are errors. `reason` is never
published. Consumers should end a listener at `endBlock` and never infer one from the next release:
pools migrate one by one, so a contract absent from a newer layer is in use until it is retired.

Old layers also carry tombstones (`address: null` under a contract name), written by earlier releases.
They keep their meaning; none are written any more.

### Schema

```typescript
interface Registry {
  network: "mainnet" | "testnet";
  version: string | null; // vX.Y.Z; null for a patch
  deploymentInfo: { gitCommit: string }; // the latest deployment commit the configs record
  previousRegistry: { version: string; ipfsHash: string } | null; // null for a full snapshot
  abis: { [artifactName: string]: AbiItem[] }; // ABIs of the contracts this layer carries
  chains: { [chainId: string]: ChainConfig }; // only chains this layer changes
}

interface ChainConfig {
  network: { chainId: number; centrifugeId: number; protocolAdmin?: string; opsAdmin?: string };
  adapters: { [adapter: string]: object }; // deploy-only fields removed
  contracts: {
    [contractName: string]: {
      address: string | null; // null only in old tombstones
      blockNumber: number | null; // creation block
      txHash: null; // no longer recorded; kept for schema stability
    };
  };
  retired?: {
    [lowercaseAddress: string]: { contract: string; blockNumber?: number; endBlock: number };
  };
  deployment: { deployedAt: number | null; startBlock: number | null };
}
```

ABIs are keyed by artifact name: a contract key capitalized, with a few aliases (`token` →
`ShareToken`, `fullRestrictionsHook` → `FullRestrictions`, see `src/core/abi-names.ts`), and a factory
also ships its product (`tokenFactory` → `TokenFactory` + `ShareToken`).

### Checks on every layer

Indexer hard requirements (`src/core/validate.ts`): a string `version` (null only for a patch), a
`previousRegistry.ipfsHash` whenever a registry is live, a numeric `deployment.startBlock`, a 20-byte
address and numeric `blockNumber` for every active contract (a null block is a warning when the chain
has a start block to fall back to), well-formed `retired` entries, and an ABI for every active
contract.

Delta invariants (`src/core/invariants.ts`), against the published chain:

| Invariant                                                                  | Severity | Catches                                                                                               |
| -------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| Projection: chain + layer reproduces every env contract, address and block | error    | an omitted change, an invented address. A published contract env no longer lists is kept and reported |
| Retirements: each closes a published address env does not list, once       | error    | ending a current contract, an address never published, restating a retirement                         |
| Minimality: no entry restates the published address and block              | error    | a delta inflated toward a snapshot                                                                    |
| ABI coverage: every live contract has an ABI somewhere in the chain        | error    | a contract no indexer can decode                                                                      |
| Size: the layer carries over 30% of published contracts                    | warning  | the symptom a human notices first                                                                     |

An unchanged contract whose ABI the chain never carried is re-emitted to ship it: a gap would
otherwise be permanent, since nothing re-emits an unchanged contract. The minimality check allows that
case and names the ABI it ships.

## ABIs

A Worker cannot run git or forge, so ABIs are built ahead of time, once per protocol-internal tag, by
[`.github/workflows/build-abis.yml`](.github/workflows/build-abis.yml): it checks out the tag, runs
`forge build` (and the `ir` profile, for `src-ir/`), and writes one R2 object per artifact,
`abis/<tag>/<Artifact>.json`, then `abis/<tag>/manifest.json` with the commit it built. A run that
needs a tag without a manifest, or with a manifest from a commit the tag no longer points at, dispatches
the build and waits for it; release tags are also built as soon as they are created.

`scripts/build-abi-bundle.ts` turns a forge build into a bundle; where two sources define an artifact
of the same name, the first in sorted order wins, skipping tests, as the old ABI cache did.

## Setup

What exists outside this repository, and where it is managed:

| What                                                                                                                  | Where                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| R2 bucket `centrifuge-protocol-registry` (Official account)                                                           | ops-v3, `cloudflare/terraform/Centrifuge Official (prod)/platform/r2.tf`                     |
| The Worker's custom domain (the webhook URL)                                                                          | ops-v3, a `cloudflare_workers_custom_domain`                                                 |
| Bucket-scoped R2 token, pushed as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` to this repo's `production` environment | ops-v3, `cloudflare/scripts/manage-api-tokens/tokens.yaml`                                   |
| Web3 hostnames token (`CLOUDFLARE_API_TOKEN`)                                                                         | ops-v3 `tokens.yaml`, "ops-v3 control web3 hostnames and DNS"                                |
| Worker secrets                                                                                                        | 1Password, item "protocol-registry Worker" in `Infrastructure secrets`; see `.env.1password` |
| The GitHub App                                                                                                        | GitHub organization settings                                                                 |

**GitHub App.** Installed on protocol-internal and protocol-registry, with webhook URL
`https://<custom domain>/webhooks/github` and a webhook secret. Permissions: Contents read, Checks
write, Pull requests read, Actions write (to dispatch `build-abis.yml`), Metadata read. Events: Push,
Pull request, Check run, Create. Its private key is PKCS#1 as downloaded; the Worker needs PKCS#8
(`openssl pkcs8 -topk8 -nocrypt -in app.pem`). For `build-abis.yml`, this repository's `production`
environment needs the variable `REGISTRY_APP_CLIENT_ID` and the secret `REGISTRY_APP_PRIVATE_KEY`.

**Secrets.** With the 1Password item in place:

```bash
NODE_SHIMS_MODE=local scripts/push-secrets.sh --profile centrifuge-prod
```

**Deploy.**

```bash
NODE_SHIMS_MODE=local pnpm exec wrangler deploy --profile centrifuge-prod
```

Variables live in `wrangler.jsonc`; changing one (`SOURCE_BRANCH` at a release, `PUBLISH_ENABLED` at
the cutover) is a commit and a deploy.

## Operations

Manual runs and status need the bearer token (`MANUAL_TRIGGER_TOKEN`):

```bash
# What would be published from the release branch head, without publishing
curl -sX POST https://<host>/runs -H "Authorization: Bearer $TOKEN" -d '{"kind":"preview"}'
curl -s https://<host>/runs/<id> -H "Authorization: Bearer $TOKEN" | jq -r .report

# Publish now (queued behind a running publish)
curl -sX POST https://<host>/runs -H "Authorization: Bearer $TOKEN" -d '{"kind":"publish"}'

# A base snapshot of one network; allowHistoryDrop only when replacing the deployment on purpose
curl -sX POST https://<host>/runs -H "Authorization: Bearer $TOKEN" \
  -d '{"kind":"publish","networks":["testnet"],"mode":"full"}'

# The publisher: active run, pending run, the last 20
curl -s https://<host>/status -H "Authorization: Bearer $TOKEN"
```

`POST /runs` takes `kind`, and optionally `networks`, `mode` (`auto`, `delta`, `patch`, `full`),
`sourceCid` (build on that CID instead of the tip; one network), `allowPartialChain`,
`allowHistoryDrop`, and for a preview `sha`. A run's layers are at
`GET /runs/<id>/registry-<network>.json` and `.validation.json`.

**Locally**, with a protocol-internal checkout and a directory of ABI bundles:

```bash
node scripts/generate.ts mainnet --source-repo ../protocol-internal --abis ./abis [--mode full] [--source-cid <cid>]
```

It writes `out/registry-<network>.json` and its validation report, and publishes nothing.

**Auditing the chain:** `curl -s https://registry.centrifuge.io | jq .previousRegistry` gives the next
CID; `dig TXT _dnslink.registry.centrifuge.io +short` the live one.

## Moving off protocol-internal's pipeline

This follows the order of operations in
[centrifuge/protocol-internal#460](https://github.com/centrifuge/protocol-internal/pull/460), with the
Worker taking the place of re-enabling `registry.yml` on `live-v3.3`.

1. Merge #460 into `live-v3.3`; its `generate` job stays disabled.
2. ops-v3: the R2 bucket, the custom domain, the R2 token. Create the GitHub App and the 1Password
   item, push the secrets, deploy with `PUBLISH_ENABLED: "false"`.
3. Shadow period: PRs into `live-v3.3` get previews; publishes post what they would publish. The first
   run requests ABI builds for every tag env uses.
4. Once the v3.3 deployment has written the configs,
   [centrifuge/api-v3#499](https://github.com/centrifuge/api-v3/issues/499) is merged, and
   `live-v3.2`'s `generate` job is disabled (its generator still tombstones on absence and would undo a
   v3.3 layer): set `PUBLISH_ENABLED: "true"` and deploy. The Worker is the only publisher from then on.
5. Remove `script/registry/`, `registry.yml`, the `detect-*` CI scripts and main's
   `registry-publish.yml` from protocol-internal; drop protocol-internal as a destination of the Web3
   token in ops-v3 and rotate it; make **Registry preview** a required check on the release branch.

Where the Worker differs from the scripts it replaces:

- The preview is a check run instead of a PR comment, and it can block a merge.
- A manual publish no longer pins a layer with validation errors; errors are never bypassed.
- The tip is read by CID from the hostname's dnslink and fetched through IPFS, instead of over HTTP
  with the CID resolved separately, so the layer and its `previousRegistry.ipfsHash` always agree.
- A publish refuses when the hostname moved while it ran.
- Explorer lookups of creation blocks are cached, since they never change.

## Development

```bash
pnpm install
pnpm test        # node --test; no network
pnpm typecheck
pnpm lint
pnpm format:check
pnpm cf-typegen  # after changing wrangler.jsonc
```

Tests are JavaScript, as the scripts they came from tested with node:test, and run the TypeScript
sources directly (Node 22.18+). Fixtures are built inline, so each test's input sits next to its
assertions.
