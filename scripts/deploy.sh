#!/usr/bin/env bash
# Deploys the Worker from a commit on main, labelled the way the other Workers' deployments are: the
# version's message names the commit (and the PUBLISH_MODE it runs in), and its tag is the short sha,
# so the Cloudflare dashboard shows what is running. .github/workflows/deploy.yml runs it on every
# push to main.
#
#   NODE_SHIMS_MODE=local scripts/deploy.sh [<wrangler args>]
#
# Refuses uncommitted changes and a commit that is not on origin/main, so the label always names a
# commit anyone can check out. Extra arguments go to wrangler (e.g. --profile centrifuge-prod).

set -euo pipefail

cd "$(dirname "$0")/.."

git fetch -q origin main
if [ -n "$(git status --porcelain)" ]; then
  echo "error: the working tree has changes; deploy a commit on main" >&2
  exit 1
fi
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "error: $(git rev-parse --short HEAD) is not on origin/main; deploy a commit on main" >&2
  exit 1
fi

sha=$(git rev-parse --short=7 HEAD)
mode=$(grep -oE '"PUBLISH_MODE": *"[^"]*"' wrangler.jsonc | sed -E 's/.*"([^"]*)"$/\1/')
echo ">>> Deploying $sha with PUBLISH_MODE $mode" >&2
# In GitHub Actions, the deploy workflow's job summary names them
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'sha=%s\nmode=%s\n' "$sha" "$mode" >>"$GITHUB_OUTPUT"
fi
exec pnpm exec wrangler deploy --message "Deployed commit: $sha (PUBLISH_MODE $mode)" --tag "$sha" "$@"
