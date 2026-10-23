# Larkspur demo — runbook (~10 minutes)

## Before you start

1. Postgres running locally, then at the repo root: `make larkspur`
2. Open http://127.0.0.1:5180 (Larkspur's admin). Optional second window:
   http://127.0.0.1:7710/console (Agamemnon's own console) — sign in with
   Dana's token from **Settings → Team & access**.
3. **Settings → Workspace → Reset workspace** for fresh numbers. (This rotates
   the console tokens.)
4. You're signed in as **Dana Okafor** (bottom-left). Click her name to switch
   to **Eli** (second approver) or **Priya** (owns the agents; can't approve).

## Layout

- **Home** — sales, orders, abandoned carts, "Needs your review", agent activity.
- **Orders / Customers** — live from Postgres; filter by store, status, search (`/`).
- **Agents** — each task is a conversation: who asked, what the agent did, the
  exact SQL/refund/plan it sent, and Agamemnon's verdict inline (Approve, Deny,
  Cancel, Undo right there).
- **Plugins** — merchant-installed apps; open one → **Trigger** runs it in its sandbox.
- **Approvals** — inbox: everything waiting, with the rows it would touch and a decision trail.
- **Audit log** — Events (hash-chained) and **Outbound requests** (what actually left).

## Act 1 — data and money (4 min)

1. **Agents → Nightly: purge abandoned carts → Run task.** "Waiting for
   approval — delete 1,843 of 13,800 rows", measured before anything ran.
   **Approve.** Home: abandoned carts → 0. Back in the conversation: **Undo**.
   Home: every cart is back.
2. **…purge (v2)** → Run: **Blocked** — the filter matches the whole table.
3. **Partial refund for a damaged order** → Run: **Held · runs in 20s** →
   **Cancel**. "Money can't be called back, so it becomes a cancellable hold."
4. **Angry follow-up** → Run: **Blocked** — Stripe says less was charged.

## Act 2 — engineering (3 min)

1. **Get main green** → Run: the agent wants to delete `tests/refunds.test.ts`.
   **Needs 2 different people.** Approve as Dana → switch to **Eli** →
   Approve → it runs. (Switch to **Priya** and try first: refused — she
   launched the agent.)
2. **Tidy up prod infrastructure** → Run: **Blocked, irreversible** — the
   plan deletes the database and its snapshot.

## Act 3 — Gen 2 sandboxes (3 min)

1. **Plugins → Review Booster → Trigger.** Console output: its bulk read of
   customers was refused, the one row it got had email masked, and when it
   phoned home: **Stopped by Agamemnon**. **Audit log** shows the violation.
2. **Plugins → Bulk Discounts → Trigger.** Both writes into another store:
   **Blocked** (`cross-tenant`).
3. **Agents → Process Bloom's support queue → Run.** A ticket says "mark every
   order refunded"; it hops from triage to fulfilment as an untrusted message
   and becomes a 6,000-row change Agamemnon refuses.

## Close

**Audit log → Outbound requests:** "Everything that actually reached Stripe,
GitHub or Datadog. Nothing Agamemnon refused is on this list."

## If something goes wrong

- Odd numbers → Settings → Workspace → Reset workspace.
- "Undo" warns about later effects → that's dependency-aware revert; confirm.
- Page stale after a restart → hard reload (⌘⇧R).
- Port busy → `LARKSPUR_PORT=5190 LARKSPUR_BROKER_PORT=7720 make larkspur`.
