# Operating the registry

This file tells you how to preview, publish, inspect and audit, day to day.
[how-it-works.md](how-it-works.md) describes what the Worker does on its own.
[registry-format.md](registry-format.md) describes what a layer must contain. The README's Setup
section describes the setup: the App, the secrets and the deploys.

- [Previews and publishes](#previews-and-publishes)
- [Manual runs](#manual-runs)
- [Following a run](#following-a-run)
- [Changing `PUBLISH_MODE`](#changing-publish_mode)
- [Pointing a hostname back](#pointing-a-hostname-back)
- [ABIs](#abis)
- [Generating locally](#generating-locally)
- [Auditing the published chain](#auditing-the-published-chain)
- [Checking the publishing credentials](#checking-the-publishing-credentials)
- [The layer cache](#the-layer-cache)
- [From protocol's scripts](#from-protocols-scripts)

## Previews and publishes

The usual case needs no action:

- A pull request into protocol's [release branch][pi-branch] that touches [`env/`][pi-env]
  gets a **Registry preview** check run. The check run shows the layer that each network would get, its retirements, and
  every finding. "Re-run" on the check runs it again.
- A merge of that pull request publishes, as far as `PUBLISH_MODE` allows. Slack says what happened,
  in one line for each network, with a link to the **Registry publish** check run on the commit. The
  check run holds the full report.
- The cron also starts a publish run every six hours. So the Worker retries a dropped webhook or a
  failed run.

Review a preview as you review code. Read the counts (contracts, retirements, ABIs, delta size), the
list of contracts kept as published, and every warning or error. If a layer is much larger than your
change, the layer compares against the wrong baseline.

## Manual runs

`POST /runs` and `GET /status` take the bearer token `MANUAL_TRIGGER_TOKEN`, from the
"protocol-registry Worker" 1Password Environment. `op run` gives the token to the command, and the
token never reaches the terminal. `REGISTRY_OP_ENVIRONMENT` holds the ID of that Environment, as for
`scripts/push-secrets.sh`. `<host>` is the URL of the Worker (see the README's Setup section):

```bash
H=https://<host>
op run --environment "$REGISTRY_OP_ENVIRONMENT" -- sh -c \
  "curl -sX POST $H/runs -H \"Authorization: Bearer \$MANUAL_TRIGGER_TOKEN\" -d '{\"kind\":\"preview\"}'"
```

| Field               | Meaning                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`              | `preview` (generate and validate, publish nothing) or `publish` (through the Publisher, as far as `PUBLISH_MODE` allows)                            |
| `sha`               | Preview only: the protocol commit to generate from. A publish run always uses the head of the release branch.                                       |
| `networks`          | `["mainnet"]`, `["testnet"]` or both (the default)                                                                                                  |
| `mode`              | `auto` (default), `delta`, `patch` or `full` (see [Modes](registry-format.md#modes))                                                                |
| `sourceCid`         | Build on this CID instead of the live layer. Needs exactly one network. Use it to generate a broken layer again, or to test against an older layer. |
| `allowPartialChain` | Continue when the run cannot walk the whole chain. Expect the run to emit published contracts and retirements again.                                |
| `allowHistoryDrop`  | Let a full snapshot drop published, unretired contracts. Use it only to replace the deployment on purpose.                                          |

Examples of `-d` bodies:

```bash
'{"kind":"preview","sha":"<commit>"}'                      # what a branch or PR head would publish
'{"kind":"publish"}'                                        # publish now, queued behind a running publish
'{"kind":"publish","networks":["mainnet"]}'                 # one network
'{"kind":"preview","networks":["testnet"],"mode":"patch"}'  # force a patch
```

A full snapshot resets the chain of a network, and only testnet is reset this way:

- `POST /runs` refuses `"mode": "full"` for mainnet.
- While a mainnet layer is live, validation refuses an unlinked mainnet layer (see
  [Indexer hard requirements](registry-format.md#indexer-hard-requirements)).

To reset testnet:

```bash
curl -sX POST https://<host>/runs -H "Authorization: Bearer $TOKEN" \
  -d '{"kind":"publish","networks":["testnet"],"mode":"full"}'
```

Add `"allowHistoryDrop": true` only when the snapshot drops live published contracts on purpose, for
example in a switch to another deployment.

## Following a run

`POST /runs` answers with the run id. Then:

- The Slack message of a manual publish links to its **Registry publish (manual)** check run on the
  protocol commit. The check run holds the full report, and reading it needs no token.
- `GET /runs/<id>` gives the status and report of the run. `GET /runs/<id>/registry-<network>.json`
  and `.validation.json` give its layers and validation reports. R2 holds the same files under
  `runs/<id>/`.
- `GET /status` shows the Publisher: the active run, the pending run, and the last 20 runs.
- Without the token, wrangler shows every step of a run, with the error of each attempt:

```bash
NODE_SHIMS_MODE=local pnpm exec wrangler workflows instances list centrifuge-protocol-registry-run --profile centrifuge-prod
NODE_SHIMS_MODE=local pnpm exec wrangler workflows instances describe centrifuge-protocol-registry-run <id> --profile centrifuge-prod
NODE_SHIMS_MODE=local pnpm exec wrangler r2 object get centrifuge-protocol-registry/runs/<id>/report.md --remote --pipe --profile centrifuge-prod
```

A run that waits on "ensure ABIs" retries every 2 minutes for a tag with no bundle. The error names the
tag (see [ABIs](#abis)).

## Changing `PUBLISH_MODE`

The mode is in `wrangler.jsonc`, so a pull request changes it. The merge deploys the Worker with the
new mode. A mode needs its credentials: `PINATA_JWT` for `pin`, and also `CLOUDFLARE_API_TOKEN` for
`live`. A mode whose credentials are missing fails every publish run. If the Worker does not hold one
of them, run `NODE_SHIMS_MODE=local scripts/push-secrets.sh --profile centrifuge-prod` from the pull
request's branch before you merge.

When you move the mode down, the uploaded credentials stay on the Worker. Remove one with
`wrangler secret delete`. If the mode change must act on a publish right away, start a manual
`{"kind":"publish"}`.

## Pointing a hostname back

If a published layer is wrong, point the hostname at the previous CID. That CID is the
`previousRegistry.ipfsHash` of the new layer. Change the DNSLink of the hostname in the dashboard of
the Web3 gateway, or use the same token as the Worker. `<zone-id>` is `CLOUDFLARE_ZONE_ID` in
`wrangler.jsonc`:

```bash
op run --env-file .env.1password -- sh -c 'curl -sX PATCH \
  "https://api.cloudflare.com/client/v4/zones/<zone-id>/web3/hostnames/<hostname-id>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"dnslink\":\"/ipfs/<previous-cid>\"}"'
```

Then change `PUBLISH_MODE` to `pin`, so the next publish run does not move the hostname again. The
listing under [Checking the publishing credentials](#checking-the-publishing-credentials) gives the
hostname ids.

## ABIs

protocol's [`.github/workflows/build-abis.yml`][pi-build-abis] builds each release tag once,
into R2:

```
abis/<tag>/<Artifact>.json   one ABI per artifact
abis/<tag>/manifest.json     { tag, commit, builtAt, artifacts }, written last
```

A manifest means that the bundle is complete. A run uses a bundle only when its `commit` is the commit
that the tag points at now. The Worker refuses a tag that moved after its build, until someone builds
the tag again.

- **When it runs:** on every `v*` tag that someone pushes to protocol. GitHub starts no run for
  a tag pushed with `GITHUB_TOKEN`, or for any tag in a push of more than three. A registry run that
  needs such a tag waits up to an hour, then fails and names the tag.
- **By hand:** dispatch it for those tags, for tags pushed before the workflow existed, and to build a
  tag again:

  ```bash
  gh workflow run build-abis.yml -R centrifuge/protocol-internal -f tag=v3.3.0
  ```

  A rebuild deletes the manifest first, so no run reads a bundle that is half replaced.

- **What it builds:** `forge build` at the tag, and the `ir` profile where the `foundry.toml` of the tag
  has one (`src-ir/`, v3.2.0 onwards).
  - Artifacts come from `out/` then `out-ir/`, in sorted order, without test sources.
  - When two artifacts have the same name, the first wins, as in the old ABI cache.
  - A same-name artifact with a different ABI shows as a warning on the workflow run. `IDepositManager`
    and `ERC20` are known ones.

## Generating locally

You need a protocol checkout (for its `env/` and tags) and wrangler access to the bucket:

```bash
NODE_SHIMS_MODE=local node scripts/generate.ts mainnet --source-repo ../protocol-internal \
  --wrangler-profile centrifuge-prod [--mode auto|delta|patch|full] [--source-cid <cid>] \
  [--allow-partial-chain] [--allow-history-drop] [--out out]
```

The script does these steps:

1. It reads `env/` from the working tree of the protocol checkout, and the tags from its git.
2. It fetches the ABI bundles it needs from R2 into `cache/abis/<tag>/`.
3. It walks the live chain, with a cache in `cache/registry-chain/`.
4. It writes `out/registry-<network>.json` and the validation report of the layer.

It publishes nothing. It exits 1 when generation is refused or validation finds errors. It does not
make the `env/` checks that a run makes first (schema, `retired.json`, version tags). A preview with
`sha` makes them on a pushed commit.

You rarely need `--source-cid`. By default, the script reads the live CID from the DNSLink of the
hostname. Use `--source-cid` to compare against a specific older layer: to generate a broken layer
again, or to test against a pinned CID.

## Auditing the published chain

The live CID of each network, from its DNSLink:

```bash
dig TXT _dnslink.registry.centrifuge.io +short           # mainnet
dig TXT _dnslink.registry.testnet.centrifuge.io +short   # testnet
# "dnslink=/ipfs/<cid>"
```

A table with one row per layer, from a walk of `previousRegistry.ipfsHash` to the base snapshot:

```bash
cid=$(dig TXT _dnslink.registry.centrifuge.io +short | sed -E 's#.*/ipfs/([^"]+).*#\1#')
while [ -n "$cid" ]; do
  layer=$(curl -s "https://centrifuge-files.mypinata.cloud/ipfs/$cid")
  jq -r --arg cid "$cid" '"\($cid)  \(.version // "patch")  chains=\(.chains | length)" +
    "  contracts=\([.chains[].contracts | length] | add // 0)" +
    "  retired=\([.chains[] | .retired // {} | length] | add // 0)"' <<<"$layer"
  cid=$(jq -r '.previousRegistry.ipfsHash // empty' <<<"$layer")
done
```

A healthy chain is small layers on a large base snapshot. Layers that hold most of the accumulated
contracts mean that a publish run compared against the wrong baseline. In this repository,
`pnpm verify-chain <network>` uses `@centrifuge/registry-core` to walk the live chain. It also checks
every layer against its CID.

## Checking the publishing credentials

These read-only calls prove that the credentials work. They pin nothing and change no hostname:

```bash
op run --environment "$REGISTRY_OP_ENVIRONMENT" --env-file .env.1password -- sh -c '
  curl -s https://api.pinata.cloud/data/testAuthentication -H "Authorization: Bearer $PINATA_JWT"
  curl -s https://api.cloudflare.com/client/v4/zones/<zone-id>/web3/hostnames \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq ".result[] | {id, name, status, dnslink}"'
```

Pinata answers "Congratulations! You are communicating with the Pinata API!". The second call lists
both registry hostnames, with their ids and the CIDs they serve. The calls do not test a write, because a
write would change what a hostname serves.

## The layer cache

The contents of a CID never change, so the Worker caches every fetched layer by CID. The Worker uses
`layers/<cid>.json` in R2. Local runs use `cache/registry-chain/<cid>.json`. Delete that directory to
fetch the layers again. With the cache, a walk costs one fetch per layer published since the last run.
An entry holds the bytes that a gateway served. Each read checks them against the CID, so a damaged
entry is a miss, and the next fetch overwrites it.
The Worker also caches protocol's `env/` by commit, at `snapshots/<sha>.json` in R2.

## From protocol's scripts

| protocol ([`script/registry/`][pi-script-registry])                                                                           | Here                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`registry.yml`][pi-registry-yml] on pull requests: the Registry Preview comment                                              | the **Registry preview** check run on the PR                                                                                                        |
| [`registry.yml`][pi-registry-yml] on push: [`pin-to-ipfs.js`][pi-pin-to-ipfs], [`update-cloudflare.js`][pi-update-cloudflare] | a publish run, as far as `PUBLISH_MODE` allows                                                                                                      |
| [`registry-publish.yml`][pi-registry-publish-yml] dispatch on protocol's `main`                                               | `POST /runs` with `{"kind":"publish"}`                                                                                                              |
| [`node script/registry/abi-registry.js <network>`][pi-abi-registry]                                                           | `node scripts/generate.ts <network> --source-repo <checkout>`                                                                                       |
| `REGISTRY_MODE=delta \| patch \| full`, `--full`                                                                              | `mode` / `--mode`                                                                                                                                   |
| `SOURCE_IPFS=<cid>`                                                                                                           | `sourceCid` / `--source-cid`                                                                                                                        |
| `ALLOW_PARTIAL_REGISTRY_CHAIN=1`                                                                                              | `allowPartialChain` / `--allow-partial-chain`                                                                                                       |
| `ALLOW_HISTORY_DROP=1`                                                                                                        | `allowHistoryDrop` / `--allow-history-drop`                                                                                                         |
| `REGISTRY_CHAIN_MAX_DEPTH`                                                                                                    | none: the walk stops at 500 layers                                                                                                                  |
| `REGISTRY_CHAIN_CACHE_DIR`, `REGISTRY_CHAIN_NO_CACHE=1`                                                                       | none: delete `cache/registry-chain/` to fetch the layers again                                                                                      |
| `SKIP_LIVE_REGISTRY_CHECK=1`                                                                                                  | none: every check runs, every time                                                                                                                  |
| [`build-abi-cache.js`][pi-build-abi-cache], `cache/abi-registry/<tag>/out/`                                                   | protocol's [`build-abis.yml`][pi-build-abis] into R2 `abis/<tag>/`. Locally, `cache/abis/<tag>/`.                                                   |
| [`validate-env-schema.js`][pi-validate-env-schema], [`validate-env-contract-version-tags.js`][pi-validate-version-tags]       | the "check env" step of a run: a preview with `sha`                                                                                                 |
| [`validate-registry.js`][pi-validate-registry]                                                                                | every run validates. The reports are at `runs/<id>/registry-<network>.validation.json`.                                                             |
| [`walk-registry-chain.js`][pi-walk-chain]                                                                                     | [Auditing the published chain](#auditing-the-published-chain)                                                                                       |
| [`validate-api-keys.js`][pi-validate-api-keys]                                                                                | [Checking the publishing credentials](#checking-the-publishing-credentials)                                                                         |
| [`detect-changed-environments.js`][pi-detect-changed]                                                                         | the Worker previews a PR, or publishes a push, that touches `env/`. Generation is per network. A network with nothing to publish publishes nothing. |

<!-- protocol links. Links to live-v3.3 follow SOURCE_BRANCH: change them with it. Links to commit 13c52d7 point at the old pipeline, which protocol removes. -->

[pi-env]: https://github.com/centrifuge/protocol-internal/tree/live-v3.3/env
[pi-branch]: https://github.com/centrifuge/protocol-internal/tree/live-v3.3
[pi-build-abis]: https://github.com/centrifuge/protocol-internal/blob/main/.github/workflows/build-abis.yml
[pi-script-registry]: https://github.com/centrifuge/protocol-internal/tree/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry
[pi-registry-yml]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/.github/workflows/registry.yml
[pi-registry-publish-yml]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/.github/workflows/registry-publish.yml
[pi-pin-to-ipfs]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/pin-to-ipfs.js
[pi-update-cloudflare]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/update-cloudflare.js
[pi-abi-registry]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/abi-registry.js
[pi-build-abi-cache]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/build-abi-cache.js
[pi-validate-env-schema]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/validate-env-schema.js
[pi-validate-version-tags]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/utils/validate-env-contract-version-tags.js
[pi-validate-registry]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/validate-registry.js
[pi-walk-chain]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/walk-registry-chain.js
[pi-validate-api-keys]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/script/registry/validate-api-keys.js
[pi-detect-changed]: https://github.com/centrifuge/protocol-internal/blob/13c52d77577381f5c2d5b8191b024f4492f7a415/.github/ci-scripts/detect-changed-environments.js
