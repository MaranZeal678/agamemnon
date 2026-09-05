#!/usr/bin/env bash
# Push Agamemnon's runtime secrets/config from .env into the LOCAL Convex
# deployment's environment. Values are never printed. The Postgres URL lives
# ONLY here (and in .env) — never in the agent's environment.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

# Convex's local backend runs "use node" actions with a supported Node (20/22/24).
# The default `node` here is v25, so pin nvm's v24 for all convex commands.
NODE24="$HOME/.nvm/versions/node/v24.12.0/bin"
[[ -d "$NODE24" ]] && export PATH="$NODE24:$PATH"
export CONVEX_AGENT_MODE=anonymous

cd "$ROOT_DIR/packages/agamemnon"

set_var() {  # $1 = name; value taken from the environment (from .env)
  local name="$1" val="${!1:-}"
  if [[ -z "$val" ]]; then
    echo "  (skip $name — empty in .env)"
    return
  fi
  npx convex env set "$name" "$val" >/dev/null 2>&1 && echo "  set $name" || echo "  FAILED $name"
}

echo "Pushing environment into local Convex deployment…"
set_var AGAMEMNON_DATABASE_URL
set_var NEBIUS_API_KEY
set_var NEBIUS_BASE_URL
set_var NEBIUS_CLASSIFIER_MODEL
set_var NEBIUS_STOCK_MODEL
set_var NEBIUS_NARRATOR_MODEL
set_var NEBIUS_DATASET_MODEL
set_var NEBIUS_FRONTIER_MODEL
set_var CLASSIFIER_ENABLED
set_var CLASSIFIER_TIMEOUT_MS
echo "Done (values not shown)."
