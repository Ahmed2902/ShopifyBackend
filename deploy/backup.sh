#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
umask 077
command -v age >/dev/null || { echo "Install age before creating database backups." >&2; exit 1; }
[[ -f backup.env && -f backup.recipient ]] || { echo "Configure backup.env and backup.recipient first." >&2; exit 1; }
recipient=$(cat backup.recipient)
[[ "$recipient" =~ ^age1[a-z0-9]+$ ]] || { echo "backup.recipient must contain one age public recipient." >&2; exit 1; }
mkdir -p backups
chmod 700 backups
output="backups/metrico-public-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
trap 'rm -f "$output.tmp"' EXIT
docker compose --env-file release.env -f compose.prod.yaml --profile backup run --rm -T backup |
  age --recipient "$recipient" --output "$output.tmp"
mv "$output.tmp" "$output"
echo "Encrypted application backup created: $output"
echo "Copy it off this server and verify a restore before treating it as disaster recovery."
