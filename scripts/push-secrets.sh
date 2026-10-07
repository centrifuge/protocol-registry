#!/usr/bin/env bash
# Uploads the Worker's secrets from 1Password: `op run` resolves .env.1password into this process's
# environment only, and the values go to `wrangler secret bulk` on stdin, never to disk or the terminal.
#
#   NODE_SHIMS_MODE=local scripts/push-secrets.sh [--profile <wrangler auth profile>]
#
# Extra arguments go to wrangler. Re-run after rotating any of the referenced items.

set -euo pipefail
set +x

cd "$(dirname "$0")/.."

for command in op jq pnpm; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done

echo ">>> op run reads these 1Password references (read-only):" >&2
grep -hoE 'op://[^"]+' .env.1password | sed 's/^/    /' >&2

op run --env-file=.env.1password -- bash -c '
  set -euo pipefail
  set +x
  json=$(jq -n "env | with_entries(select(.key | startswith(\"SECRET_\")) | .key |= ltrimstr(\"SECRET_\"))")
  # wrangler must authenticate as the operator, not with a token it finds among the secrets
  while read -r name; do unset "$name"; done < <(compgen -e | grep "^SECRET_")
  echo ">>> Uploading $(jq length <<<"$json") secrets" >&2
  printf "%s" "$json" | pnpm exec wrangler secret bulk "$@"
' push-secrets "$@"
