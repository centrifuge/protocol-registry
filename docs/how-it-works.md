# How the registry works

The contract registry tells indexers and apps which Centrifuge protocol contracts exist on each chain.
For each deployed contract, it gives the address, the deploy block and the ABI. When a contract is no
longer in use, it also gives the block where its listener ends. There is one registry per network:

- **mainnet**, served at `https://registry.centrifuge.io`
- **testnet**, served at `https://registry.testnet.centrifuge.io`

Each registry is a chain of JSON documents on IPFS. Each document is a **layer**. A layer carries
only what changed since the previous layer, and names that layer by CID in `previousRegistry.ipfsHash`.
The first layer is a base snapshot. To read a registry, walk the chain from the newest layer back to
the base, and merge the layers. The newest layer wins.

Each hostname serves the newest layer of its network. The hostname is a Cloudflare Web3 gateway
hostname, and its DNSLink names the CID of that layer.

This repository generates and publishes the layers. It runs as a Cloudflare Worker, and GitHub events
trigger it. It replaces the [`script/registry/`][pi-script-registry] scripts and the
[`registry.yml`][pi-registry-yml] workflow that each live branch of protocol-internal carried. [registry-format.md](registry-format.md) describes the layer
format. [operations.md](operations.md) describes day-to-day operation.

## The pieces

| Piece                                                     | What it does                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| protocol-internal's [`env/`][pi-env]                      | The input. Deploy scripts write one config per chain on protocol-internal's release branch ([`live-v3.3`][pi-branch]). People write `retired.json`, `versions.json` and [`registry.json`][pi-registry-json] beside the configs. |
| protocol-internal's [release tags][pi-tags] (`v3.3.0`, …) | Each contract `version` resolves to a tag. The ABI of the contract comes from the source at that tag.                                                                                                                           |
| protocol-internal's [`build-abis.yml`][pi-build-abis]     | Builds the ABIs of a tag once, when someone pushes the tag, into the R2 bucket under `abis/<tag>/`. The Worker cannot run git or forge, so the ABIs come from this workflow.                                                    |
| R2 bucket `centrifuge-protocol-registry`                  | Holds ABI bundles, a cache of published layers by CID, `env/` snapshots by commit, and the generated layers and report of each run.                                                                                             |
| GitHub App "Centrifuge Protocol Registry"                 | Installed on protocol-internal only. Sends push, pull request and check run events to the Worker. Lets the Worker read protocol-internal's `env/` and post check runs.                                                          |
| The Worker                                                | Receives the events, decides what each event asks for, and starts runs.                                                                                                                                                         |
| Publisher (Durable Object)                                | Lets one publish run go at a time, so two publish runs never race for the same hostname.                                                                                                                                        |
| RegistryRun (Workflow)                                    | One run, as durable steps. Each step retries on its own: read `env/`, check it, find the ABIs, generate and validate each network, then preview or publish.                                                                     |
| Pinata                                                    | Pins each published layer to IPFS.                                                                                                                                                                                              |
| Cloudflare Web3 hostnames                                 | `registry.centrifuge.io` and `registry.testnet.centrifuge.io`. Each hostname points at the CID of a layer.                                                                                                                      |
| Slack                                                     | Receives a short message for each publish, refusal and failure. A publish or refusal message links to the full report on GitHub.                                                                                                |
| Consumers                                                 | Indexers and apps that read the chain: api-v3, event-lake and the apps built on it.                                                                                                                                             |

## The flow

```mermaid
flowchart LR
  subgraph PI["protocol-internal"]
    deploy["Deploy scripts"] -->|write configs| env["env/ on live-v3.3"]
    people["People"] -->|retired.json, versions.json| env
    tag["Release tag pushed"] --> build["build-abis.yml"]
  end

  build -->|"abis/TAG/"| R2[("R2 bucket")]
  env -->|"PR and push events (GitHub App)"| W["Worker"]
  cron["Cron, every 6 hours"] --> W
  manual["POST /runs"] --> W

  W -->|preview| RR["RegistryRun workflow"]
  W -->|publish| P["Publisher (one at a time)"] --> RR

  RR -->|"env/ at the commit"| GH["GitHub API"]
  RR <-->|"ABIs, layer cache, run output"| R2
  RR -->|walk the published chain| IPFS[("IPFS gateways")]

  RR -->|preview| check["Registry preview check run on the PR"]
  RR -->|publish| pcheck["Registry publish check run on the commit"]
  RR -->|"publish: pin"| pinata["Pinata"]
  RR -->|"publish: point DNSLink"| cf["Cloudflare Web3 hostname"]
  RR --> slack["Slack"]

  cf --> host["registry.centrifuge.io / registry.testnet.centrifuge.io"]
  host --> consumers["Consumers: api-v3, event-lake, apps"]
  pinata -.-> IPFS
```

