# protocol-registry

Publishes the Centrifuge contract registry: every deployed protocol contract, per chain, with its ABI,
deploy block and, once out of use, the block its indexer listener ends at. Indexers such as
[api-v3](https://github.com/centrifuge/api-v3) read it from **registry.centrifuge.io** (mainnet) and
**registry.testnet.centrifuge.io** (testnet).

The registry is generated from the env configs that protocol-internal's deploy scripts write. This
repository holds the generator and runs it as a Cloudflare Worker, triggered by GitHub. It replaces
[`script/registry/`][pi-script-registry] and the [`registry.yml`][pi-registry-yml] workflow, which each
live branch of protocol-internal used to carry a copy of. Its layer reading and verification are also published as the package
[`@centrifuge/registry-core`](#package), for consumers that pin a registry head.

- [How it works](#how-it-works)
- [Inputs: protocol-internal's env/](#inputs-protocol-internals-env)
- [The published registry](#the-published-registry)
- [ABIs](#abis)
- [Package](#package)
- [Setup](#setup)
- [Operations](#operations)
- [Moving off protocol-internal's pipeline](#moving-off-protocol-internals-pipeline)
- [Development](#development)

The [docs](docs/) go further: [how the registry works](docs/how-it-works.md), end to end; [the
registry format](docs/registry-format.md): schema, deltas, retirement and every check; and
[operations](docs/operations.md): previews, publishes, local runs and auditing.

## How it works

```
GitHub App webhooks ──► Worker ──► Publisher (Durable Object, one publish at a time)
  push to the release branch          │
  pull request into it                ▼
cron, every 6 hours              RegistryRun (Workflow, durable steps, each retried on its own)
manual POST /runs                     1. the commit: the PR head, or the release branch head
                                      2. env/ at that commit, checked: schema, retired.json, version tags
                                      3. ABIs for every tag env uses, as protocol-internal built them
                                      4. each network: walk the published chain, generate, validate
                                      5a. preview → the PR's "Registry preview" check run
                                      5b. publish → pin to Pinata, point the hostname's dnslink, Slack
```

- **Pushes** to the release branch (`SOURCE_BRANCH` in `wrangler.jsonc`) that touch `env/` start a
  publish. A publish always generates from the branch head, so triggers that arrive while one runs
  collapse into a single run after it.
- **Pull requests** into the release branch that touch `env/` get a **Registry preview** check run on
  their head: the layer each network would get, its retirements, and every finding. It fails when the
  layer would break the indexer. Other PRs get no check at all, which is also why it cannot be a
  required check: a PR without one would wait on it forever.
- **The cron** reconciles every six hours: a delivery GitHub dropped or a run that failed is retried
  without anyone noticing it first. A run that finds nothing to publish says nothing, and one that
  would say the same as the last cron run does not repeat itself.
- **Before swapping the dnslink**, a publish checks the hostname still serves the CID its layer was
  built on. If anything else published in between, it stops and says so rather than orphaning that
  layer.
- **`PUBLISH_MODE`** decides how far a publish goes, one stage at a time:

  | Mode                                      | Generates | Pins to IPFS | Points the hostname | Needs                                |
  | ----------------------------------------- | :-------: | :----------: | :-----------------: | ------------------------------------ |
  | `shadow` (default, and any unknown value) |     ✓     |              |                     | —                                    |
  | `pin`                                     |     ✓     |      ✓       |                     | `PINATA_JWT`                         |
  | `live`                                    |     ✓     |      ✓       |          ✓          | `PINATA_JWT`, `CLOUDFLARE_API_TOKEN` |

  A mode without its credentials refuses rather than doing less. Until `live`, the Worker does not
  hold the Web3 hostname token at all (it reads the live CID from public DNS instead), so nothing it
  does can change what registry.centrifuge.io serves. A pinned layer nothing points at is invisible to
  consumers, which makes `pin` the place to inspect real output before going `live`.

The generator (`src/core/`) is a port of `script/registry/` from protocol-internal's `live-v3.3`, as
of [centrifuge/protocol-internal#522](https://github.com/centrifuge/protocol-internal/pull/522),
verified to produce byte-identical layers and validation reports (see the commits that ported it). It
has no I/O of its own: env arrives as a snapshot, the chain through a layer fetcher, tags and ABIs
through injected functions. `src/io/` holds those clients, `src/run.ts` the steps, and
`scripts/generate.ts` runs the same thing locally. `src/core/` also holds layer verification and
history diffing for other consumers, published as [`@centrifuge/registry-core`](#package).

## Inputs: protocol-internal's env/

Everything the registry says comes from [`env/`][pi-env] on the [release branch][pi-branch] of
[protocol-internal](https://github.com/centrifuge/protocol-internal):

| File                                    | Written by     | Says                                                                                                                                                       |
| --------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env/<environment>/<network>.json`      | deploy scripts | what is deployed on a chain: contracts with address, block and `version`                                                                                   |
| [`env/registry.json`][pi-registry-json] | people         | which directory each registry publishes: `{ "mainnet": "mainnet", "testnet": "testnet-rev2" }`; a missing entry means the directory of the registry's name |
| `env/<environment>/versions.json`       | people         | which git tag backs a version, for a deployment made before its release was tagged: `{ "tags": { "v3.3": "v3.3.0-rc2" } }`                                 |
| `env/<environment>/retired.json`        | people         | which contracts are out of use, and the block their listeners end at (see [Retirement](#retirement))                                                       |

A config holds `network`, `adapters` and `contracts`, and every contract records an integer
`blockNumber`. It records no deployment metadata: a chain's `deployment.startBlock` is the earliest
`blockNumber` among the contracts its config records, derived when a layer is generated.

A contract's `version` resolves to a git tag (`3` → `v3`, `v3.1` → `v3.1.0`, or the alias), and its
ABI is built from that tag. An alias is the deployment's own account of the source it ran, and nothing
can check it against what was deployed: deploy, tag that commit, point the alias at the tag. The check
holds that the tag exists and that every alias redirects a version some contract records. Retire an
alias by re-pointing it at the release tag, never by deleting it: without the entry, the version
resolves to the release's own tag, which must not silently claim the candidate's contracts.

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
layer must declare the network being generated; a layer of the other network, or one declaring
none, fails the run.

Fetched layers are cached in R2 by CID (`layers/<cid>.json`), so a layer is fetched from IPFS once.
The Worker's own layer fetches (`fetchRegistryFromIpfs` and that cache) do not check the bytes against
their CIDs; checking is what consumers do with the package (see [Package](#package)).

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
missing key says nothing about whether a contract is still in use.

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
  deployment: { startBlock: number | null }; // the earliest blockNumber the chain's config records
}
```

Layers published before configs stopped recording deployment metadata also carry
`deploymentInfo: { gitCommit }` and `deployment.deployedAt`.

ABIs are keyed by artifact name: a contract key capitalized, with a few aliases (`token` →
`ShareToken`, `fullRestrictionsHook` → `FullRestrictions`, `layerZeroStandby` → `StandbyAdapter`,
`layerZeroStandbyUnderlying` → `LayerZeroAdapter`, see `src/core/abi-names.ts`), and a factory
also ships its product (`tokenFactory` → `TokenFactory` + `ShareToken`).

### Checks on every layer

Indexer hard requirements (`src/core/validate.ts`): a string `version` (null only for a patch), a
`previousRegistry.ipfsHash` whenever a registry is live, a numeric `deployment.startBlock`, a 20-byte
address and numeric `blockNumber` for every active contract (a null block is a warning when the chain
has a start block to fall back to), well-formed `retired` entries, and an ABI for every active
contract.

Delta invariants (`src/core/invariants.ts`), against the published chain:

| Invariant                                                                  | Severity | Catches                                                                                                                              |
| -------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Projection: chain + layer reproduces every env contract, address and block | error    | an omitted change, an invented address. A published contract env no longer lists is kept and listed in the preview, not warned about |
| Retirements: each closes a published address env does not list, once       | error    | ending a current contract, an address never published, restating a retirement                                                        |
| Minimality: no entry restates the published address and block              | error    | a delta inflated toward a snapshot                                                                                                   |
| ABI coverage: every live contract has an ABI somewhere in the chain        | error    | a contract no indexer can decode                                                                                                     |
| Size: the layer carries over 30% of published contracts                    | warning  | the symptom a human notices first                                                                                                    |

An unchanged contract whose ABI the chain never carried is re-emitted to ship it: a gap would
otherwise be permanent, since nothing re-emits an unchanged contract. The minimality check allows that
case and names the ABI it ships.

## ABIs

A Worker cannot run git or forge, so ABIs are built ahead of time, once per release tag, by
protocol-internal's [`.github/workflows/build-abis.yml`][pi-build-abis], which runs when a tag is pushed: it checks out
the tag, runs `forge build` (and the `ir` profile, for `src-ir/`), and writes one R2 object per
artifact, `abis/<tag>/<Artifact>.json`, then `abis/<tag>/manifest.json` with the commit it built. A
tag pushed before that workflow existed is built by dispatching it by hand:

```bash
gh workflow run build-abis.yml -R centrifuge/protocol-internal -f tag=v3.2.0
```

A run that needs a tag without a manifest, or with a manifest from a commit the tag no longer points
at, waits up to an hour for a build in flight, then fails naming the tag.

Local runs read the same bundles: `scripts/generate.ts` fetches the artifacts it needs with
`wrangler r2 object get --remote`, under the operator's wrangler login, and keeps them in
`cache/abis/<tag>/`. As in the Worker, a tag whose bundle was built from a commit other than the one
the tag points at in the checkout is refused. Which artifact wins when two sources define the same
name is therefore decided in one place, the workflow.

## Package

`@centrifuge/registry-core` is `src/core/index.ts` and the files it imports, built into
`packages/registry-core/dist/` (JavaScript and declarations, ES modules; on Node 22.12 or later a
CommonJS file loads it with `require`) and published to npmjs. The Worker does not use the build:
it imports `src/core/` by relative path. The exports, by group (their documentation ships as
`dist/index.d.ts`):

- **Chain walking:** `collectRegistryChain`, `isAncestor`, `flattenRegistryChain`,
  `flattenRegistryAbis`, `isRegistryDocument`, `describeLayer`, `slimLayer`, `DEFAULT_MAX_DEPTH`
- **Address history:** `chainAddressHistory`, `diffAddressHistories`, `flattenRetired`
- **Verification:** `verifyLayer`, `layerFromBytes`, `LayerVerificationError`
- **Networks:** `NETWORKS`

Each group also exports the types its functions take and return.

The library does no I/O: it reads no network, file or environment, and a chain walk reaches layers
only through the `fetchLayer` the caller passes in.

### What verification proves

`verifyLayer(cid, bytes)` proves that the bytes are the ones the CID names: the sha2-256 digest for a
raw CID, and for a dag-pb CID the root of the UnixFS file rebuilt from the bytes with 262144-byte
chunks, raw leaves, 174 links per node and no wrapping directory. It does not prove that the CID is
the right head, which is the caller's pin, nor anything about the layers below it.
`layerFromBytes(cid, bytes)` verifies and then parses the bytes as a layer.

A walk is only as trustworthy as what feeds it. A pinned head vouches for the chain under it only
when the bytes of the head and of every layer `fetchLayer` returns, as served, were checked with
`verifyLayer` before any parsing. `layerFromBytes` does both steps and also keeps integers above 2^53
exact; its `JSON.rawJSON` values do not survive `structuredClone`, so a consumer that needs plain data
runs `verifyLayer` on the bytes and parses them itself.

- `stopAt` (an option of `collectRegistryChain`) ends the walk before fetching a listed CID.
- `isAncestor(head, ancestor, fetchLayer)` is true when the ancestor is the head or a layer below it,
  false when the walk reaches the base snapshot first, and throws when the walk cannot finish.

`collectRegistryChain` returns failures (`complete`, `reason`, `fatal`) rather than throwing, and
both functions compare CIDs as strings, so pass canonical CIDv1. A `fetchLayer` that retries
gateways lets the last `LayerVerificationError` escape unwrapped (see `LayerVerificationError` and
`FetchLayer`).

`layerFromBytes` keeps integers above 2^53 (a `chainSelector`) exact through `JSON.stringify` using
`JSON.parse` source text access (revivers' `context.source` and `JSON.rawJSON`), which Node 22.12,
the package's floor, has; on a runtime without it `layerFromBytes` throws.

### Install

```bash
pnpm add --save-exact @centrifuge/registry-core@<version>
```

No token or `.npmrc` entry is needed. Every version is published with a provenance attestation
that ties it to the commit and workflow run that built it; `npm audit signatures` in the consuming
project checks it.

pnpm's [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) refuses a version published
more recently than the configured age. Where it is set, a version released within that age needs
`@centrifuge/registry-core` in `minimumReleaseAgeExclude`.

TypeScript finds the types through `types` under `moduleResolution` `node` (`node10`), and through
`exports` under `nodenext` and `bundler`. A CommonJS file uses `module: commonjs` with
`moduleResolution: node`, or `nodenext` on TypeScript 5.8 or later; `node16` does not work for a
CommonJS file.

The package has one runtime dependency, `multiformats`; `verifyLayer` rebuilds a dag-pb root with
its own UnixFS encoder, which a test checks against `ipfs-unixfs-importer`. Measured at 0.1.0 with
esbuild 0.28.1 for the browser: `collectRegistryChain`, `isAncestor` and `flattenRegistryChain`
bundle to about 3 kB minified, and adding `verifyLayer` and `layerFromBytes` makes it about 18 kB.

### Versions

The version is the `version` in `packages/registry-core/package.json`, raised in the pull request
that changes the package. While it is 0.x, a breaking change to an export raises the minor version
and any other change the patch version. Consumers pin an exact version. A version is published only
by a GitHub release; a push to `main` publishes nothing.

The workflow `publish-registry-core.yml` publishes when a GitHub release is published. It runs in
the `release` environment, refuses a release whose commit is not on `main` or whose tag is not
`registry-core-v<version>`, typechecks, tests and runs the smoke check, then stages the version
with `npm stage publish --provenance`. A staged version is not installable until a maintainer approves
it with 2FA, on npmjs.com under the package's Staged Packages tab or with `npm stage approve
<stage-id>`, and then checks its provenance with `npm view @centrifuge/registry-core@<version>
dist.attestations`. npmjs accepts the stage only from this workflow in that environment (trusted
publishing), the trusted publisher may not run `npm publish`, and the package refuses tokens that
bypass 2FA: every version needs a maintainer's 2FA, and the repository holds no npm token.

## Setup

What exists outside this repository, and where it is managed:

| What                                                                                                                    | Where                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 bucket `centrifuge-protocol-registry` (Official account)                                                             | ops-v3, `cloudflare/terraform/Centrifuge Official (prod)/platform/r2.tf`                                                                                                      |
| Bucket-scoped R2 token, pushed as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` to protocol-internal's repository secrets | ops-v3, `cloudflare/scripts/manage-api-tokens/tokens.yaml`                                                                                                                    |
| Web3 hostnames token (`CLOUDFLARE_API_TOKEN`)                                                                           | ops-v3 `tokens.yaml`, "ops-v3 control web3 hostnames and DNS"                                                                                                                 |
| Worker secrets                                                                                                          | 1Password, Environment "protocol-registry Worker"; see `scripts/push-secrets.sh`                                                                                              |
| The GitHub App                                                                                                          | GitHub organization settings                                                                                                                                                  |
| Who may publish `@centrifuge/registry-core`                                                                             | npmjs, the package's settings: Trusted publishing (stage only) and Publishing access (2FA, no bypass tokens); GitHub, this repository's `release` environment and tag ruleset |

**Package publishing.** The repository's `release` environment allows deployments only from tags
matching `registry-core-v*`, and the ruleset "registry-core release tags" lets only repository admins
create, move or delete those tags. On npmjs, `@centrifuge/registry-core` has a trusted publisher:
GitHub Actions, repository `centrifuge/protocol-registry`, workflow `publish-registry-core.yml`,
environment `release`, allowed to stage and not to publish. Its Publishing access requires
two-factor authentication and disallows tokens that bypass it. npm records provenance only for a
public repository.

The Worker is served on its `workers.dev` URL,
`https://centrifuge-protocol-registry.<account subdomain>.workers.dev` (`<host>` below): the GitHub App
is the only caller that needs it, and nothing about it needs a domain of its own.

**GitHub App** ("Centrifuge Protocol Registry"). Installed on protocol-internal only, with webhook URL
`https://<host>/webhooks/github` and a webhook secret. Permissions: Contents read, Checks write, Pull
requests read, Metadata read; no Actions permission, since an App's permissions apply to every repo it
is installed on and protocol-internal's workflows include deploys. Events: Push, Pull request, Check
run. Its private key is PKCS#1 as downloaded; the Worker needs PKCS#8
(`openssl pkcs8 -topk8 -nocrypt -in app.pem`).

**Deploy.**

```bash
NODE_SHIMS_MODE=local scripts/deploy.sh --profile centrifuge-prod
```

**Secrets.** From the "protocol-registry Worker" 1Password Environment, with op 2.41.0 or later:

```bash
NODE_SHIMS_MODE=local scripts/push-secrets.sh --profile centrifuge-prod
```

The script uploads only what `PUBLISH_MODE` needs: the GitHub App, Slack and manual-trigger secrets
in `shadow`, `PINATA_JWT` too in `pin`, and the Web3 hostnames token too in `live`. That token stays
in the ops-v3 item `.env.1password` references, where its reconciler rotates it.

Variables live in `wrangler.jsonc`; changing one (`SOURCE_BRANCH` at a release, `PUBLISH_MODE` at
the cutover) is a commit and a deploy. To move `PUBLISH_MODE` up, change it, run `push-secrets.sh`
(it reads the mode from `wrangler.jsonc`), then deploy: the Worker holds the new credential before
the mode that uses it. Only the first deploy comes before the secrets, so there is a Worker to hold
them.

## Operations

Without the token, start a run with the Manual run workflow (see
[Manual runs](docs/operations.md#manual-runs)). Manual runs and status through the Worker need the
bearer token (`MANUAL_TRIGGER_TOKEN`):

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

**Locally**, with a protocol-internal checkout (for env and tags) and wrangler access to the bucket
(`--wrangler-profile` picks an auth profile, as `wrangler --profile` does):

```bash
node scripts/generate.ts mainnet --source-repo ../protocol-internal --wrangler-profile centrifuge-prod [--mode full] [--source-cid <cid>]
```

It writes `out/registry-<network>.json` and its validation report, and publishes nothing.

**Auditing the chain:** `curl -s https://registry.centrifuge.io | jq .previousRegistry` gives the next
CID; `dig TXT _dnslink.registry.centrifuge.io +short` the live one.

## Moving off protocol-internal's pipeline

This follows the order of operations in
[centrifuge/protocol-internal#460](https://github.com/centrifuge/protocol-internal/pull/460), with the
Worker taking the place of re-enabling `registry.yml` on `live-v3.3`.

1. Merge #460 into `live-v3.3`; its `generate` job stays disabled.
2. ops-v3: the R2 bucket and the R2 token. protocol-internal: `build-abis.yml`, then a dispatch for
   every existing release tag. Create the GitHub App and the 1Password Environment, deploy with
   `PUBLISH_MODE: "shadow"`, push the secrets.
3. Shadow period: PRs into `live-v3.3` get previews; publishes post what they would publish. Then
   `pin`, with `PINATA_JWT`: real layers on IPFS,
   compared against what protocol-internal's pipeline would publish, with nothing pointing at them.
4. Once the v3.3 deployment has written the configs,
   [centrifuge/api-v3#499](https://github.com/centrifuge/api-v3/issues/499) is merged, and
   `live-v3.2`'s `generate` job is disabled (its generator still tombstones on absence and would undo a
   v3.3 layer): push `CLOUDFLARE_API_TOKEN`, set `PUBLISH_MODE: "live"` and deploy. The Worker is the
   only publisher from then on.
5. Remove `script/registry/`, `registry.yml`, the `detect-*` CI scripts and main's
   `registry-publish.yml` from protocol-internal; drop protocol-internal as a destination of the Web3
   token in ops-v3 and rotate it. `build-abis.yml` stays.

Where the Worker differs from the scripts it replaces:

- The preview is a check run instead of a PR comment, on the same PRs: those that touch `env/`.
- A manual publish no longer pins a layer with validation errors; errors are never bypassed.
- The tip is read by CID from the hostname's dnslink and fetched through IPFS, instead of over HTTP
  with the CID resolved separately, so the layer and its `previousRegistry.ipfsHash` always agree.
- A publish refuses when the hostname moved while it ran.

## Development

```bash
pnpm install
pnpm test        # node --test; no network
pnpm typecheck
pnpm lint
pnpm format:check
pnpm cf-typegen  # after changing wrangler.jsonc
pnpm build:package  # builds the package into packages/registry-core/dist
pnpm check:package  # smoke check of the packed package; needs the network
pnpm verify-chain mainnet  # verifies every live layer against its CID; needs the network
```

Tests are JavaScript, as the scripts they came from tested with node:test, and run the TypeScript
sources directly (Node 22.18+). Synthetic layers are built inline, so each test's input sits next
to its assertions (`layer()`, `chain()` and `contract()` in `test/helpers.js`).

Four real layers live under `test/fixtures/layers/<cid>.json.gz`, gzip of the bytes a gateway
served: mainnet head `bafkreig62ekjinmxgc47a262ohy7l3vk7r4xqibbdi3xmhdqgknbfx4xpi` and the three
layers below it, the last a dag-pb file of three chunks. The constants in `test/helpers.js` name
them, and `realLayerBytes(cid)` reads one. `verifyLayer` proves each file against its CID, so a
fixture needs no other provenance. A shape no published layer has (a dag-pb file over 174 chunks)
is built in the test, not committed. To fetch a layer:

```bash
curl -fsS -o "<tmp>/<cid>" "https://centrifuge-files.mypinata.cloud/ipfs/<cid>" \
  && gzip -9 -n -c "<tmp>/<cid>" > test/fixtures/layers/<cid>.json.gz
```

Commit the bytes as served, never re-serialised. A tampered layer is a real one with a byte flipped
inside the test, never a committed file.

`src/core/index.ts` is the package's entry point (see [Package](#package)). `test/core-index.test.js`
fails when an export is added, renamed or dropped, and `test/package.test.js` when the package's
dependencies differ from the root's pins for what `src/core/` imports. `pnpm check:package` imports
the packed build from outside the repository and asserts what a consumer receives: the exports, the
shipped files, the one runtime dependency, the types (compiled under `bundler`, `nodenext` and `node10` resolution), verification
of real layers, and a `chainSelector` above 2^53 surviving `layerFromBytes`.

`pnpm verify-chain <mainnet|testnet> [--head <cid>]` walks the live chain from the CID the
network's hostname serves (or `--head`) through the gateways, verifies every layer with
`layerFromBytes`, prints one line per layer and the count, and exits 1 naming the CID of a layer no
gateway served matching bytes for. Run it for both networks before a release of the package and
after a publish of a layer.

<!-- protocol-internal links. Links to live-v3.3 follow SOURCE_BRANCH: change them with it. Links to commit 13c52d7 point at the old pipeline, which protocol-internal removes. -->

[pi-env]: https://github.com/centrifuge/protocol-internal/tree/live-v3.3/env
[pi-registry-json]: https://github.com/centrifuge/protocol-internal/blob/live-v3.3/env/registry.json
[pi-branch]: https://github.com/centrifuge/protocol-internal/tree/live-v3.3
[pi-build-abis]: https://github.com/centrifuge/protocol-internal/blob/main/.github/workflows/build-abis.yml
[pi-script-registry]: https://github.com/centrifuge/protocol-internal/tree/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry
[pi-registry-yml]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/.github/workflows/registry.yml
