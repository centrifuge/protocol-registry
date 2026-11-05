#!/usr/bin/env bash
# Uploads the Worker's secrets from the "protocol-registry Worker" 1Password Environment, which the
# 1Password app mounts as a local env file (.env.secrets by default). `op run` loads it into this
# process's environment only, and the values go to `wrangler secret bulk` on stdin, never to disk or
# the terminal.
#
#   NODE_SHIMS_MODE=local scripts/push-secrets.sh [--env-file <path>] [<wrangler args>]
#
# Which secrets go up follows PUBLISH_MODE in wrangler.jsonc, so the Worker holds no publishing
# credential before its stage needs it:
#
#   shadow  GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, SLACK_WEBHOOK_URL,
#           MANUAL_TRIGGER_TOKEN
#   pin     the above and PINATA_JWT
#   live    the above and CLOUDFLARE_API_TOKEN, read from the ops-v3 item .env.1password references
#           (ops-v3's token reconciler rotates it there)
#
# A secret already uploaded stays when the mode goes back down: remove it with `wrangler secret delete`.
# Extra arguments go to wrangler. Re-run after rotating any of them.

set -euo pipefail
set +x

cd "$(dirname "$0")/.."

env_file=.env.secrets
if [ "${1:-}" = "--env-file" ]; then
  env_file=${2:?--env-file needs a path}
  shift 2
fi

for command in op jq pnpm; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done

if ! { [ -p "$env_file" ] || [ -f "$env_file" ]; }; then
  echo "error: mount the \"protocol-registry Worker\" 1Password Environment at $env_file" >&2
  echo "(1Password app: Developer > Environments > Destinations > Local .env file), or pass --env-file" >&2
  exit 1
fi

mode=$(grep -oE '"PUBLISH_MODE": *"[^"]*"' wrangler.jsonc | sed -E 's/.*"([^"]*)"$/\1/')
names="GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_WEBHOOK_SECRET SLACK_WEBHOOK_URL MANUAL_TRIGGER_TOKEN"
sources=(--env-file="$env_file")
case "$mode" in
  pin) names+=" PINATA_JWT" ;;
  live)
    names+=" PINATA_JWT CLOUDFLARE_API_TOKEN"
    sources+=(--env-file=.env.1password)
    ;;
  # wrangler.jsonc: any other value is shadow
  *) mode=shadow ;;
esac

echo ">>> PUBLISH_MODE is $mode; op run reads $env_file$([ "$mode" = live ] && echo " and .env.1password")" >&2
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