## A change, from deploy to published layer

1. **A deploy writes configs.** A deploy script records what it deployed in protocol-internal's
   [`env/<environment>/<network>.json`][pi-env], on a branch. Someone then opens a pull request into the release
   branch. `SOURCE_BRANCH` in `wrangler.jsonc` names the release branch (`live-v3.3` today).
2. **The pull request gets a preview.**
   - GitHub sends the `pull_request` event of the App to `POST /webhooks/github`.
   - The Worker checks the HMAC signature of the event and lists the files of the PR.
   - If a file is under `env/` (other than the connections viewer), the Worker posts a **Registry
     preview** check run. It then starts a preview run on the head commit of the PR.

   A PR that touches nothing under `env/` gets no check. For this reason, the check cannot be a
   required check. "Re-run" on the check starts the preview again.

3. **The run.** Its steps are:
   1. **Resolve the commit:** the PR head for a preview, the head of the release branch for a publish
      run.
   2. **Check `env/`** at that commit: the schema of the configs, `retired.json`, `versions.json`, and
      that every contract `version` resolves to a tag. A problem here ends the run.
   3. **Ensure ABIs:** every tag that `env/` uses must have a bundle in R2, built from the commit that
      the tag points at. If a bundle is missing, the step retries every 2 minutes for up to an hour.
      That time covers a `build-abis.yml` run in progress. After that, the step fails and names the
      tag.
   4. **Generate each network:** walk the published chain of the network from the live CID back to the
      base snapshot. Compute the layer against the accumulated state, and validate the layer (see
      [registry-format.md](registry-format.md)).
   5. **Report:** a preview completes the check run with the layer that each network would get, and
      with every finding. The check run fails when a layer would break the indexer. A publish run
      continues with the steps in item 4.
4. **The merge publishes.** The merge is a push to the release branch. A push that touches `env/` asks
   the Publisher for a publish run. The run generates from the head of the release branch. Then, for
   each network whose layer is publishable (it changes something) and has no errors, the run:
   1. **pins** the layer to IPFS through Pinata.
   2. **points** the hostname of the network at the new CID, through the Cloudflare API. Before that,
      the run checks that the hostname still serves the CID that the layer was built on. If something
      else published a layer in between, the run stops, because the new CID would orphan that layer.

   The run judges each network on its own, so an error on testnet does not stop mainnet.

   The run then reports in two places:
   - A **Registry publish** check run on the commit it published from holds the full report. Anyone
     who can read protocol-internal can open it.
   - Slack gets one message per publish run. The message has one line for each network that the run
     published, pinned or refused, and a link to the check run.

   A manual run reports on a **Registry publish (manual)** check run instead. Its refusal is neutral,
   so a run that someone tries by hand does not mark the release branch red.

5. **The cron reconciles.** Every six hours, the Worker asks for a publish run. So the Worker retries a
   webhook that GitHub dropped, or a run that failed, before anyone notices. A run with nothing to
   publish posts nothing. A cron run that would repeat the last message posts nothing too.

A manual `POST /runs` (with the bearer token) can preview any commit. It can also start a publish run
with options, such as a mode or a source CID. See [operations.md](operations.md).

## One publish at a time

Two publish runs computed against the same tip would both pin a layer that points at that tip. The
second DNSLink swap would then orphan the first layer. So every publish trigger (push, cron, manual)
goes to the Publisher, a single Durable Object. The Publisher starts a run when no run is active.
Otherwise, it keeps the trigger as the one pending run, and starts it when the active run ends.

A run generates from the head of the release branch, so a newer trigger replaces the pending run. There
is one exception: a push or the cron does not replace a pending manual run, because a manual run may
carry options. An alarm checks whether the active run ended. So a run that stops without a report
cannot block publishing. Previews do not use the Publisher, because they publish nothing.

## How far a publish goes: `PUBLISH_MODE`

