#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Elamaran Elangovan
# Register Agamemnon's principals in the local Convex deployment:
#   - the agent (dispatch-copilot) and the human who owns it
#   - console operators: alice + bob (approvers), maran (admin)
# Tokens live only in .env. They are hashed HERE and only the hashes are sent
# to Convex, so the deployment never stores a usable credential. Never prints a
# token.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_env

NODE24="$HOME/.nvm/versions/node/v24.12.0/bin"
[[ -d "$NODE24" ]] && export PATH="$NODE24:$PATH"
export CONVEX_AGENT_MODE=anonymous

: "${AGAMEMNON_AGENT_TOKEN:?run make gen-creds first}"
: "${AGAMEMNON_OPERATOR_ALICE_TOKEN:?run make gen-creds first}"
: "${AGAMEMNON_OPERATOR_BOB_TOKEN:?run make gen-creds first}"
: "${AGAMEMNON_OPERATOR_MARAN_TOKEN:?run make gen-creds first}"

payload=$(node -e '
  const { createHash } = require("node:crypto");
  const h = (t) => createHash("sha256").update("agamemnon-token:" + t).digest("hex");
  const e = process.env;
  process.stdout.write(JSON.stringify({
    agents: [{ name: "dispatch-copilot", owner: e.AGAMEMNON_AGENT_OWNER || "maran", tokenHash: h(e.AGAMEMNON_AGENT_TOKEN) }],
    operators: [
      { name: "alice", role: "approver", tokenHash: h(e.AGAMEMNON_OPERATOR_ALICE_TOKEN) },
      { name: "bob",   role: "approver", tokenHash: h(e.AGAMEMNON_OPERATOR_BOB_TOKEN) },
      { name: "maran", role: "admin",    tokenHash: h(e.AGAMEMNON_OPERATOR_MARAN_TOKEN) },
    ],
  }));
')

( cd "$ROOT_DIR/packages/agamemnon" && npx convex run internal.core.provisionPrincipals "$payload" >/dev/null )
echo "Principals registered (agent: dispatch-copilot; operators: alice, bob, maran). Tokens not shown."
echo "Console sign-in: paste an operator token from .env (e.g. AGAMEMNON_OPERATOR_ALICE_TOKEN)."
