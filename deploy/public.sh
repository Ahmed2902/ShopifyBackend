#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
umask 077
[[ -f release.env ]] || { echo "Configure release.env first." >&2; exit 1; }
# This is an initial bootstrap, never a downgrade of an existing full release.
if [[ -n "$(docker ps -aq --filter label=com.docker.compose.project=metrico --filter label=com.docker.compose.service=api)" ||
      -n "$(docker ps -aq --filter label=com.docker.compose.project=metrico --filter label=com.docker.compose.service=worker)" ]]; then
  echo "API/worker containers already exist; use release.sh for full-release updates." >&2
  exit 1
fi
for image_name in FRONTEND_IMAGE PROXY_IMAGE; do
  case "$image_name" in
    FRONTEND_IMAGE) repository=ghcr.io/ahmed2902/metrico-frontend ;;
    PROXY_IMAGE) repository=caddy ;;
  esac
  image=$(sed -n "s/^${image_name}=//p" release.env)
  prefix="${repository}@sha256:"
  digest="${image#"$prefix"}"
  [[ "$image" == "$prefix"* && "$digest" =~ ^[a-f0-9]{64}$ && "$digest" != "$(printf '%064d' 0)" ]] || {
    echo "$image_name must use a real immutable digest from $repository." >&2; exit 1;
  }
done
compose=(docker compose --env-file release.env -f compose.public.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" pull frontend proxy
"${compose[@]}" up -d --wait --wait-timeout 300 frontend proxy
for path in /api/health /privacy /terms /data-deletion; do
  curl --fail --silent --show-error --max-time 15 "https://metrico.live$path" >/dev/null
done
echo "Public website is healthy. App/API remain unavailable until release.sh completes the full deployment."
