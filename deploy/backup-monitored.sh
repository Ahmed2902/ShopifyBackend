#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
umask 077
status=ok
./backup.sh || status=error
printf '%s\n' "$status" > backup.status.tmp
mv backup.status.tmp backup.status
# Reuse the one host monitor, rather than requiring another billable cron monitor.
./monitor.sh
[[ "$status" == ok ]]
