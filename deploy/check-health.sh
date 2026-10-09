#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
compose=(docker compose --env-file release.env -f compose.prod.yaml)
for service in api worker frontend proxy; do
  id=$("${compose[@]}" ps -q "$service")
  [[ -n "$id" ]] || { echo "Missing service: $service" >&2; exit 1; }
  state=$(docker inspect --format '{{.State.Status}}' "$id")
  [[ "$state" == running ]] || { echo "Service stopped: $service" >&2; exit 1; }
  health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")
  [[ "$health" == healthy || "$service" == proxy && "$health" == none ]] || {
    echo "Service unhealthy: $service" >&2; exit 1;
  }
done
curl --fail --silent --show-error --max-time 15 https://api.metrico.live/health/ready >/dev/null
curl --fail --silent --show-error --max-time 15 https://metrico.live/api/health >/dev/null
curl --fail --silent --show-error --max-time 15 https://app.metrico.live/api/health >/dev/null
echo "Metrico services and public HTTPS endpoints are healthy."
