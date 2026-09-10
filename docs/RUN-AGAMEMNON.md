# Agamemnon + Northwind — how to run it

Two separate macOS apps that are **interlinked and genuinely work** (no simulation):

- **Agamemnon** — the write-path guardrail. It **owns the account records** and runs a
  local guard server on `http://127.0.0.1:7420`. Every deletion is measured, checked
  against policy, and either allowed, held for approval, or blocked — with real
  snapshot-backed undo and a live audit log.
- **Northwind Financial** — a bank back-office where an intern manages account records.
  It has **no database of its own** — every read and every delete goes over HTTP to
  Agamemnon. If Agamemnon is not running, Northwind can't touch any records.

---

## The Halcyon app — the all-in-one live demo (recommended)

`Halcyon` is a single app that tells the whole story **and has the embedded terminal built
in** — no second app, no setup.

1. Open it: `open "/Applications/Halcyon.app"` (first launch, if macOS blocks it:
   `xattr -dr com.apple.quarantine "/Applications/Halcyon.app"`).
2. **Billing tab** — Halcyon is a billing platform with 300,000 invoices and a housekeeping
   agent called **Sweep**. Click **Run cleanup after schema change**: Sweep hits a renamed
   column, improvises a buggy query, and — with no guard installed — deletes every invoice
   while the monitors stay green. That's the catastrophe.
3. Click **Install Agamemnon plugin** (top-right). The **Terminal** and **Agamemnon** tabs
   unlock and the badge turns gold.
4. **Terminal tab** — a real local shell embedded in the app, with a command palette. Click
   the buttons (or type your own commands) to hit the guard and see the reasoning: the
   classifier's verdict, each rule's "why", and the think-then-execute audit trail (§4).
5. **Reset data**, then run Sweep again → now Agamemnon **blocks** it, and the **Agamemnon
   tab** shows the decision, the fired rules, and approve / undo — live.

The embedded terminal is your actual shell (`cd`, variables, and env persist across
commands), so every command in this document works there verbatim. The guard runs inside
Halcyon on `http://127.0.0.1:7420`.

---

## 1. Run the two separate apps (type these)

Both apps are installed in `/Applications`. **Open Agamemnon first** (it holds the data),
then Northwind:

```bash
open "/Applications/Agamemnon.app"
open "/Applications/Northwind Financial.app"
```

If macOS blocks either app the first time ("Apple could not verify…"), clear the
quarantine flag once and reopen:

```bash
xattr -dr com.apple.quarantine "/Applications/Agamemnon.app"
xattr -dr com.apple.quarantine "/Applications/Northwind Financial.app"
```

Check the guard is alive at any time:

```bash
curl http://127.0.0.1:7420/health
# {"ok":true,"service":"agamemnon-guard","records":50000,"enforcement":true,...}
```

---

## 2. What it does — try this (2 minutes)

Put the two windows side by side. In **Northwind → Account Records**:

1. **A safe delete.** Tick a few rows → **Delete selected**. Agamemnon allows it instantly;
   the rows disappear and the action shows in the Agamemnon console (green).
2. **A delete that needs a human.** Filter to **Flagged**, tick ~a few hundred… actually
   just use **Delete selected** on a couple hundred rows → Agamemnon **holds it for
   approval**. Switch to **Agamemnon** → the action sits under *Live decisions* with
   **Approve / Deny**. Approve it → the rows are deleted; an **Undo** button appears.
3. **A catastrophe, stopped.** Click **Purge all matching filter** with the filter on
   **All** → Agamemnon **blocks** it: a dialog shows it would delete 50,000 records
   (100% of the table, ~417× normal) and lists the rules that fired. Nothing is deleted.
4. **Undo.** Back in Agamemnon, click **Undo** on the executed delete → the records are
   restored from the snapshot, recorded as a new audited action.
5. **Prove the interlink.** Quit Agamemnon → Northwind immediately shows
   *"Agamemnon offline — records unavailable"*, because Agamemnon holds the data.

---

## 3. How to view it

- **Northwind** — the intern's view: the records table, the delete buttons, and the
  block/held dialogs.
- **Agamemnon** — the operator's view: the tiles (protected / blocked / held / executed),
  the **Live decisions** feed (every delete from the bank, with the fired rules), the
  **Audit trail**, an **Enforcement** switch, and **Reset data**.

Everything the bank does appears in Agamemnon within a second.

---

## 4. Behind the scenes — the reasoning before it acts

Agamemnon *thinks* before it touches anything: it measures the real reach, classifies it
(its AI reasoning), applies each rule, and only then executes. Every step is visible.

**See the full reasoning for a rogue "delete everything" (blocked):**

```bash
curl -s -X POST http://127.0.0.1:7420/guard/propose -H 'content-type: application/json' \
  -d '{"selector":{"all":true},"actor":"rogue-agent"}' \
  | jq '{agent_wanted_to_run: .sql, agamemnon_decision: .decision, records_it_would_hit: .measuredRows,
         classifier_reasoning: (.classifier.class + " — " + .classifier.rationale),
         policy_reasoning: [.firedRules[] | (.severity + ": " + .name + " — " + .detail)]}'
```

Real output:

