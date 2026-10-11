# Agamemnon broker — threat model

The broker holds every credential an agent would otherwise hold. That makes it
the most valuable target in the system and a single point of compromise and of
availability. This document says what it defends, what it does not, and how it
protects itself. It is written to be argued with: if a control here is weaker
than stated, that is a bug.

## Assets

| Asset | Where it lives | Protection |
|---|---|---|
| Downstream credentials (DB URLs, GitHub / Stripe / Datadog tokens) | Vault table in `broker.db` | AES-256-GCM per secret, secret name as AAD; master key from `AGAMEMNON_MASTER_KEY` (KMS / secret store), macOS Keychain, or a 0600 file (fallback, reported in `/health`) |
| Receipt-signing key (ed25519) | Vault | Same as above; public key published with every receipt |
| Audit chain | `audit` table | SHA-256 hash chain; `/health` and the console verify it continuously |
| Principal tokens | Only their SHA-256 hashes are stored | Shown once at creation; revocable |
| Before-images (for undo / revert) | `writes` table | Stored with the effect; PII exposure is bounded by the broker host's protection (see limits) |

## Principals and separation

- **Agents** authenticate with bearer tokens; their identity, owner and task
  lineage come from the broker's records, never from request bodies.
- **Operators** (`admin`, `approver`, `auditor`) approve, deny, reverse and audit.
  Agents cannot reach operator endpoints; operators cannot propose effects.
- **Three-party separation:** requester ≠ approver ≠ the human who launched the
  agent. Approvals from agents count as none. Oversight-reducing and
  irreversible effects need two distinct humans.
- **Policy is two-person:** mode, levels, budgets, freezes and canary settings
  change only when a second operator approves the requester's change.
- **Delegation chain:** every effect records `rootOwner → agent → sub-agent`;
  sub-tasks inherit the root owner, the taint and the tenant scope and can never
  widen the tenant.

## Attacks and responses

| Attack | Response | Residual risk |
|---|---|---|
| Agent bypasses the hook (script, child process, generated code) | Hooks are advisory. The boundary is the credential: the agent holds only `agm_ph_` placeholders, which authenticate nowhere. Placeholder use outside the broker is recorded as a bypass attempt. | Holds only if real credentials are actually removed from the agent's reach — run `agamemnon sweep`, rotate what it finds, and enable your agent's sandbox. |
| Statement swapped after approval / world changes before execution | Approval is bound to the measured effect hash plus a precondition token; execution re-measures and re-checks atomically (Postgres: inside the transaction). Drift → nothing runs. | Connectors without an atomic precondition (some SaaS APIs) have a small window between check and write; their previews are labelled `rendered` / `estimated` and need more approval. |
| SQL injection through an agent's statement | libpg_query parse (exactly one statement, allowlisted relations — including DELETE/UPDATE/INSERT targets — forbidden functions, no data-modifying CTEs) **and** database-side layers: READ ONLY measurement, extended protocol, per-request role scoped to the verbs and tables needed. | The Convex Gen-1 path uses a lexical guard instead of libpg_query (WASM cannot load in a mutation); the database-side layers still apply there. |
| Prompt injection via data (tickets, web pages) | Untrusted reads taint the task lineage; private + untrusted + egress (the lethal trifecta) needs a human; untrusted rows are returned as data, never instructions. | Taint is per task lineage, not per value; an agent that launders data through an unlabelled source escapes it. |
| Approval laundering / rubber-stamping | Approval cards are built from measurements only; agent prose is quarantined; reviewer canaries and rubber-stamp telemetry; approvals carry identity. | Humans can still approve bad things. Canaries measure it; they do not prevent it. |
| Decomposition across sub-agents, runaway loops | Budgets keyed to the root human and the target object, across all agents; per-minute breaker; denials follow the task lineage. | Denial memory matches exact request shapes — rewordings are not caught (an open classification problem). |
| Concurrent automations racing | Per-task leases on written resources while an effect is pending; read-version / precondition checks at commit. | Leases are broker-local; writers that bypass the broker are not serialised. |
| Persistence (agent creates keys, webhooks, workflows) | Created artifacts are recorded per task and revoked when the task ends unless a human keeps them; stale ones are swept after 24 h. | Artifacts created outside the broker are invisible to it. |
| Tampering with the audit log | Hash chain; any edit or deletion breaks verification at the first altered row. | Tamper-evident, not tamper-proof: anchor the head hash outside the broker (WORM bucket / transparency log) for the latter. |
| Stolen operator token | Tokens are revocable; every action is attributed; policy changes need a second person. | No WebAuthn / step-up yet (deferred). |
| Broker host compromise | Out of scope for the broker itself: an attacker with the host has the master key in memory. Mitigations: run the broker as its own user / container, keep the master key in a KMS, restrict network egress from the host, rotate downstream credentials. | High. This is the honest cost of centralising credentials — the same trade every credential broker makes. |
| Broker unavailable | Hooks fail closed on risky actions; the broker itself never executes on uncertainty (drift, missing evidence → no action). | Availability: single node (SQLite). An HA data plane is on the roadmap, not built. |

## Break-glass

An approver can declare a time-boxed emergency (≤ 60 min, written reason). For
that window their single approval suffices for effects they did not request
and did not launch. Every break-glass approval is audited as such, announced on
the webhook, and marked for post-incident review.

## What the broker deliberately does not do

- It does not approve inside the agent's client (MCP form elicitation, chat
  prompts): a client hook can answer those automatically.
- It does not use an LLM to make or loosen a decision. Where a classifier is
  consulted (Gen-1 Convex path) it can only escalate, and it sees structured
  facts — never row values.
- It does not claim to undo side effects that already left the building
  (a delivered email, an issued refund). Those are held before they leave, or
  typed irreversible and given two humans.
