# Agamemnon Console

A Sentry-style operator dashboard for Agamemnon: **Overview**, **Live decisions**,
**Database**, a working **Terminal**, **Integrations** (connect GitHub), **Policy**,
**Audit log**, and **Account**.

It's a static web app that talks to a running Agamemnon guard over HTTP.

## Run it

Start any Agamemnon guard on `:7420` (e.g. the one bundled in `packages/agamemnon-guard`
or `packages/halcyon`), then serve this folder:

```bash
# 1) a guard on :7420  (or open the Agamemnon / Halcyon desktop app)
# 2) serve the console
cd packages/console/app && python3 -m http.server 8904
# open http://127.0.0.1:8904   (or ?guard=7431 to point at another port)
```

## What works

- **Terminal** — runs real commands against the guard: `health`, `stats`,
  `guard delete all`, `guard delete <status>`, `guard delete ids <a,b>`,
  `approve <id>`, `deny <id>`, `undo <id>`, `enforcement on|off`, `reset`.
- **Integrations → GitHub** — paste a fine-grained read-only token; it's validated
  against `api.github.com`, your account + repos are listed, and each repo has a
  "guard writes" toggle. The token is stored only in your browser and sent only to
  github.com.
- **Live decisions / Database / Audit / Policy** — reactive views over the guard.

Point it at a different guard port with `?guard=<port>`.
