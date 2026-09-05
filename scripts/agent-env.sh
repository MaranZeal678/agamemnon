#!/usr/bin/env bash
# Generate the agent's two environment files from the root .env:
#   .env.unprotected — holds Meridian's DB credential (Act 1)
#   .env.protected   — NO DB credential; writes go through Agamemnon (Act 2/3)
# Both are shown on screen during the demo to make the contrast obvious.
# Gitignored (.env.* is ignored). Values are written, not printed.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env
AGENT_DIR="$ROOT_DIR/packages/meridian/agent"

cat > "$AGENT_DIR/.env.unprotected" <<EOF
# Dispatch Copilot — UNPROTECTED (Act 1).
# The agent holds Meridian's own Postgres credential and writes directly.
AGAMEMNON_ENABLED=false
AGENT_NAME=dispatch-copilot
MERIDIAN_DATABASE_URL=${MERIDIAN_DATABASE_URL}

# Reasoning narration (genuinely a model talking; SQL is hardcoded).
NEBIUS_API_KEY=${NEBIUS_API_KEY}
NEBIUS_BASE_URL=${NEBIUS_BASE_URL}
NEBIUS_NARRATOR_MODEL=${NEBIUS_NARRATOR_MODEL}
EOF

cat > "$AGENT_DIR/.env.protected" <<EOF
# Dispatch Copilot — PROTECTED (Act 2/3).
# NOTE: there is NO database password here. The agent cannot touch Postgres.
# Every write is routed through the Agamemnon adapter instead.
AGAMEMNON_ENABLED=true
AGENT_NAME=dispatch-copilot
AGAMEMNON_PROPOSE_URL=${AGAMEMNON_PROPOSE_URL:-http://127.0.0.1:3211}

# Reasoning narration (genuinely a model talking; SQL is hardcoded).
NEBIUS_API_KEY=${NEBIUS_API_KEY}
NEBIUS_BASE_URL=${NEBIUS_BASE_URL}
NEBIUS_NARRATOR_MODEL=${NEBIUS_NARRATOR_MODEL}
EOF

echo "Wrote agent/.env.unprotected and agent/.env.protected (values not shown)."
