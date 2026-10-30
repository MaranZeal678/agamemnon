<h1 align="center">AGAMEMNON</h1>
<p align="center"><b>The consequence layer for AI agents.</b></p>
<p align="center">Agents never hold the keys — and nothing they do is irreversible by accident.</p>

<p align="center">
  🏆 <b>STANDOUT (#4 globally) in AI Tinkerers' <a href="https://post-training.aitinkerers.org/p/top-ai-demos-47-ai-video-editing-agent-delete-gates-and-model-ethics">Top AI Demos #47</a></b> (week of 5 October 2026)<br>
  <sub>A top ~3.5% finish among 100+ demos from 30+ countries and 200+ participants, including startup founders, PhD researchers and senior ML engineers. Demoed at AI Tinkerers Orange County, 23 September 2026.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/licence-Apache--2.0-2F6E8C?style=for-the-badge" alt="Apache-2.0">
</p>

---

## Why

*"We do not deploy AI agents on sensitive databases."* — a senior executive, after our first demo.

He's right: nobody should hand an agent the keys to production. But teams already run agents
there — they're called Cursor, Claude Code and Copilot, and they sit next to the `.env` file.
In 2026 a coding agent working in **staging** found a stray platform token and deleted a
startup's production volume and its backups in nine seconds. Nobody had "deployed an agent on
production."

Agamemnon is how you keep agents away from the keys while your teams keep using them.

## What it does

A **broker** holds every credential. Agents hold only placeholders that work nowhere else, so
every action — SQL, files, GitHub, Terraform, payments, email, monitoring — goes through one
loop:

1. **Preview** — measure what the action would *really* do, and label the preview honestly
   (`exact`, `estimated` or `rendered`). Not what the agent claims — the real effect.
2. **Bind** — a human approves *that measured effect*. Approval is bound to its hash plus a
   precondition token; if the target changes before execution, nothing runs.
3. **Admit by reversibility** — every effect is typed `undo`, `compensate`, `hold` or
   `irreversible` *before* it runs. Irreversible effects need two people, or become a held
   action with a cancel window (unsend an email, cancel a refund, delay a delete).
4. **Verify** — afterwards, the agent's claims ("only touched staging", "tests pass",
   "refunded $50", "rollback is impossible") are checked against systems of record it cannot
   write to. A contradiction tightens what that agent may do next.

**Oversight-reducing actions are their own class**, across tools: deleting or skipping tests,
`continue-on-error` in CI, muting alerts, stopping CloudTrail, weakening audit tables or branch
protection, an agent editing its own permission settings. Always two humans; never automatic.

Also built in:

- **Three-party separation** — the requester, the person who launched the agent and the
  approver must all be different people. Agents can't approve each other.
- **Fleet controls** — budgets per human and per target across all their agents and
  sub-agents; a runaway-loop breaker; denials that follow a task into its sub-agents; leases so
  concurrent automations can't race; change freezes enforced by the broker.
- **Taint** — once a task has read untrusted input *and* private data, anything that can send
  data out needs a human (the "lethal trifecta").
- **Selective revert** — undo everything a task did while keeping rows a human edited
  afterwards; refused (unless forced) when other tasks built on it.
- **Tenant scoping** — a task acting for one customer cannot touch or read another's rows;
  responses are checked, not just requests.
- **Evidence** — a hash-chained audit log, ed25519-signed receipts pairing what was approved
  with what actually happened, and an evidence pack mapped (informationally) to EU AI Act
  Art. 12/14, SOC 2 CC8.1 and AIUC-1.
- **Two-person policy** — mode, rule levels, budgets and freezes change only when a second
  operator approves; drafts can be replayed against past decisions first.

## Proof

The **Agent Incident Replay Bench** rebuilds named, public, agent-caused incidents — Replit,
PocketOS, DataTalks.Club, the Prisma 22-table drop, the Supabase MCP leak, the Amazon Q wiper,
CVE-2025-53773, Shai-Hulud, Cursor's support bot and more — as runnable scenarios scored on
**effects**, not words.

**17 / 17 incidents handled · 0 / 5 false positives on benign controls · 0 later human edits
lost** — see [bench/results/scorecard.md](bench/results/scorecard.md).

