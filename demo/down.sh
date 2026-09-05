#!/usr/bin/env bash
# Stop demo services started by up.sh (Convex, Meridian web, console).
# Leaves Postgres (a system service) alone.
set -uo pipefail
echo "Stopping demo services…"
for port in 5173 5174 8787; do
  pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pid" ] && { kill $pid 2>/dev/null && echo "  stopped :$port"; }
done
# Convex dev + its local backend
pkill -f "convex dev" 2>/dev/null && echo "  stopped convex dev" || true
pkill -f "convex-local-backend" 2>/dev/null && echo "  stopped convex backend" || true
echo "Done. (Postgres left running.)"
