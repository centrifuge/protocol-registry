#!/usr/bin/env bash
# Uploads the Worker's secrets from the "protocol-registry Worker" 1Password Environment. `op run
# --environment` (op 2.41.0 or later) loads it into this process's environment only, and the values
# go to `wrangler secret bulk` on stdin, never to disk or the terminal.
#
#   NODE_SHIMS_MODE=local scripts/push-secrets.sh [--environment <ID>] [<wrangler args>]
#
# The Environment's ID comes from --environment or REGISTRY_OP_ENVIRONMENT. The 1Password app shows
# it under Developer > View Environments > Manage environment > Copy environment ID.
#
# Which secrets go up follows PUBLISH_MODE in wrangler.jsonc, so the Worker holds no publishing
# credential before its stage needs it:
#
#   shadow  GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, SLACK_WEBHOOK_URL,
#           MANUAL_TRIGGER_TOKEN
#   pin     the above and PINATA_JWT
#   live    the above and CLOUDFLARE_API_TOKEN, read from the 1Password item .env.1password
#           references (the infrastructure repository rotates it there)
#
# A secret already uploaded stays when the mode goes back down: remove it with `wrangler secret delete`.
# Extra arguments go to wrangler. Re-run after rotating any of them.

set -euo pipefail
set +x

cd "$(dirname "$0")/.."

environment=${REGISTRY_OP_ENVIRONMENT:-}
if [ "${1:-}" = "--environment" ]; then
  environment=${2:?--environment needs an Environment ID}
  shift 2
fi
if [ -z "$environment" ]; then
  echo "error: set REGISTRY_OP_ENVIRONMENT or pass --environment <ID>, the ID of the" \
    "\"protocol-registry Worker\" 1Password Environment (1Password app: Developer >" \
    "View Environments > Manage environment > Copy environment ID)" >&2
  exit 1
fi

for command in op jq pnpm; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done

op_version=$(op --version)
if [ "$(printf '%s\n' 2.41.0 "$op_version" | sort -V | head -1)" != 2.41.0 ]; then
  echo "error: op $op_version cannot read Environments; op run --environment needs 2.41.0 or later" >&2
  exit 1
fi

mode=$(grep -oE '"PUBLISH_MODE": *"[^"]*"' wrangler.jsonc | sed -E 's/.*"([^"]*)"$/\1/')
names="GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET SLACK_WEBHOOK_URL MANUAL_TRIGGER_TOKEN"
sources=(--environment "$environment")
case "$mode" in
  pin) names+=" PINATA_JWT" ;;
  live)
    names+=" PINATA_JWT CLOUDFLARE_API_TOKEN"
    sources+=(--env-file=.env.1password)
    ;;
  # wrangler.jsonc: any other value is shadow
  *) mode=shadow ;;
esac

echo ">>> PUBLISH_MODE is $mode; op run reads Environment $environment$([ "$mode" = live ] && echo " and .env.1password")" >&2
echo ">>> and uploads: $names" >&2

# shellcheck disable=SC2016 # the inner script expands in its own shell
PUSH_SECRETS_NAMES=$names op run "${sources[@]}" -- bash -c '
  set -euo pipefail
  set +x
  read -ra names <<<"$PUSH_SECRETS_NAMES"
  missing=()
  for name in "${names[@]}"; do [ -n "${!name:-}" ] || missing+=("$name"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "error: empty or missing in 1Password: ${missing[*]}. Nothing was uploaded." >&2
    exit 1
  fi
  if [[ ! $SLACK_WEBHOOK_URL =~ ^https://hooks\.slack\.com/ ]]; then
    echo "error: SLACK_WEBHOOK_URL is not a Slack incoming webhook URL. Nothing was uploaded." >&2
    exit 1
  fi
  json=$(jq -n "\$ARGS.positional | map({key: ., value: env[.]}) | from_entries" --args "${names[@]}")
  # wrangler must authenticate as the operator, not with a token it finds among the secrets
  unset "${names[@]}"
  while read -r name; do unset "$name"; done < <(compgen -e | grep "^CLOUDFLARE_")
  echo ">>> Uploading $(jq length <<<"$json") secrets" >&2
  printf "%s" "$json" | pnpm exec wrangler secret bulk "$@"
' push-secrets "$@"
