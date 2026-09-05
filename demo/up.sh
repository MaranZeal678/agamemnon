#!/usr/bin/env bash
# Start every demo service (idempotent). Safe to run repeatedly.
#   - Convex local backend (anonymous, Node 24) : 3210/3211
#   - Meridian API + dispatch web              : 8787 / 5173
#   - Agamemnon operator console               : 5174
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT_DIR/demo/.logs"; mkdir -p "$LOGS"
NODE24="$HOME/.nvm/versions/node/v24.12.0/bin"

up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if up 3210; then
  echo "✓ Convex already running (3210)"
else
  echo "→ starting Convex (anonymous local, Node 24)…"
  ( cd "$ROOT_DIR/packages/agamemnon" && PATH="$NODE24:$PATH" CONVEX_AGENT_MODE=anonymous \
      nohup npx convex dev > "$LOGS/convex.log" 2>&1 & )
  for i in $(seq 1 40); do up 3210 && up 3211 && break; sleep 1; done
  echo "✓ Convex up"
fi

if up 8787; then
  echo "✓ Meridian web already running (5173)"
else
  echo "→ starting Meridian (API 8787 + dispatch board 5173)…"
  ( cd "$ROOT_DIR/packages/meridian/web" && nohup npm run dev > "$LOGS/meridian.log" 2>&1 & )
  for i in $(seq 1 30); do up 5173 && break; sleep 1; done
  echo "✓ Meridian up → http://localhost:5173"
fi

if up 5174; then
  echo "✓ Agamemnon console already running (5174)"
else
  echo "→ starting Agamemnon console (5174)…"
  ( cd "$ROOT_DIR/packages/agamemnon/console" && nohup npm run dev > "$LOGS/console.log" 2>&1 & )
  for i in $(seq 1 30); do up 5174 && break; sleep 1; done
  echo "✓ Console up → http://localhost:5174"
fi

echo ""
echo "  Dispatch board   →  http://localhost:5173/#/dispatch"
echo "  Agamemnon console →  http://localhost:5174"
echo "  Run an act: make act1 | make act2 | make act3   (reset with: make reset)"
