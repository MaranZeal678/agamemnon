# SETUP

One machine, local-first. Verified against this machine on 2026-09-05:

| Requirement | Status |
|---|---|
| Node | v25.9.0 ✓ (anything ≥ 20 works; no change needed) |
| Postgres | Homebrew PostgreSQL 14.20 running on `127.0.0.1:5432` ✓ |
| Docker | **Not used.** Decision: run on the existing Homebrew Postgres instead of Docker (Docker isn't installed and 5432 is already taken). `make reset` still cold-resets in seconds. |
| Nebius | Token Factory key required (see step 1) |
| Convex | You authenticate yourself in Phase 1 (see step 4) |

## 1. Secrets — do this yourself, once

```bash
cp .env.example .env
```

Then open `.env` and paste your Nebius key into `NEBIUS_API_KEY=`.
Do not paste the key into chat, a terminal command, or anywhere else.
`.env` is gitignored; nothing in this repo ever prints or commits it.

> **Turn on Zero Data Retention for your Nebius org.** Token Factory keeps
> prompts and outputs by default (to speed up inference), and public endpoints
> are routed globally. Agamemnon already sends the classifier structured facts
> only — table name, row counts, and the predicate's *shape* with every literal
> replaced by `$1, $2, …` — never row values or the agent's prose. Enabling ZDR
> (org setting) and a region-pinned dedicated endpoint closes the rest. With
> `CLASSIFIER_ENABLED=false` nothing is sent anywhere; the deterministic
> heuristic decides alone.

## 2. Database credentials — generated, not chosen

```bash
make gen-creds   # writes machine-generated passwords into .env
make setup       # creates the meridian database + roles on your local PG14
```

Two roles are created:

- `meridian_app` — Meridian Freight's own credential. The **unprotected** agent
  (Act 1) holds this. It can delete anything, which is the point.
- `agamemnon_svc` — the credential **only Agamemnon holds**. In Acts 2–3 it is
  set as a Convex environment variable; the agent's env has no DB password at all.
  It is deliberately narrow: `SELECT, INSERT, DELETE` on the allowlisted tables
  only (no `TRUNCATE`, no other tables), plus `CREATEROLE`. Every execution runs
  under a **per-request role** minted inside the transaction with exactly the
  verbs that action needs, then revoked and dropped before commit.

`make gen-creds` also generates the **principal tokens**: the agent's own bearer
token (`AGAMEMNON_AGENT_TOKEN`, written into the protected agent env) and one
token per console operator (`alice`, `bob` — approvers; `maran` — admin and the
agent's owner, so `maran` can never approve the agent's requests). `make
provision` sends only their SHA-256 hashes to Convex. Sign in to the console by
pasting an operator token.

## 3. Seed the demo world

```bash
make seed        # 412,000 loads, ~410,800 bookings (~1,200 genuine orphans),
                 # 30 days of agent run history (median ≈ 1,210 rows/night),
                 # then applies the migration that renames status_code → status
```

Seeding uses `generate_series` and takes seconds.

## 4. Convex — you authenticate, never me

When Phase 1 reaches the Convex step you will be asked to run, in a separate
terminal, from `packages/agamemnon/`:

```bash
npx convex dev
```

Log in via the browser prompt yourself. Leave it running — it pushes functions
and serves the deployment. Your Convex credentials are never read, stored, or
handled by anything in this repo. (A local — non-cloud — dev deployment will be
preferred if the workflow component supports it, so the demo path works offline;
you'll be told which mode you ended up with.)

## 5. Day-to-day

```bash
make reset       # cold demo state in <10s: restores rows, clears runs/queues
make demo        # starts Meridian web + dispatch dashboard + Agamemnon console
make eval        # runs the classifier eval harness (Phase 5)
```

## Demo screen

Layouts are sized for **1920×1080** (projector), three panes:
Meridian dispatch dashboard (left), agent terminal (middle), Agamemnon console
(right). Console type is sized to read from ten metres.

## Going live later (decided: local for now)

Nothing on the demo path depends on being deployed. If it needs to go public
later: Meridian web and the Agamemnon console are plain Vite apps (static
deploy anywhere), Convex deploys with `npx convex deploy`, and the only real
work is moving the Meridian Postgres to a host and updating the two
`*_DATABASE_URL` values. All URLs are env-driven for this reason.