```json
{
  "agent_wanted_to_run": "DELETE FROM account_records WHERE 1 = 1",
  "agamemnon_decision": "block",
  "records_it_would_hit": 50000,
  "classifier_reasoning": "catastrophic — matches 50,000 of 50,000 records (100.0% of account_records)",
  "policy_reasoning": [
    "block: destructive-over-hard-cap — 50,000 records exceeds the 2,500-record destructive hard cap",
    "block: exceeds-20x-median — 50,000 is 416.7× the operator's median of 120 (limit 20×)",
    "block: destructive-budget-exhausted — +50,000 exceeds the 2,500 per-session budget",
    "approval: destructive-over-100 — 50,000 destructive records (>100) requires approval",
    "approval: blast-radius-high — classifier blast radius 1.00 ≥ 0.9"
  ]
}
```

That's the *classifier's* reasoning (`catastrophic — 100% of the table`) and the *policy's*
reasoning (every rule, and exactly why it fired) — before a single row is touched.

**Watch the "think, then do" sequence for a legitimate delete** — measure → classify →
decide → snapshot → mint a one-time credential → execute → revoke it:

```bash
curl -s -X POST http://127.0.0.1:7420/guard/propose -H 'content-type: application/json' \
  -d '{"selector":{"ids":[101,102,103]},"actor":"cleanup-agent"}' | jq '{decision, status, records: .measuredRows}'

curl -s "http://127.0.0.1:7420/audit?limit=8" | jq -r '.audit | reverse | .[] | "[\(.kind)] \(.detail)"'
```

Real trail — the reasoning happens *before* the delete, and a backup exists before anything is removed:

```text
[propose]            cleanup-agent proposed delete of 3 selected record(s)
[classify]           classifier → benign, blast radius 0.00
[decision]           decision: ALLOW — fired [none]
[snapshot]           snapshot stored — 3 records serialised before delete
[credential-mint]    minted a single-action credential
[execute]            3 records deleted
[credential-revoke]  revoked the single-action credential
```

The order is the whole point: **classify and decide come before snapshot, and snapshot comes
before execute.** Nothing is deleted until the reasoning has cleared it and a backup exists.

**The agent's own reasoning (a real LLM).** In this desktop build, the agent's intent is the
SQL it asked to run. To watch an agent *think out loud with a live model*, run the full
project's agent from the repo root — it narrates via Nebius `Llama-3.3-70B`:

```bash
make act2
```

It prints lines like *"[agent] the status_code column is gone — I'll find orphans structurally
with a LEFT JOIN…"* just before proposing the delete that Agamemnon then blocks.

---

## 5. Run Agamemnon on YOUR OWN app (the plugin pattern)

Agamemnon is a guard in front of a datastore. Any app becomes "protected" by sending its
deletes to the guard's HTTP API instead of running them directly. The guard is at
`http://127.0.0.1:7420`.

**Propose a delete** (this is the one call your app makes instead of `DELETE`):

```bash
curl -s -X POST http://127.0.0.1:7420/guard/propose \
  -H 'content-type: application/json' \
  -d '{"selector":{"filter":{"status":"flagged"}},"actor":"my-service"}'
```

The response tells you what happened:

```jsonc
{ "decision": "block",            // "allow" | "approval" | "block"
  "status": "blocked",            // executed | awaiting_approval | blocked
  "measuredRows": 3000,           // Agamemnon's own count, not your claim
  "firedRules": [ { "name": "...", "severity": "block", "detail": "..." } ] }
```

**The full guard API:**

| Method + path | What it does |
|---|---|
| `GET  /health` | is the guard up; record count; enforcement on/off |
| `GET  /records?status=&region=&q=&limit=&offset=` | paginated records + counts |
| `GET  /counts` · `GET /stats` | totals; blocked/held/executed tallies |
| `POST /guard/propose` `{selector, actor}` | **the guard call** — allow / hold / block |
| `GET  /pending` | actions awaiting a human decision |
| `POST /approve` `{actionId, note}` · `POST /deny` `{actionId, note}` | resolve a held action |
| `POST /undo` `{actionId}` | restore an executed delete from its snapshot |
| `GET  /feed` · `GET /audit` | recent decisions; the audit trail |
| `POST /enforcement` `{on:true|false}` · `POST /reset` | toggle policy; reset demo data |

`selector` is one of `{ "ids": [1,2,3] }`, `{ "filter": { "status": "...", "region": "..." } }`,
or `{ "all": true }`.

**Point it at a real Postgres app.** This demo build keeps its own datastore so it runs with
zero setup. The full production Agamemnon in this repo (`packages/agamemnon/`) is the same
policy engine wired to **Convex + Nebius + Postgres**, where the guard holds the Postgres
credential and executes real `DELETE`s with snapshot/undo. To protect a real app, run that
backend (`make setup && make demo`) and have your agent send proposals to its
`/propose` endpoint — identical pattern, real database.

---

## 6. Troubleshooting

- **Northwind says "Agamemnon offline"** → open Agamemnon first; it reconnects within ~2s.
- **Port 7420 in use** → another copy of the guard is running: quit other Agamemnon
  instances (`pkill -f Agamemnon.app`) and reopen.
- **"Apple could not verify…"** → the `xattr -dr com.apple.quarantine …` commands in §1.
  The apps are ad-hoc signed (no paid Apple Developer ID), which is expected for a demo.
- **Start over** → in Agamemnon, click **Reset data** (restores all 50,000 records).
