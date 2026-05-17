#!/usr/bin/env bash
# Easy launcher for Live Context Collision.
#   ./launch.sh         -> dev server (hot reload)
#   ./launch.sh --prod   -> production build + start
set -euo pipefail

cd "$(dirname "$0")"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
err()  { printf "\033[31m%s\033[0m\n" "$1" >&2; }

bold "▶ Live Context Collision"

# --- node check ---
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed. Install Node 18+ and retry."
  exit 1
fi

# --- env check ---
if [ ! -f .env.local ]; then
  err "Missing .env.local. Copy .env.example and add your keys:"
  err "  cp .env.example .env.local"
  exit 1
fi

missing=""
grep -q '^SPEECHMATICS_API_KEY=.\+' .env.local || missing="$missing SPEECHMATICS_API_KEY"
grep -q '^GEMINI_API_KEY=.\+'       .env.local || missing="$missing GEMINI_API_KEY"
if [ -n "$missing" ]; then
  err "These keys are empty in .env.local:$missing"
  exit 1
fi

# --- deps ---
if [ ! -d node_modules ]; then
  bold "Installing dependencies (first run)…"
  npm install
fi

PORT="$(grep -E '^PORT=' .env.local 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-3000}"

# --- run ---
if [ "${1:-}" = "--prod" ]; then
  bold "Building production bundle…"
  npm run build
  bold "Starting on http://localhost:$PORT  (production)"
  npm start
else
  bold "Starting dev server on http://localhost:$PORT"
  bold "Open the URL, click 'Start meeting', allow the mic."
  npm run dev
fi