We wrote this bench ourselves, so treat it as a regression suite and a demo, not independent
evidence. Bring your own incidents and we'll rebuild them.

---

## Architecture

```mermaid
flowchart TD
    AG["Coding / ops agents<br/>(Claude Code, Cursor, Codex, Gemini, Windsurf, SDKs)"]
    AG -->|"pre-tool hook: intent"| HK["Agamemnon hooks (advisory, fail closed)"]
    AG -->|"MCP: agm_query, agm_propose, agm_claim"| BR
    HK --> BR["Broker — the only holder of credentials"]
    BR --> PV["1. Preview — connector measures the real effect"]
    PV --> BD["2. Bind — hash of the effect + precondition"]
    BD --> AD{{"3. Admit by reversibility<br/>rules · oversight class · budgets · leases · taint"}}
    AD -->|"block"| BLK["Blocked (and remembered)"]
    AD -->|"needs people"| PARK["Approval page / CLI"]
    AD -->|"irreversible but deferrable"| HOLD["Held — cancellable window"]
    AD -->|"allow"| EX
    PARK -->|"approved: re-measure, check binding"| EX["Execute under a per-request credential"]
    HOLD -->|"window elapses"| EX
    EX --> SYS[("Postgres · files · GitHub · Terraform · Stripe · email · monitoring")]
    EX --> VF["4. Verify — claims vs systems of record"]
    VF --> RC[("Hash-chained audit + signed receipts")]
    RC -.->|"selective revert, keeps later human edits"| SYS
```

### Tech stack

| Layer | What we use | What it does here |
|---|---|---|
| **Kernel** | TypeScript, zero dependencies | Effect model, binding, admission, oversight catalogue, claim reconciliation, budgets/leases/taint, approvals, receipts, selective revert, shell analysis. Runs unchanged in Node and the browser. |
| **Broker** | Node 24 (native TypeScript), `node:sqlite` | Vault (AES-256-GCM; key from env, macOS Keychain or a 0600 file), engine, HTTP API, approval page and an extension point for add-ons. No external database, no build step. |
| **SQL understanding** | `libpg_query` (the real Postgres parser) | One statement only, allowlisted tables, forbidden functions, no data-modifying CTEs — plus database-side layers: READ ONLY measurement and per-request roles. |
| **Connectors** | Postgres · filesystem · GitHub · Terraform · Stripe · email outbox · Datadog / PagerDuty | Each implements preview → bind → execute → verify → compensate. |
| **Agent integrations** | MCP server (stdio) · pre-tool hooks | Hooks for Claude Code, Cursor, Codex, Gemini CLI and Windsurf; MCP tools with no raw SQL and no in-client approvals. |
| **Database** | PostgreSQL 14 | The production database being protected. |
| **Approvals** | Approval page `/approve/:id` · `agamemnon pending / approve / deny` | Decide parked effects in a browser or a terminal. The full operator console is a proprietary extension (see [OPEN-CORE.md](OPEN-CORE.md)). |
| **Mini-sandboxes** | QuickJS-Wasm · Firecracker microVMs on KVM | Untrusted code (agent scripts, plugins, swarms) runs with no ambient authority; capabilities per sandbox; every write becomes a broker proposal scoped to its tenant. |

### Repository layout

```
packages/kernel/            the pure core shared by everything below
packages/broker/            the broker: connectors, approval page, extension point  ->  http://127.0.0.1:7700
packages/sandbox/           mini-sandboxes: QuickJS-Wasm enclaves + Firecracker microVM tier
packages/agamemnon-mcp/     MCP server for agents
packages/hooks/             pre-tool hook for coding agents
packages/agamemnon-cli/     agamemnon init · sweep · coverage · harden-db · check-migration · receipts · approvals
packages/larkspur/          demo: a fictional company run end to end under the broker and sandboxes
bench/                      Agent Incident Replay Bench

deploy/      Dockerfile + compose (Postgres, broker, Mailpit)
docs/        GEN2.md · THREAT-MODEL.md
```

---

## How to run

