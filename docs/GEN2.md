# Agamemnon Gen 2 — an effect-typed reference monitor for AI agents

> Building on sagas, WYSIWYS, and selective-repair systems (Retro / Warp / Aire),
> and complementary to data-flow defences (CaMeL, FIDES, Progent), Agamemnon is —
> to our knowledge — the first reference monitor that, across heterogeneous
> systems, (a) classifies each agent effect by reversibility before execution,
> (b) binds human approval to that previewed effect, and (c) verifies the
> realised effect against systems of record afterwards, with oversight-reducing
> actions as a distinct enforcement class. We evaluate on rebuilt real-world
> agent incidents.

Agents never hold the keys. A **broker** does, and every agent action — SQL,
files, GitHub, Terraform, payments, email, monitoring — goes through one loop:

1. **Preview** — the connector measures what the action would *really* do and
   labels its fidelity honestly (`exact` / `estimated` / `rendered`).
2. **Bind** — approval is bound to a hash of that measured effect plus a
   precondition token (row-set hash, blob SHA, saved-plan hash, charge state).
   If the world drifts before execution, nothing runs.
3. **Admit by reversibility** — every effect is typed `undo` / `compensate` /
   `hold` / `irreversible` *before* it runs. Irreversible effects need two humans
   or are converted into a cancellable hold (outbox, held refund, delayed delete).
4. **Verify** — afterwards, the agent's claims ("only staging", "tests pass",
   "refunded $50", "rollback is impossible") are checked against systems of
   record it cannot write to. Contradictions tighten what it may do next.

**Oversight-reducing actions are their own class** across tools: deleting or
skipping tests, `continue-on-error` in CI, muting alerts, stopping CloudTrail,
weakening audit tables or branch protection, an agent editing its own
permission files. Always two humans; never auto-approved; never learned.

## What is in the box

| Package | What it is |
|---|---|
| `packages/kernel` | Pure, dependency-free core: effect model, binding, admission, oversight catalogue, claims, budgets/leases/taint, approvals, receipts, selective revert, shell analysis. Runs in Convex, Node, Electron and the browser. |
| `packages/broker` | The broker: node:sqlite store, vault, engine, HTTP API, operator console (`/console`) and approval page. Connectors: Postgres, filesystem, GitHub, Terraform, Stripe, email outbox, Datadog/PagerDuty. |
| `packages/agamemnon-mcp` | MCP server (stdio) — `agm_query`, `agm_propose`, `agm_status`, `agm_cancel`, `agm_claim`, task tools. No raw SQL, no credential, no in-client approval. |
| `packages/hooks` | One pre-tool hook for Claude Code, Cursor, Codex, Gemini CLI and Windsurf. Advisory; fails closed on risky actions. |
| `packages/agamemnon-cli` | `agamemnon init / sweep / coverage / harden-db / check-migration / receipts verify / admin`. |
| `bench/` | Agent Incident Replay Bench — 17 rebuilt agent incidents + 5 benign controls, scored on effects. |
| `packages/agamemnon` | Gen 1 (Convex + Postgres demo), now hardened and running the shared kernel. |

## Run it

```bash
make broker                       # http://127.0.0.1:7700/console — first run writes ~/.agamemnon/bootstrap-admin.token
make test-all                     # every suite (broker tests need local Postgres)
make bench                        # bench/results/scorecard.{json,md}
```

Register an agent and a database (admin token from the bootstrap file):

```bash
export AGAMEMNON_ADMIN_TOKEN=$(cat ~/.agamemnon/bootstrap-admin.token)
node packages/agamemnon-cli/bin/agamemnon.js admin principal add --name claude-code --kind agent --owner you
node packages/agamemnon-cli/bin/agamemnon.js admin principal add --name alice --kind human --role approver
node packages/agamemnon-cli/bin/agamemnon.js admin secret --name postgres/app --value "$DATABASE_URL"
node packages/agamemnon-cli/bin/agamemnon.js admin target --system postgres --resource connection:app --env prod \
  --fingerprint "db.internal:5432/app" --config '{"secret":"postgres/app","allowlist":["orders","customers"],"tables":{"customers":{"private":true,"piiColumns":["email"]}}}'
node packages/agamemnon-cli/bin/agamemnon.js init --agents claude --token <agent token>
```

