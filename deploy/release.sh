#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
umask 077
[[ -f backend.env && -f release.env ]] || { echo "Configure backend.env and release.env first." >&2; exit 1; }
# Never source an environment file as executable shell code.
declare -A repositories=(
  [BACKEND_IMAGE]="ghcr.io/ahmed2902/metrico-backend"
  [MIGRATION_IMAGE]="ghcr.io/ahmed2902/metrico-migrations"
  [FRONTEND_IMAGE]="ghcr.io/ahmed2902/metrico-frontend"
  [PROXY_IMAGE]="caddy"
)
for image_name in BACKEND_IMAGE MIGRATION_IMAGE FRONTEND_IMAGE PROXY_IMAGE; do
  image=$(sed -n "s/^${image_name}=//p" release.env)
  repository="${repositories[$image_name]}"
  prefix="${repository}@sha256:"
  digest="${image#"$prefix"}"
  [[ "$image" == "$prefix"* && "$digest" =~ ^[a-f0-9]{64}$ && "$digest" != "$(printf '%064d' 0)" ]] || {
    echo "$image_name must use a real immutable digest from $repository." >&2; exit 1;
  }
done
compose=(docker compose --env-file release.env -f compose.prod.yaml)
"${compose[@]}" --profile migration --profile backup config --quiet
"${compose[@]}" --profile migration pull api worker frontend proxy migrate
# Reject startup configuration before stopping a healthy worker or changing the schema.
"${compose[@]}" --profile migration run --rm -T --entrypoint node migrate scripts/check-production-env.mjs
# Reduce overlap on a small host. PostgreSQL queues persist while the worker is stopped.
"${compose[@]}" stop worker
trap '"${compose[@]}" start worker >/dev/null 2>&1 || true' EXIT
./backup.sh
"${compose[@]}" --profile migration run --rm -T migrate
# From this point, Compose may replace the stopped worker. Never restart a new
# worker automatically if runtime startup or the subsequent health checks fail.
trap - EXIT
"${compose[@]}" up -d --wait --wait-timeout 300 api worker frontend proxy
"${compose[@]}" exec -T worker node scripts/check-worker-health.mjs
curl --fail --silent --show-error --max-time 15 https://api.metrico.live/health/ready >/dev/null
curl --fail --silent --show-error --max-time 15 https://metrico.live/api/health >/dev/null
curl --fail --silent --show-error --max-time 15 https://app.metrico.live/api/health >/dev/null
echo "Release services are healthy. Complete the merchant and provider smoke checklist."
