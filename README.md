# Agamemnon

**The watcher at the gate — and the gate is the write path.**

AI agents are being handed real credentials to real production systems.
Agamemnon sits between the agent and the system it acts on. The agent no longer
holds the production credential; Agamemnon does. Every write becomes a
proposal: recorded atomically, scored for blast radius, checked against
deterministic policy, made reversible by snapshot, and only then executed with
a credential Agamemnon mints for that single action. If something slips
through, undo takes seconds.

**The model advises. The rules decide.** The classifier may only escalate
severity, never reduce it, and the write path never stalls on it.

## Layout

```
packages/agamemnon/   THE PRODUCT — Convex backend, policy engine, adapter,
                      operator console, eval harness
packages/meridian/    THE FICTIONAL CUSTOMER — Meridian Freight: marketing
                      site, dispatch dashboard, Postgres, and Dispatch Copilot
                      (the rogue agent)
demo/                 the beat-by-beat demo script and reset tooling
```

Setup: see [SETUP.md](SETUP.md). Demo script: see `demo/SCRIPT.md` (Phase 6).