| Mode     | Generates | Pins to IPFS | Points the hostname | Credentials it needs                 |
| -------- | :-------: | :----------: | :-----------------: | ------------------------------------ |
| `shadow` |     ✓     |              |                     | none beyond the App and Slack        |
| `pin`    |     ✓     |      ✓       |                     | `PINATA_JWT`                         |
| `live`   |     ✓     |      ✓       |          ✓          | `PINATA_JWT`, `CLOUDFLARE_API_TOKEN` |

`PUBLISH_MODE` is a variable in `wrangler.jsonc`. To change it, merge a change to `main`.
The merge deploys the Worker. The Worker holds only the credentials that its mode needs, because
`scripts/push-secrets.sh` uploads them by mode. A mode without its credentials refuses to run. It
does not do less instead. Until `live`, the Worker cannot change what the hostnames serve.

In `pin` mode, the Worker pins a publishable layer and posts its CID to Slack, but nothing points at the
layer. So `pin` is the place to inspect a real layer before a hostname serves it.

`CLOUDFLARE_API_TOKEN` is the token that ops-v3 manages as "ops-v3 control web3 hostnames and DNS". It
has Web3 Hostnames Write and DNS Read on `centrifuge.io`. It can point any Web3 hostname on the zone at
a new CID, not only the registry hostnames. For this reason, the Worker holds it only in `live` mode.

## What keeps a publish safe

- **Previews before merges.** Every PR into the release branch that touches protocol-internal's [`env/`][pi-env]
  shows the exact layers it would publish, with every finding, before it merges.
- **Deltas against the whole chain.** The Worker computes a layer against the accumulated state of
  every published layer, never against the newest layer alone. So a layer carries exactly what changed.
- **Refusals instead of guesses.** A run stops, and publishes nothing, when it:
  - cannot read the live layer.
  - cannot walk the whole chain.
  - finds a layer of the other network.
  - would produce a layer with validation errors.
