#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
status=ok
./check-health.sh || status=error
# Disk pressure is actionable before logs/images/backups fill the host.
used=$(df -P . | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if [[ ! "$used" =~ ^[0-9]+$ || "$used" -ge 80 ]]; then
  echo 'Metrico host disk usage is at least 80% or could not be checked.' >&2
  status=error
fi
# Check container limits separately; these constrain the app even on a larger VM.
if stats=$(docker stats --no-stream --format '{{.MemPerc}}' $(docker compose --env-file release.env -f compose.prod.yaml ps -q api worker frontend proxy)); then
  if ! awk '{gsub(/%/, "", $1); if ($1 >= 90) bad=1} END {exit bad}' <<< "$stats"; then
    echo 'A Metrico container is using at least 90% of its memory limit.' >&2
    status=error
  fi
else
  status=error
fi
# Check creation of the encrypted dump; off-host transfer still needs its own verification.
if [[ ! -d backups ]] || [[ -z "$(find backups -maxdepth 1 -type f -name 'metrico-public-*.dump.age' -mmin -2160 -print -quit)" ]] ||
   [[ -f backup.status && "$(cat backup.status)" != ok ]]; then
  echo 'Encrypted backup is missing, older than 36 hours, or the last backup failed.' >&2
  status=error
fi
docker compose --env-file release.env -f compose.prod.yaml run --rm --no-deps -T \
  --entrypoint node api scripts/monitor-check-in.mjs metrico-host "$status"
[[ "$status" == ok ]]
