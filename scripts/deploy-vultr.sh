#!/usr/bin/env sh
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.vultr.yml}"

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Building WorkGraph runtime image"
docker compose -f "$COMPOSE_FILE" build

echo "==> Starting Vultr runtime"
docker compose -f "$COMPOSE_FILE" up -d

echo "==> Service status"
docker compose -f "$COMPOSE_FILE" ps

echo "==> Recent logs"
docker compose -f "$COMPOSE_FILE" logs --tail=80
