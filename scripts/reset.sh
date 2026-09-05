#!/usr/bin/env bash
# Restore a cold demo state:
#   1. Re-seed Postgres (412k loads back, migration re-applied)
#   2. Clear Convex operational tables (runs/actions/audit/undo/approvals)
#   3. Re-seed the policy + agent median (idempotent)
# Phase 1 version. Phase 4 makes this sub-10s via snapshot restore.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

NODE24="$HOME/.nvm/versions/node/v24.12.0/bin"
[[ -d "$NODE24" ]] && export PATH="$NODE24:$PATH"
export CONVEX_AGENT_MODE=anonymous

echo "→ re-seeding Postgres…"
bash "$ROOT_DIR/scripts/db-seed.sh" >/dev/null
echo "→ clearing Convex operational state…"
( cd "$ROOT_DIR/packages/agamemnon" && npx convex run internal.core.resetDemoState '{}' >/dev/null )
echo "→ re-seeding policy + agent median…"
( cd "$ROOT_DIR/packages/agamemnon" && npx convex run internal.core.seed \
    '{"agent":"dispatch-copilot","median30d":1210,"allowlist":["loads","bookings"],"perRunDestructiveRowBudget":5000}' >/dev/null )
echo "✓ cold demo state restored."
