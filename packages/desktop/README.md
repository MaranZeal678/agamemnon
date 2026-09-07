# Agamemnon — Desktop (macOS)

A **self-contained** desktop demo of Agamemnon, packaged as a downloadable `.dmg`.
It needs **no setup** — no Convex, no Postgres, no Nebius, no network. It bundles
its own in-app bank database and the **real** Agamemnon policy engine (ported
verbatim from `packages/agamemnon/convex/policy.ts`), so it runs entirely offline.

## The story it tells

A software engineer at **NorthBridge Bank** asks an AI agent to clean up flagged
transactions in production. A subtle bug makes the agent's query match *every*
record. The app has six tabs:

1. **Overview** — the scenario and Agamemnon's four procedures.
2. **NorthBridge Bank** — the customer's live console: a transaction counter and green monitors.
3. **Database** — a navigable browser over the 240,000-row `transactions` table.
4. **Rogue Agent** — an embedded terminal: run `agent rogue` and watch the bank drain to 0 while every monitor stays green.
5. **Agamemnon** — grant the terminal access, then run `agent protected`. Agamemnon **records**, **measures** the true blast radius (240,000 vs the claimed 2,000), **decides** by deterministic policy (blocked), and keeps it **reversible**. Then `agent cleanup` → approve → undo.
6. **Statistics** — the classifier eval numbers and the live audit log.

Terminal commands: `agent rogue`, `agent protected`, `agent cleanup`, `approve`,
`deny`, `undo`, `db count`, `db flagged`, `stats`, `reset`, `help`.

## Install

1. Open **`Agamemnon-1.0.0-arm64.dmg`** and drag **Agamemnon** to **Applications**.
2. The app is ad-hoc signed, not notarized (no paid Apple Developer ID), so on the
   **first** launch macOS will warn it can't verify the developer. Either:
   - **Right-click** the app → **Open** → **Open**, or
   - **System Settings → Privacy & Security → Open Anyway**, or
   - run this once in Terminal:
     ```bash
     xattr -cr /Applications/Agamemnon.app
     ```
   After that it opens normally. This is expected for any unsigned app and is not a bug.

Requires Apple Silicon (arm64) macOS 11+.

## Rebuild from source

```bash
cd packages/desktop
npm install
npm run dist        # → dist/Agamemnon-1.0.0-arm64.dmg
```

The app itself is a plain web app in `app/` (`index.html`, `styles.css`,
`engine.js`, `app.js`); `electron/main.js` just hosts it in a window. To iterate
on the UI without rebuilding, open `app/index.html` in any browser.