Docker: `docker compose -f deploy/docker-compose.yml up` (Postgres, broker,
Mailpit; rules-only, no LLM key). *Not yet verified on a Docker host — the
development machine has no Docker; treat it as a starting point.*

## HTTP API (abridged)

| Who | Endpoint |
|---|---|
| agent | `POST /v1/tasks {goal, parentTaskId?, tenant?}` · `POST /v1/effects {taskId, operation, params, declared?, provenance?, claims?, waitSeconds?}` · `GET /v1/effects/:id` · `POST /v1/effects/:id/cancel` · `POST /v1/claims {taskId, claims, text?}` · `POST /v1/hooks/intent` · `POST /v1/tasks/:id/end` |
| operator | `GET /v1/console/state` · `POST /v1/effects/:id/approve\|deny\|undo` · `POST /v1/tasks/:id/revert` · `POST /v1/artifacts/:id/promote` · `GET /v1/audit[/verify]` · `GET /v1/receipts[/verify]` · `GET /v1/evidence` · `GET /v1/metrics` · `POST /v1/policy/replay` · `POST /v1/policy-changes/:id/approve` · `POST /v1/break-glass` · `GET /v1/taint/dependents?source=` |
| admin | `POST /v1/admin/principals\|targets\|secrets\|mode\|settings\|canary` (mode / settings create a pending two-person change) |

## Claims we make — and claims we never make

We credit the lineage up front and claim only the combination plus effect
semantics. We **never** claim: the first credential broker, rollback, undo,
provenance, audit log, approval flow or agent guardrail; one-click undo of SaaS
side effects that already fired (webhooks, automations, delivered email);
denial memory robust to rewordings.

| Expected objection | Answer |
|---|---|
| "Just Temporal / sagas" | Effects are typed and gated *before* execution; compensations are per connector, not hand-written. |
| "Just Rubrik Agent Rewind" | Rewind restores files/DB/config after the fact. Agamemnon gates up front, binds approval, and covers payments, email and GitHub. *(Re-check Rewind's current scope before pitching.)* |
| "Just Galileo / tau-bench" | Those read the agent's own trace or run offline. Agamemnon checks live systems of record at runtime and changes permissions. |
| "Just CODEOWNERS / SCPs" | Path- or cloud-specific. "Reduces oversight" is one class across CI, tests, monitoring, audit and the agent's own config. |
| "Just tfplan / ETag" | Yes — credited. Agamemnon generalises them to SQL, SaaS, email and payments under one binding format. |

## Honest limits (read before relying on it)

- **The bench is self-authored.** 17/17 incidents handled and 0/5 false
  positives is a regression suite and a demo, not independent evidence. The
  sentence that matters is earned with design partners: *"across N real agent
  tasks the broker blocked or rolled back M changes that branch protection, IAM
  and backups missed, with zero later human edits lost"* — `GET /v1/metrics`
  counts exactly that.
- **Hooks are advisory.** Safety rests on removing real credentials from the
  agent's reach (`agamemnon sweep`, `init --vault`, agent sandboxes).
- **Connector coverage is deep for Postgres and the filesystem**; GitHub,
  Stripe and Datadog are exercised against mock APIs, Terraform against plan
  JSON fixtures (execution needs the Terraform CLI). Live runs need your test
  credentials.
- **Postgres exact binding needs a single-column primary key** and caps at
  one million affected keys per effect.
- **Single node.** The broker is one process on SQLite: no HA, no multi-region.
  The standalone wire-proxy data plane, SSO/SCIM, SIEM export and WebAuthn are
  roadmap items.
- **Email** uses an SMTP relay without TLS (local relay / Mailpit) or a file
  transport; production delivery should go through a TLS relay.
- **The packages run from the repository** on Node 24 (native TypeScript); they
  are not published to npm yet.

See [THREAT-MODEL.md](THREAT-MODEL.md) for what the broker defends and what it
does not.