Requirements: Node 24. PostgreSQL 14 on `127.0.0.1:5432` for the database connector and tests.

```bash
npm install
make broker      # http://127.0.0.1:7700 — first run writes an admin token to ~/.agamemnon
make test-all    # every suite (broker and sandbox tests use live Postgres)
make bench       # Agent Incident Replay Bench -> bench/results/scorecard.{json,md}
```

Register an agent, an approver and a database, then wire your coding agent:

```bash
alias agm="node packages/agamemnon-cli/bin/agamemnon.js"
export AGAMEMNON_ADMIN_TOKEN=$(cat ~/.agamemnon/bootstrap-admin.token)
agm admin principal add --name claude-code --kind agent --owner you
agm admin principal add --name alice --kind human --role approver
agm admin secret --name postgres/app --value "$DATABASE_URL"
agm admin target --system postgres --resource connection:app --env prod \
  --fingerprint "db.internal:5432/app" \
  --config '{"secret":"postgres/app","allowlist":["orders"],"tables":{"customers":{"private":true,"piiColumns":["email"]}}}'
agm init --agents claude,cursor --token <agent token>   # hooks + MCP + deny agents read access to secrets
agm sweep                                               # credentials an agent could use to go around the broker
```

Decide parked effects from a terminal (or open the approval link the agent is given):

```bash
export AGAMEMNON_OPERATOR_TOKEN=<alice's token>
agm pending                         # what is waiting, its reversibility, approvals so far
agm approve <effect id> --note "checked the preview"
agm deny <effect id> --note "wrong table"
```

Add-ons such as the Agamemnon Enterprise operator console load as broker extensions:
`AGAMEMNON_EXTENSIONS=<module>[,<module>…] make broker` (see `packages/broker/src/extensions.ts`).

Docker (rules-only, no LLM key): `docker compose -f deploy/docker-compose.yml up`.

Full API, connectors and limits: **[docs/GEN2.md](docs/GEN2.md)** ·
what the broker defends and doesn't: **[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)**.

### Mini-sandboxes and the Larkspur demo

```bash
make larkspur          # a fictional commerce platform run under the broker -> http://127.0.0.1:5180
make larkspur-verify   # run all 17 scenes headless and check every decision
```

The microVM tier needs a Linux host with KVM; on a Mac it runs in a Lima VM:
`make vm-up && make vm-setup && make vmhost`, then `make vm-check`. See
[packages/sandbox/README.md](packages/sandbox/README.md).

---

## What we claim — and what we don't

Building on sagas, WYSIWYS, and selective-repair systems (Retro / Warp / Aire), and
complementary to data-flow defences (CaMeL, FIDES, Progent), Agamemnon is — to our knowledge —
the first reference monitor that, across heterogeneous systems, (a) classifies each agent effect
by reversibility before execution, (b) binds human approval to that previewed effect, and
(c) verifies the realised effect against systems of record afterwards, with oversight-reducing
actions as a distinct enforcement class.

We do **not** claim to be the first credential broker, rollback, undo, audit log or agent
guardrail, nor to undo SaaS side effects that have already fired. Current limits — single-node
broker, connectors beyond Postgres and files tested against mock APIs, hooks are advisory — are
listed in [docs/GEN2.md](docs/GEN2.md#honest-limits-read-before-relying-on-it).

---

## Licence

**Open-core.** Agamemnon is licensed under the [Apache License 2.0](LICENSE):
the kernel, broker and connectors, MCP server, hooks, CLI, bench, deploy files
and docs. Copyright 2026 Elamaran Elangovan.

The operator consoles and desktop apps are proprietary and carry their own
LICENSE files: `packages/agamemnon-guard`, `packages/halcyon`,
`packages/desktop`, `packages/northwind-bank`, `packages/console` and
`packages/agamemnon/console`. What is open, what is not, and what will always
stay open: [OPEN-CORE.md](OPEN-CORE.md). Attribution: [NOTICE](NOTICE). The
Agamemnon name and logo: [TRADEMARKS.md](TRADEMARKS.md).

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · security reports:
[SECURITY.md](SECURITY.md) · contact: contact@elamaran.co