- **Nothing is retired by omission.** A contract missing from `env/` stays as published. Retirement is
  a declaration in protocol-internal's [`retired.json`][pi-env] (see
  [registry-format.md](registry-format.md#retirement)).
- **One publisher, and a moved tip stops it.** The Publisher lets one publish run go at a time. Before a
  publish run points a hostname at a new CID, it checks that the hostname still serves the CID it built
  on.
- **Staged credentials.** Each of `shadow`, `pin` and `live` gives the Worker one more capability.

## Consumers

Consumers read the registry in one of two ways.

- **Following the hostname.** Fetch `https://registry.centrifuge.io`. Then walk
  `previousRegistry.ipfsHash` back to the base snapshot, and merge the layers: older first, newer
  overriding. You get what the hostname serves, so a new publish reaches you on your next read.
- **Pinning a head.** Keep the CID of the newest layer you accepted. Walk from it, and move it forward on
  purpose. event-lake works this way:
  - It keeps one head per network in `registry.manifest.json`.
  - It checks every layer it reads against its CID.
  - From the result, it builds the address book that the indexer, handlers, private API and SDK use.

  This repository publishes the code that event-lake uses to read and verify layers, as
  `@centrifuge/registry-core` (see the README's Package section). `verifyLayer` proves that the bytes
  are the ones a CID names. `isAncestor` and `diffAddressHistories` check that a pin bump only moves
  forward, and show what the bump changes.

api-v3 reads a `REGISTRY_URL`, which can be the hostname or a fixed layer. Its reader folds a
null-version patch layer into its predecessor. It also collapses consecutive layers that have the same
version.

Both ways, a consumer ends the listener of a contract at the `endBlock` of its `retired` entry. A
consumer never infers an end from the next release. Pools migrate one by one, so a contract absent
from a newer layer stays in use until a retirement closes it.

## Assumptions

This section lists what the system takes for granted, and what breaks when an assumption stops being
true.

### Inputs

- **protocol-internal's [`env/`][pi-env] on the release branch is the record of what is deployed.** Deploy
  scripts write it, and nothing else feeds the registry. The Worker does not publish a contract that is
  deployed but not recorded. It publishes a config edited by hand as written.
- **One release branch publishes.** `SOURCE_BRANCH` names it. Other live branches publish nothing. A
  new release reaches the registry only after a change that sets `SOURCE_BRANCH` to its branch merges
  to `main`. The merge deploys the Worker.
- **Every config entry has an integer `blockNumber`.** The Worker derives the start block of the chain
  from these numbers. Generation refuses an entry without one. It does not fetch the number from
  elsewhere.
- **Every contract `version` resolves to a tag**, directly or through protocol-internal's
  [`env/<dir>/versions.json`][pi-env]. An alias is the claim of the deployment that it runs the source at that
  tag. Nothing checks this claim, so reviewers treat an alias like code.
- **Absence is not retirement.** Retirement is a declaration in protocol-internal's [`retired.json`][pi-env]. A
  contract that `env/` stops listing stays published. A release that replaces a contract under a new key
  must retire the old contract. Otherwise, indexers keep listening to both.

### ABIs

- **The source at a tag never changes.** protocol-internal's [`build-abis.yml`][pi-build-abis] builds each tag once, and
  the bundle records the commit. The Worker refuses a moved tag until someone builds it again.
- **Every tag is built.** `build-abis.yml` runs when someone pushes a tag. GitHub starts no run for a
  tag pushed with `GITHUB_TOKEN`, or for more than three tags in one push. Someone dispatches the
  workflow by hand for those tags, and for tags from before the workflow. Until a tag that the configs
  use has a bundle, every run waits for it, then fails and names the tag.
- **An artifact name is unique enough.** Bundles use the artifact name as their key. The first artifact
  wins, from `out/` then `out-ir/`. A collision with a different ABI is a warning in the build, not an
  error.
- **A contract key names its artifact.** The key is capitalized (`hub` → `Hub`). A factory also needs
  its product. A key that does not map needs an entry in `src/core/abi-names.ts` **in this
  repository**. Until that entry lands here, a protocol-internal change that adds such a key fails its
  preview with a missing ABI.

### Publishing

- **The Worker is the only publisher.** Nothing else changes the DNSLinks of the hostnames. The Worker
  detects a change made by hand, because the hostname no longer serves the CID that a layer was built
  on. The publish run then stops. That stop is the safety, so after a manual change, start a run that
  builds on it.
- **Generation is deterministic.** The same `env/`, live layer and ABIs give the same bytes, and so the
  same CID. So you can check a layer before the Worker publishes it, and a retry pins the same layer.
- **Pinata's layout stays as it is.** The Worker uploads layers through the public files API of Pinata.
  That API gives CIDv1, raw leaves, 256 KiB chunks and a balanced DAG of 174 links. `verifyLayer` in
  `@centrifuge/registry-core` rebuilds CIDs the same way. If Pinata changed its layout, new layers
  would fail verification.
- **Every published layer stays pinned.** Consumers walk the chain back to the base snapshot, so every
  layer must stay retrievable. The Worker caches layers in R2. Consumers do not.
- **Mainnet is never reset.** Its chain only grows. A testnet reset is a full snapshot that a run asks
  for explicitly. See [registry-format.md](registry-format.md#indexer-hard-requirements).

### Consumers

- **A consumer walks the whole chain and merges it, newest winning.** A null-version patch layer folds
  into its predecessor. A listener ends at the `endBlock` of its `retired` entry. It never ends because
  a contract is absent from a newer layer.
- **A consumer that pins a head moves it on purpose.** event-lake pins one CID per network and verifies
  each layer against it. So a publish reaches event-lake only when someone bumps its pin. api-v3 reads
  its `REGISTRY_URL`, which may be a fixed layer instead of the hostname.

### Operations

- **Credentials follow the mode.** The Worker holds only what `PUBLISH_MODE` needs.
  `scripts/push-secrets.sh` uploads it. After you rotate a secret, run the script again. A mode that
  misses its credential fails every publish run. It does not do less instead.
- **A merge to `main` deploys.** The "Deploy" workflow runs `scripts/deploy.sh` in the `production`
  environment.
- **The GitHub App stays installed on protocol-internal,** with the webhook secret that the Worker
  holds. Without its events, previews stop, and publishing waits for the cron every six hours.

## What lives where

| What                                                        | Where                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configs, `retired.json`, `versions.json`, `registry.json`   | protocol-internal, [`env/`][pi-env] on the release branch                                                                                                                                                                                                                             |
| ABI builds                                                  | protocol-internal `main`, [`.github/workflows/build-abis.yml`][pi-build-abis], with the repository secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`                                                                                                                                |
| R2 bucket `centrifuge-protocol-registry` (Official account) | `abis/<tag>/` (ABI bundles), `layers/<cid>.json` (published layers, cached), `snapshots/<sha>.json` (protocol-internal's `env/` at a commit), `runs/<id>/` (the layers, validation and report of each run). ops-v3 holds the bucket and the R2 token. See the README's Setup section. |
| The Worker                                                  | This repository. Settings are in `wrangler.jsonc` (`SOURCE_REPO`, `SOURCE_BRANCH`, `PUBLISH_MODE`, hostnames, zone). A merge to `main` deploys it with `scripts/deploy.sh`, which labels each version with its commit.                                                                |
| Worker secrets                                              | The 1Password Environment "protocol-registry Worker": `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `SLACK_WEBHOOK_URL`, `MANUAL_TRIGGER_TOKEN`, `PINATA_JWT`. Upload them with `scripts/push-secrets.sh`.                                                      |
| `CLOUDFLARE_API_TOKEN`                                      | ops-v3 `tokens.yaml`, "ops-v3 control web3 hostnames and DNS". `.env.1password` references its 1Password item. The ops-v3 reconciler rotates it.                                                                                                                                      |
| `CLOUDFLARE_DEPLOY_API_TOKEN`                               | ops-v3 `tokens.yaml`, "protocol-registry - Deploy Workers (production)". The ops-v3 reconciler pushes it to this repository's `production` environment, which allows deployments from `main` only.                                                                                    |
| The GitHub App                                              | GitHub organization settings. Installed on protocol-internal only.                                                                                                                                                                                                                    |
| Hostnames                                                   | Cloudflare, Web3 gateways on the `centrifuge.io` zone                                                                                                                                                                                                                                 |
| `@centrifuge/registry-core`                                 | npmjs. This repository's `publish-registry-core.yml` publishes it on a GitHub release, in the `release` environment.                                                                                                                                                                  |
| Repository rules                                            | `main`: changes by pull request with one approval, signed commits, squash merges, the `checks` CI job. `registry-core-v*` tags: only admins create, move or delete them.                                                                                                              |

## Cutting a release

A new release can need two changes, and they are independent. Changing `SOURCE_BRANCH` does not build
ABIs. Building ABIs does not change the branch that the Worker publishes from.

**The branch that the Worker publishes from.** This changes for a new release branch in
protocol-internal (`live-v3.4`), or when protocol-internal's `env/` moves back to `main`.

1. Preview the head of the new branch: `POST /runs` with `"kind": "preview"` and the `"sha"` of that
   head (see [operations.md](operations.md#manual-runs)).
   - If its `env/` matches what is published, the preview shows nothing to publish.
   - If not, the first publish run from that branch publishes the difference.
2. Set `SOURCE_BRANCH` in `wrangler.jsonc` to the new branch, and merge the change.
3. The merge deploys the Worker. Check that the "Deploy" workflow run for the merge passes.

**The ABIs of new tags.** protocol-internal's
[`.github/workflows/build-abis.yml`][pi-build-abis] builds them. It does
not depend on the Worker or on `SOURCE_BRANCH`. It runs when someone pushes a release tag to
protocol-internal. GitHub starts no run for a tag pushed with `GITHUB_TOKEN`, or for any tag in a push
of more than three tags. Dispatch the workflow by hand for those tags (see
[operations.md](operations.md#abis)). A run that needs a tag without a bundle waits, then fails and
names the tag.

<!-- protocol-internal links. Links to live-v3.3 follow SOURCE_BRANCH: change them with it. Links to commit 13c52d7 point at the old pipeline, which protocol-internal removes. -->

[pi-env]: https://github.com/centrifuge/protocol-internal/tree/live-v3.3/env
[pi-registry-json]: https://github.com/centrifuge/protocol-internal/blob/live-v3.3/env/registry.json
[pi-branch]: https://github.com/centrifuge/protocol-internal/tree/live-v3.3
[pi-tags]: https://github.com/centrifuge/protocol-internal/tags
[pi-build-abis]: https://github.com/centrifuge/protocol-internal/blob/main/.github/workflows/build-abis.yml
[pi-script-registry]: https://github.com/centrifuge/protocol-internal/tree/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry
[pi-registry-yml]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/.github/workflows/registry.yml
