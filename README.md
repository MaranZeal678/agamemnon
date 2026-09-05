# Agamemnon

**The watcher at the gate — and the gate is the write path.**

AI agents are being handed real credentials to real production systems. In 2026,
researchers documented at least nine cases where an autonomous agent deleted a
company's live data on its own — and because the agent was authorised, no
monitoring tool flagged anything while it happened.

Agamemnon sits between the agent and the system it acts on. **The agent no longer
holds the production credential; Agamemnon does.** Every write becomes a proposal:
recorded atomically, scored for blast radius, checked against deterministic
policy, made reversible by snapshot, and only then executed with a credential
Agamemnon mints for that single action. If something slips through, undo takes
seconds.

> **The model advises. The rules decide.** The classifier may only *escalate*
> severity, never reduce it — and the write path never stalls on it.

## Built on Convex and Nebius

- **Convex** is the spine. The entire product runs on a Convex deployment: the
  atomic proposal + audit ingest, the deterministic policy engine, the durable
  workflow (classify → decide → park for a human → snapshot → execute), Convex
  file storage for undo snapshots, and the operator console driven by Convex
  **reactive queries** (no polling, no websocket code of our own). It runs as an
  **anonymous local Convex deployment**, so the whole demo works offline.
- **Nebius Token Factory** (OpenAI-compatible endpoint) provides the models:
  the blast-radius **classifier** (`Qwen/Qwen3-30B-A3B-Instruct-2507`, strict
  JSON, hard-timeout with a deterministic heuristic fallback), the rogue agent's
  **reasoning narration** (`Llama-3.3-70B-Instruct` — genuinely a model talking),
  the eval **dataset generation**, and the eval comparison against a **stock**
  model (`gemma-3-27b-it`) and a **frontier judge** (`DeepSeek-V4-Pro`).

## The four acts

1. **Unprotected.** Run the agent with Agamemnon off. It hits a renamed column,
   improvises a left-join delete with a subtle bug, and deletes 412,000 shipment
   records. The dispatch board drains 412,000 → 0 live — while every monitor
   stays green.
2. **Protected.** Same agent, no database password in its environment. Agamemnon
   blocks the delete in ~2s: the proposal, the measured 412,000 rows vs the
   agent's own 1,210 median (340×), the fired policy rules, the classifier
   verdict. The board never moves. Deny it in the browser; the agent exits clean.
3. **The plausible one.** A 900-row delete that looks reasonable. Approve it —
   the rows really disappear and the board drops by 900. Then click Undo: the
   rows come back in seconds, recorded as a new audited action.
4. **The measurement.** An eval page scoring the blast-radius classifier against
   a held-out set: precision, recall, cost/call and p50 latency, next to a stock
   model and a frontier judge.

## Layout

```
packages/agamemnon/   THE PRODUCT
  convex/    schema, atomic ingest, pure policy engine, Nebius classifier,
             durable workflow, snapshot/delete/undo against Postgres
  adapter/   the shim an agent imports (no DB credential ever)
  console/   operator console (React + Convex reactive queries)
  eval/      200-case labelled dataset + scoring harness
packages/meridian/    THE FICTIONAL CUSTOMER — Meridian Freight
  web/       marketing site + live dispatch board + monitoring + AI-ops page
  db/        schema.sql, seed.sql (412k loads), the breaking migration
  agent/     Dispatch Copilot — the rogue agent (deterministic bug, real narration)
demo/        SCRIPT.md (beat-by-beat), up/down/reset
```

## Run it

See [SETUP.md](SETUP.md) for first-time setup. Then:

```bash
make demo     # start Convex + Meridian web + Agamemnon console
make act1     # unprotected: board drains to 0, monitors stay green
make act2     # protected: Agamemnon blocks the 412k delete
make act3     # plausible: 900-row delete parks for approval → approve → undo
make eval     # score the classifier → console Eval tab
make reset    # cold demo state in seconds
```

Nothing on the demo critical path needs the network except the classifier, which
is optional by design (the deterministic heuristic covers it). Real execution
against real Postgres throughout — no mocked deletes, no simulated undo.
