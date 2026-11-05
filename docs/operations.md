# Operating the registry

How to preview, publish, inspect and audit, day to day. What the Worker does on its own is in
[how-it-works.md](how-it-works.md); what a layer must look like is in
[registry-format.md](registry-format.md). Setup (the App, secrets, deploys) is in the README's Setup
section.

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
- [From protocol-internal's scripts](#from-protocol-internals-scripts)

## Previews and publishes

Nothing needs doing for the usual case:

- A pull request into the release branch that touches `env/` gets a **Registry preview** check run:
  the layer each network would get, its retirements, and every finding. "Re-run" on the check runs it
  again.
- Merging it publishes, as far as `PUBLISH_MODE` allows, and Slack says what happened.
- The cron publishes every six hours too, so a dropped webhook or a failed run is retried.

Read a preview the way you would review code: the counts (contracts, retirements, ABIs, delta size),
the list of contracts kept as published, and any warning or error. A layer much larger than the
change you made means it compares against the wrong baseline.

## Manual runs

`POST /runs` and `GET /status` take the bearer token `MANUAL_TRIGGER_TOKEN`, from the
"protocol-registry Worker" 1Password Environment. `op run` hands it to the command without it ever
reaching the terminal:

```bash
H=https://centrifuge-protocol-registry.centrifuge-kf.workers.dev
op run --environment weyggnasjjxhanfpqpxfpsl6za -- sh -c \
  "curl -sX POST $H/runs -H \"Authorization: Bearer \$MANUAL_TRIGGER_TOKEN\" -d '{\"kind\":\"preview\"}'"
```

| Field               | Meaning                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`              | `preview` (generate and validate, publish nothing) or `publish` (through the Publisher, as far as `PUBLISH_MODE` allows)                 |
| `sha`               | Preview only: the protocol-internal commit to generate from. A publish always uses the release branch head.                              |
| `networks`          | `["mainnet"]`, `["testnet"]` or both (the default)                                                                                       |
| `mode`              | `auto` (default), `delta`, `patch` or `full` (see [Modes](registry-format.md#modes))                                                     |
| `sourceCid`         | Build on this CID instead of the live layer; needs exactly one network. For regenerating a broken layer or testing against an older one. |
| `allowPartialChain` | Proceed when the chain cannot be walked in full. Expect published contracts and retirements to be emitted again.                         |
| `allowHistoryDrop`  | Let a full snapshot drop published, unretired contracts: only when replacing the deployment on purpose                                   |

Examples of `-d` bodies:

```bash
'{"kind":"preview","sha":"<commit>"}'                      # what a branch or PR head would publish
'{"kind":"publish"}'                                        # publish now, queued behind a running publish
'{"kind":"publish","networks":["mainnet"]}'                 # one network
'{"kind":"preview","networks":["testnet"],"mode":"patch"}'  # force a patch
```

A full snapshot resets a network's chain, and only testnet is reset this way: `POST /runs` refuses
`"mode": "full"` for mainnet, and validation refuses an unlinked mainnet layer while one is live (see
[Indexer hard requirements](registry-format.md#indexer-hard-requirements)). To reset testnet:

```bash
curl -sX POST https://<host>/runs -H "Authorization: Bearer $TOKEN" \
  -d '{"kind":"publish","networks":["testnet"],"mode":"full"}'
```

Add `"allowHistoryDrop": true` only when the snapshot drops published contracts that are still live on
purpose, such as a switch to another deployment.

## Following a run

`POST /runs` answers with the run id. Then:

- `GET /runs/<id>` gives its status and report, `GET /runs/<id>/registry-<network>.json` and
  `.validation.json` its layers and validation reports. The same files are in R2 under `runs/<id>/`.
- `GET /status` shows the Publisher: the active run, the pending one, and the last 20.
- Without the token, wrangler shows every step of a run, with each attempt's error:

```bash
NODE_SHIMS_MODE=local pnpm exec wrangler workflows instances list centrifuge-protocol-registry-run --profile centrifuge-prod
NODE_SHIMS_MODE=local pnpm exec wrangler workflows instances describe centrifuge-protocol-registry-run <id> --profile centrifuge-prod
NODE_SHIMS_MODE=local pnpm exec wrangler r2 object get centrifuge-protocol-registry/runs/<id>/report.md --remote --pipe --profile centrifuge-prod
```

A run waiting on "ensure ABIs" is retrying every 2 minutes for a tag with no bundle: the error names
the tag (see [ABIs](#abis)).

## Changing `PUBLISH_MODE`

The mode is in `wrangler.jsonc`, so it changes through a pull request. To move it up:

1. Merge the change to `wrangler.jsonc`.
2. `NODE_SHIMS_MODE=local scripts/push-secrets.sh --profile centrifuge-prod`: it reads the mode and
   uploads the credentials it needs (`PINATA_JWT` for `pin`, also `CLOUDFLARE_API_TOKEN` for `live`).
3. `NODE_SHIMS_MODE=local scripts/deploy.sh --profile centrifuge-prod`, from `main`.

Secrets in that order, so the Worker holds a credential before its mode uses it; a mode whose
credentials are missing fails every publish run. Moving the mode down leaves the uploaded credentials
on the Worker: remove one with `wrangler secret delete`. A publish the mode change should act on right
away is a manual `{"kind":"publish"}`.

## Pointing a hostname back

If a published layer turns out wrong, point the hostname at the previous CID (the new layer's
`previousRegistry.ipfsHash`) in the Cloudflare dashboard (Web3, the hostname's DNSLink), or with the
same token the Worker uses:

```bash
op run --env-file .env.1password -- sh -c 'curl -sX PATCH \
  "https://api.cloudflare.com/client/v4/zones/b9a43e7d34e470e7ee9b1f41a34cc726/web3/hostnames/<hostname-id>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"dnslink\":\"/ipfs/<previous-cid>\"}"'
```

Then set `PUBLISH_MODE` back to `pin` so the next publish does not move it again. The hostname ids are
in the listing under [Checking the publishing credentials](#checking-the-publishing-credentials).

## ABIs

Each release tag is built once by protocol-internal's `.github/workflows/build-abis.yml`, into R2:

```
abis/<tag>/<Artifact>.json   one ABI per artifact
abis/<tag>/manifest.json     { tag, commit, builtAt, artifacts }, written last
```

A manifest means the bundle is complete, and a run uses a bundle only when its `commit` is the commit
the tag points at now: a tag moved since it was built is refused until it is built again.

- **When it runs:** on every pushed `v*` tag. GitHub starts no run for a tag pushed with
  `GITHUB_TOKEN`, nor for any tag in a push of more than three; a registry run that needs such a tag
  waits up to an hour, then fails naming it.
- **By hand**, for those, for tags pushed before the workflow existed, and to rebuild:

  ```bash
  gh workflow run build-abis.yml -R centrifuge/protocol-internal -f tag=v3.3.0
  ```

  A rebuild deletes the manifest first, so no run reads a half-replaced bundle.

- **What it builds:** `forge build` at the tag, and the `ir` profile where the tag's `foundry.toml`
  has one (`src-ir/`, v3.2.0 onwards). Artifacts come from `out/` then `out-ir/`, in sorted order,
  skipping test sources; where two define the same name, the first wins, as the old ABI cache did. A
  same-name artifact with a different ABI is reported as a warning on the workflow run (`IDepositManager`
  and `ERC20` are known ones).

## Generating locally

With a protocol-internal checkout (for `env/` and tags) and wrangler access to the bucket:

```bash
NODE_SHIMS_MODE=local node scripts/generate.ts mainnet --source-repo ../protocol-internal \
  --wrangler-profile centrifuge-prod [--mode auto|delta|patch|full] [--source-cid <cid>] \
  [--allow-partial-chain] [--allow-history-drop] [--out out]
```

It reads `env/` from the checkout's working tree and tags from its git, fetches the ABI bundles it
needs from R2 into `cache/abis/<tag>/`, walks the live chain (cached in `cache/registry-chain/`), and
writes `out/registry-<network>.json` and its validation report. It publishes nothing, and exits 1
when generation is refused or validation finds errors. The `env/` checks a run makes first (schema,
`retired.json`, version tags) are not part of it: a preview with `sha` makes them on a pushed commit.

You rarely need `--source-cid`: by default the live CID is read from the hostname's DNSLink. It is for
comparing against a specific older layer, to regenerate a broken one or test against a pinned CID.

## Auditing the published chain

The live CID of each network, from its DNSLink:

```bash
dig TXT _dnslink.registry.centrifuge.io +short           # mainnet
dig TXT _dnslink.registry.testnet.centrifuge.io +short   # testnet
# "dnslink=/ipfs/<cid>"
```

A per-layer table, walking `previousRegistry.ipfsHash` to the base snapshot:

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

A healthy chain is small layers on a large base snapshot; layers holding most of the accumulated
contracts mean a publish compared against the wrong baseline. With `@centrifuge/registry-core` in
the repository, `pnpm verify-chain <network>` walks the live chain and also checks every layer against
its CID.

## Checking the publishing credentials

Read-only calls that prove the credentials work without pinning or repointing anything:

```bash
op run --environment weyggnasjjxhanfpqpxfpsl6za --env-file .env.1password -- sh -c '
  curl -s https://api.pinata.cloud/data/testAuthentication -H "Authorization: Bearer $PINATA_JWT"
  curl -s https://api.cloudflare.com/client/v4/zones/b9a43e7d34e470e7ee9b1f41a34cc726/web3/hostnames \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq ".result[] | {id, name, status, dnslink}"'
```

Pinata answers "Congratulations! You are communicating with the Pinata API!"; Cloudflare lists both
registry hostnames with their ids and the CIDs they serve. Writing is not tested: a write would change
what is served.

## The layer cache

A CID's contents never change, so every fetched layer is cached by CID: in R2 at `layers/<cid>.json`
for the Worker, in `cache/registry-chain/<cid>.json` for local runs (delete the directory to fetch
again). A walk then costs one fetch per layer published since the last run. `env/` is cached the same
way, by commit, at `snapshots/<sha>.json`.

## From protocol-internal's scripts

| protocol-internal (`script/registry/`)                            | Here                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `registry.yml` on pull requests: the Registry Preview comment     | the **Registry preview** check run on the PR                                                                                                           |
| `registry.yml` on push: `pin-to-ipfs.js`, `update-cloudflare.js`  | a publish run, as far as `PUBLISH_MODE` allows                                                                                                         |
| main's `registry-publish.yml` dispatch                            | `POST /runs` with `{"kind":"publish"}`                                                                                                                 |
| `node script/registry/abi-registry.js <network>`                  | `node scripts/generate.ts <network> --source-repo <checkout>`                                                                                          |
| `REGISTRY_MODE=delta \| patch \| full`, `--full`                  | `mode` / `--mode`                                                                                                                                      |
| `SOURCE_IPFS=<cid>`                                               | `sourceCid` / `--source-cid`                                                                                                                           |
| `ALLOW_PARTIAL_REGISTRY_CHAIN=1`                                  | `allowPartialChain` / `--allow-partial-chain`                                                                                                          |
| `ALLOW_HISTORY_DROP=1`                                            | `allowHistoryDrop` / `--allow-history-drop`                                                                                                            |
| `REGISTRY_CHAIN_MAX_DEPTH`                                        | none: the walk stops at 500 layers                                                                                                                     |
| `REGISTRY_CHAIN_CACHE_DIR`, `REGISTRY_CHAIN_NO_CACHE=1`           | none: delete `cache/registry-chain/` to fetch again                                                                                                    |
| `SKIP_LIVE_REGISTRY_CHECK=1`                                      | none: every check runs, every time                                                                                                                     |
| `build-abi-cache.js`, `cache/abi-registry/<tag>/out/`             | `build-abis.yml` into R2 `abis/<tag>/`; locally `cache/abis/<tag>/`                                                                                    |
| `validate-env-schema.js`, `validate-env-contract-version-tags.js` | a run's "check env" step: a preview with `sha`                                                                                                         |
| `validate-registry.js`                                            | every run validates; reports at `runs/<id>/registry-<network>.validation.json`                                                                         |
| `walk-registry-chain.js`                                          | [Auditing the published chain](#auditing-the-published-chain)                                                                                          |
| `validate-api-keys.js`                                            | [Checking the publishing credentials](#checking-the-publishing-credentials)                                                                            |
| `detect-changed-environments.js`                                  | the Worker previews a PR, or publishes a push, that touches `env/`; generation is per network, and a network with nothing to publish publishes nothing |
