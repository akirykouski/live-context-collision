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

echo "==> Waiting for app to report healthy (this is the Vultr LB's target)"
i=0
until [ "$(docker compose -f "$COMPOSE_FILE" ps app --format '{{.Health}}')" = "healthy" ]; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "!! App did not become healthy in time" >&2
    docker compose -f "$COMPOSE_FILE" logs --tail=80 app
    exit 1
  fi
  sleep 2
done

echo "==> App healthy. Data-residency posture for this instance:"
curl -fsS http://localhost:3000/api/deployment \
  | sed -n 's/.*"residency":\({.*}\).*/\1/p' \
  || echo "  (could not read /api/deployment)"
echo
echo "  Edge geo-routing is provided by the Cloudflare Worker"
echo "  (deploy/cloudflare/); the managed Vultr LB fronts these instances."

echo "==> Recent logs"
docker compose -f "$COMPOSE_FILE" logs --tail=80
