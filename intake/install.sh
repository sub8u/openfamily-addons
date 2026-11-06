#!/usr/bin/env bash
# openfamily-addons: install (or update) the message intake
# SPDX-License-Identifier: AGPL-3.0-only
#
# Usage (on the machine that runs OpenFamily's Docker containers):
#   bash intake/install.sh
#
# Re-run it after updating OpenFamily, so the intake uses the new server image.
#
# Settings (environment variables):
#   OPENFAMILY_ENV=$HOME/OpenFamily/.env   OpenFamily's .env file (POSTGRES_*, JWT_SECRET, VAPID_*)
#   OPENFAMILY_SERVER=openfamily-server    name of OpenFamily's server container
#   INTAKE_KEYWORD=#add                    word that marks a message for OpenFamily
#   INTAKE_PORT=3100                       local port (bound to 127.0.0.1 only)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$DIR/openfamily-intake.js"
ENV_FILE="${OPENFAMILY_ENV:-$HOME/OpenFamily/.env}"
SERVER="${OPENFAMILY_SERVER:-openfamily-server}"
PORT="${INTAKE_PORT:-3100}"
KEYWORD="${INTAKE_KEYWORD:-#add}"
KEY_FILE="$HOME/.openfamily-intake.env"
NAME="openfamily-intake"

die() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed or not on PATH"
[ -f "$SCRIPT" ] || die "cannot find $SCRIPT"
[ -f "$ENV_FILE" ] || die "cannot find OpenFamily's .env at $ENV_FILE (set OPENFAMILY_ENV=...)"
docker inspect "$SERVER" >/dev/null 2>&1 || die "no container named '$SERVER' (set OPENFAMILY_SERVER=...)"
grep -q '^VAPID_PUBLIC_KEY=.\+' "$ENV_FILE" || echo "WARNING: VAPID keys are not set in $ENV_FILE; confirmations will not be pushed."

IMAGE="$(docker inspect -f '{{.Image}}' "$SERVER")"
NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$SERVER" | awk '{print $1}')"
[ -n "$NETWORK" ] || die "could not find the Docker network of '$SERVER'"

# The shared secret that clients send as X-Intake-Key. Created once, kept across updates.
if [ ! -f "$KEY_FILE" ]; then
    umask 077
    echo "INTAKE_KEY=$(openssl rand -hex 24)" > "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped \
    --network "$NETWORK" --memory 128m \
    --env-file "$ENV_FILE" --env-file "$KEY_FILE" \
    -e POSTGRES_HOST=postgres -e INTAKE_PORT="$PORT" -e INTAKE_KEYWORD="$KEYWORD" \
    -p "127.0.0.1:$PORT:$PORT" \
    -v "$SCRIPT:/app/openfamily-intake.js:ro" \
    "$IMAGE" node /app/openfamily-intake.js >/dev/null

sleep 3
docker logs --tail 3 "$NAME"
curl -fsS "http://127.0.0.1:$PORT/" >/dev/null || die "the intake did not answer on port $PORT; see: docker logs $NAME"

cat <<EOF

== Intake is running on http://127.0.0.1:$PORT (local only) ==

Next steps:
 1. Make it reachable over HTTPS at a path such as /intake on your OpenFamily address.
    With Tailscale Funnel:
       sudo tailscale funnel --bg --set-path=/intake http://127.0.0.1:$PORT
    With another reverse proxy (Caddy, nginx, ...): proxy /intake to 127.0.0.1:$PORT.
 2. Test it (replace the URL and use a real member's OpenFamily login email):
       curl -s -X POST https://YOUR-OPENFAMILY-ADDRESS/intake \\
         -H "X-Intake-Key: \$(cut -d= -f2 $KEY_FILE)" -H 'Content-Type: application/json' \\
         -d '{"who":"you@example.com","text":"$KEYWORD test bananas"}'
 3. Set up the iPhone automation: see intake/IPHONE-SHORTCUT.md

Your intake key (keep it private, like a password):
   $(cut -d= -f2 "$KEY_FILE")
EOF
