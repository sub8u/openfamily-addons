#!/usr/bin/env bash
# openfamily-addons: install the daily digest
# SPDX-License-Identifier: AGPL-3.0-only
#
# Usage (on the machine that runs OpenFamily's Docker containers):
#   bash digest/install.sh              # preview today's digest, then schedule it daily
#   bash digest/install.sh --send-test  # same, and also send one real notification now
#
# Settings (environment variables):
#   DIGEST_HOUR=7                         local hour to send (OpenFamily's TZ setting)
#   OPENFAMILY_SERVER=openfamily-server   name of OpenFamily's server container
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$DIR/openfamily-digest.js"
SERVER="${OPENFAMILY_SERVER:-openfamily-server}"
HOUR="${DIGEST_HOUR:-7}"
LOG="$HOME/openfamily-digest.log"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed or not on PATH"
command -v crontab >/dev/null || die "crontab is not available (install the 'cron' package)"
[ -f "$SCRIPT" ] || die "cannot find $SCRIPT"
docker inspect "$SERVER" >/dev/null 2>&1 || die "no container named '$SERVER' (set OPENFAMILY_SERVER=...)"
[[ "$HOUR" =~ ^([0-9]|1[0-9]|2[0-3])$ ]] || die "DIGEST_HOUR must be 0-23"

echo "== Preview of today's digest (nothing is sent) =="
docker exec -i -e DIGEST_FORCE=1 -e DIGEST_DRY_RUN=1 -w /app "$SERVER" node - < "$SCRIPT"

if [ "${1:-}" = "--send-test" ]; then
    echo; echo "== Sending one test notification now =="
    docker exec -i -e DIGEST_FORCE=1 -w /app "$SERVER" node - < "$SCRIPT"
fi

# Run every hour; the script itself only sends at DIGEST_HOUR in the family's time zone.
LINE="0 * * * * docker exec -i -e DIGEST_HOUR=$HOUR -w /app $SERVER node - < $SCRIPT >> $LOG 2>&1"
( crontab -l 2>/dev/null | grep -v 'openfamily-digest' || true; echo "$LINE" ) | crontab -

echo
echo "== Scheduled =="
echo "The digest will be sent every day at ${HOUR}:00 (OpenFamily's time zone)."
echo "Log: $LOG"
echo "To remove it: crontab -l | grep -v openfamily-digest | crontab -"
