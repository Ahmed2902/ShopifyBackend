#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
umask 077
[[ -f backend.env && -f release.env ]] || { echo "Configure backend.env and release.env first." >&2; exit 1; }
# Never source an environment file as executable shell code.
for image_name in BACKEND_IMAGE MIGRATION_IMAGE FRONTEND_IMAGE; do
  image=$(sed -n "s/^${image_name}=//p" release.env)
  [[ "$image" =~ ^ghcr\.io/ahmed2902/metrico-[a-z]+@sha256:[a-f0-9]{64}$ ]] || {
    echo "$image_name must use a real immutable GHCR sha256 digest." >&2; exit 1;
  }
done
compose=(docker compose --env-file release.env -f compose.prod.yaml)
"${compose[@]}" --profile migration --profile backup config --quiet
"${compose[@]}" --profile migration pull api worker frontend proxy migrate
# Reduce overlap on a small host. PostgreSQL queues persist while the worker is stopped.
"${compose[@]}" stop worker
trap '"${compose[@]}" start worker >/dev/null 2>&1 || true' EXIT
./backup.sh
"${compose[@]}" --profile migration run --rm -T migrate
"${compose[@]}" up -d --wait --wait-timeout 300 api worker frontend proxy
"${compose[@]}" exec -T worker node scripts/check-worker-health.mjs
curl --fail --silent --show-error --max-time 15 https://api.metrico.live/health/ready >/dev/null
curl --fail --silent --show-error --max-time 15 https://metrico.live/api/health >/dev/null
curl --fail --silent --show-error --max-time 15 https://app.metrico.live/api/health >/dev/null
trap - EXIT
echo "Release services are healthy. Complete the merchant and provider smoke checklist."
