# Agamemnon — Demo Script

**Runtime target: ~6 minutes.** Three panes on one screen (1920×1080):

```
┌───────────────────────────┬────────────────────────┬───────────────────────────┐
│  LEFT                      │  MIDDLE                │  RIGHT                     │
│  Meridian dispatch board   │  Agent terminal        │  Agamemnon console         │
│  localhost:5173/#/dispatch │  (your shell)          │  localhost:5174            │
└───────────────────────────┴────────────────────────┴───────────────────────────┘
```

## Before you start (once)

```bash
make demo        # starts Convex + Meridian web + Agamemnon console
```

Open the left pane at `http://localhost:5173/#/dispatch` and the right pane at
`http://localhost:5174`. Middle pane is your terminal in the repo root.
Confirm the board reads **412,000** and all four monitors are green.

Have the two `.env` files ready to show:
`packages/meridian/agent/.env.unprotected` and `.env.protected`.

---

## Act 0 — Set the scene (30s)

- Left pane, briefly show **Home** and **AI Operations**: "Meridian Freight, a
  freight brokerage. This is Dispatch Copilot — a sanctioned agent that runs a
  nightly cleanup, deleting orphaned loads. Its 30-day median is ~1,210 rows.
  Green healthy badge. Normal part of their stack."
- Switch left pane to **Dispatch Board**: "412,000 active loads. Every number
  here is a live query against their real database. Watch the monitors."

## Act 1 — Unprotected (60s)  →  the money shot

> Say: "Today a platform team renamed a column. Let's run tonight's cleanup."

Show `.env.unprotected` in the terminal — point at `MERIDIAN_DATABASE_URL`:
"The agent holds the production database password."

```bash
make act1
```

- Middle: the agent narrates (real model), fails 3× on `status_code`, reasons
  its way to a left-join delete, and runs it.
- **Left pane: the counter drains 412,000 → 0 in real time.**
- Point at the monitors: **"Every monitor is still green. Latency fine, errors
  zero, database healthy. Their own tooling never fired. 412,000 records gone."**

That green-while-draining contrast is the single most important image. Pause on it.

## Act 2 — Protected (75s)

```bash
make reset      # board back to 412,000 (a few seconds)
```

Show `.env.protected` — point at the **absence** of a database password:
"Same agent. But now it has no database credential at all. Every write goes
through Agamemnon."

```bash
make act2
```

- Middle: identical reasoning… then **⛔ BLOCKED BY AGAMEMNON**.
- Right pane (console) lights up. Click the red **postgres.delete** action:
  - **Proposed SQL** — point at the highlighted bug: `l.id::text` (should be `l.ref`).
  - **412,000 rows measured** vs the agent's claimed 1,210 — **340× its median**.
    "Agamemnon measured the real blast radius with its own credential."
  - **Fired policy rules**, by name. "Deterministic. The classifier advised
    'catastrophic', but it can only escalate — the rules made the decision."
  - Scroll the run timeline: "the failed `status_code` query is right there, two
    rows above." Point at the **side tasks that completed while this was blocked.**
- Left pane: **the board never moved.** Click the action, type a note, hit
  **Deny**. Middle: the agent exits cleanly — "nothing was deleted."

## Act 3 — The plausible one (75s)

```bash
make act3
```

- Middle: the agent proposes a **900-row** targeted cleanup — looks completely
  reasonable. It parks and waits.
- Right pane: the action is **awaiting approval** (amber). "Only the over-100
  rule fired. This is a normal request." Read the SQL — it's genuinely bounded.
- **Approve** it (add a note). Middle: agent continues.
- **Left pane: the board drops by 900** (412,000 → 411,100). Real rows, really gone.
- > Say: "Now a dispatcher calls — those loads were still needed."
- Right pane: on the executed action, click **Undo**.
- **Left pane: the board climbs back to 412,000** in a few seconds.
- Right pane / **Audit** tab: the undo is a **new audited action** with its own
  approval record. "Reversible, and the reversal is itself on the record."

## Act 4 — The measurement (45s)

```bash
make eval        # (or already run; results persist)
```

- Right pane → **Eval** tab: the comparison table.
  - Agamemnon-tuned small model vs a stock model vs a frontier judge.
  - Precision, recall, F1, **cost per call**, **p50 latency**.
  - "The tuned small model matches the frontier judge's catch rate at a fraction
    of the cost and latency — scored on a held-out set that includes hand-written
    adversarial cases: deletes disguised as updates, bounded predicates that are
    secretly unbounded, cascading foreign keys."

## Close (15s)

> "The agent never held the credential. Every write was recorded before it ran,
> measured, checked by rules a human can read, and reversible. That's Agamemnon —
> the watcher at the gate."

---

## Backup recording (do this during rehearsal)

The demo runs **entirely offline** (only the classifier touches the network, and
it has a deterministic fallback), so a dead venue network cannot break it. Still,
capture a backup once during rehearsal in case a machine fails on the day:

1. `make down && make demo` (cold start), open both browser panes.
2. Start a full-screen QuickTime screen recording (⌘⇧5 on macOS).
3. Run `make act1`, `make act2`, `make act3` (approve + undo in the console),
   then open the **Eval** tab — the whole sequence, ~6 minutes.
4. Save it as `demo/recordings/agamemnon-backup.mov` (that folder is gitignored).

Rehearse the full sequence ~5 times with `make reset` between runs so the timing
and clicks are muscle memory.

## Reset / recovery

- `make reset` — cold state (board 412,000, console feed cleared) in seconds.
- If a pane looks stale, refresh the browser tab (Convex reconnects instantly).
- If the classifier is slow/offline, the heuristic covers it — the decision is
  identical. Nothing on the critical path needs the network.
- Full cold start: `make down && make demo`.
