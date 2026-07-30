#!/usr/bin/env bash
# One-command local start (Week-4 implementation rule 6).
#
# From a clean checkout, with only Docker and Node/pnpm installed:
#   ./start.sh
# brings up the full composed system — PostgreSQL, the API (auto-migrates and
# seeds on startup), and the web frontend — via docker-compose.local.yml.
#
#   ./start.sh native   # alternative: postgres in Docker, api+web natively
#                       # via pnpm dev (faster iteration; hot reload)
#
# Documented in the README cold-start guide. Roll back: ./start.sh down
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-docker}"

case "$MODE" in
  down)
    docker compose -f docker-compose.local.yml down
    exit 0
    ;;

  docker)
    echo "Starting full stack (postgres + api + web) via docker compose..."
    docker compose -f docker-compose.local.yml up --build -d
    echo
    echo "Waiting for the API to become healthy..."
    for i in $(seq 1 60); do
      if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
        echo "API is up."
        break
      fi
      sleep 2
      [ "$i" = 60 ] && { echo "API did not become healthy; check: docker compose -f docker-compose.local.yml logs api"; exit 1; }
    done
    echo
    echo "  Web:      http://localhost:5173"
    echo "  API:      http://localhost:3000  (Swagger: /api/docs)"
    echo "  Login:    dev@ship.local / admin123"
    echo
    echo "Stop with: ./start.sh down"
    ;;

  native)
    echo "Starting postgres via docker compose; api+web natively (pnpm dev)..."
    docker compose -f docker-compose.local.yml up -d postgres
    if [ ! -d node_modules ]; then
      pnpm install
    fi
    # scripts/dev.sh creates api/.env.local, the database, migrations and seed
    # on first run, then starts both dev servers with hot reload.
    pnpm dev
    ;;

  *)
    echo "usage: ./start.sh [docker|native|down]" >&2
    exit 2
    ;;
esac
