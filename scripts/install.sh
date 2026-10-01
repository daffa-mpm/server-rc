#!/usr/bin/env bash
#
# One-shot installer. Run this ON THE SERVER, from the repository root:
#
#   sudo ./scripts/install.sh
#
# It generates a token, writes .env, builds the image and starts the container.
# It changes nothing outside this directory and the Docker daemon.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

bold "server-remote-control installer"
echo

# --- preflight ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    red "docker is not installed or not on PATH."
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    red "The docker compose plugin is missing. Install docker-compose-plugin and retry."
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    red "Cannot talk to the Docker daemon. Run this as root or as a user in the docker group."
    exit 1
fi

# --- token -------------------------------------------------------------------
if [ -f .env ] && grep -qE '^RC_TOKEN=.+' .env; then
    ylw ".env already has an RC_TOKEN; keeping it."
    TOKEN="$(grep -E '^RC_TOKEN=' .env | head -1 | cut -d= -f2-)"
    NEW_TOKEN=0
else
    if command -v openssl >/dev/null 2>&1; then
        TOKEN="$(openssl rand -hex 32)"
    else
        TOKEN="$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    [ -f .env ] || cp .env.example .env
    # Replace an empty/missing RC_TOKEN line without touching anything else.
    if grep -qE '^RC_TOKEN=' .env; then
        sed -i "s|^RC_TOKEN=.*|RC_TOKEN=${TOKEN}|" .env
    else
        printf '\nRC_TOKEN=%s\n' "$TOKEN" >> .env
    fi
    NEW_TOKEN=1
    grn "Generated a new 64-character token."
fi

chmod 600 .env
grn ".env permissions set to 600."

# --- label -------------------------------------------------------------------
if ! grep -qE '^RC_SERVER_LABEL=.+' .env; then
    printf 'RC_SERVER_LABEL=%s\n' "$(hostname)" >> .env
fi

# --- build and start ---------------------------------------------------------
echo
bold "Building image..."
docker compose build

echo
bold "Starting container..."
docker compose up -d

echo
bold "Waiting for health..."
PORT="$(grep -E '^RC_PORT=' .env | head -1 | cut -d= -f2- || true)"
PORT="${PORT:-8723}"

ok=0
for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
        ok=1
        break
    fi
    sleep 1
done

if [ "$ok" != "1" ]; then
    red "The server did not become healthy. Recent logs:"
    docker compose logs --tail 40
    exit 1
fi

grn "Healthy on http://127.0.0.1:${PORT}"

# --- next steps --------------------------------------------------------------
echo
bold "=============================================================="
bold " Installed."
bold "=============================================================="
echo
echo "The container listens on 127.0.0.1:${PORT} only. Point your existing"
echo "reverse proxy at it (see README.md for nginx / Caddy / Traefik blocks),"
echo "then connect from your laptop with:"
echo
if [ "$NEW_TOKEN" = "1" ]; then
    echo "  claude mcp add --transport http $(hostname) \\"
    echo "    https://YOUR-DOMAIN/mcp \\"
    echo "    --header \"Authorization: Bearer ${TOKEN}\""
    echo
    ylw "That token is shown once here. It is also in ${ROOT}/.env"
else
    echo "  claude mcp add --transport http $(hostname) \\"
    echo "    https://YOUR-DOMAIN/mcp \\"
    echo "    --header \"Authorization: Bearer \$(grep ^RC_TOKEN= ${ROOT}/.env | cut -d= -f2-)\""
fi
echo
ylw "Anyone with that token has root on this host. Treat it as a root password."
echo
echo "Useful commands:"
echo "  docker compose logs -f        # live audit log of every tool call"
echo "  docker compose restart        # apply .env changes"
echo "  docker compose down           # stop and remove"
