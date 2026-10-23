# @agamemnon/sandbox — mini-sandboxes

Untrusted code — agent-generated scripts, third-party plugins, members of an
agent swarm — runs in an enclave whose **only way to touch the world is an
Agamemnon proposal**.

```
 supervisor (master sandbox)                      enclave (mini-sandbox)
 ┌───────────────────────────────┐   syscall    ┌──────────────────────────┐
 │ parseSyscall   (hostile JSON) │ ◀──────────  │ QuickJS-Wasm, own memory │
 │ checkSyscall   (capabilities) │              │ db / api / agents        │
 │ IPC broker → db.* → bridge ───┼──▶ broker    │ console / context        │
 │            → http.* (GET)     │    propose() │ no fs, net, timers,      │
 │            → ipc.* mailboxes  │  ──────────▶ │ modules or host objects  │
 └───────────────────────────────┘    reply     └──────────────────────────┘
```

- **Isolation by absence.** Each sandbox is its own Wasm module (its own linear
  memory); each run gets a fresh QuickJS runtime and context. The guest gets
  three host functions in a closure — `sys`, `log`, `finish` — and nothing else.
- **Capabilities, not trust.** `READ_ONLY` (db.select), `MUTATE_STATE`
  (db.insert/update/delete), `EXTERNAL_HTTP` (HTTPS GET to exact allowlisted
  hosts), `AGENT_IPC` (agents.send/recv). Nothing implies anything else.
- **A violation kills.** An ungranted or malformed syscall kills the run,
  records a `PolicyViolation`, writes it to the broker's audit log, terminates
  the sandbox for good and ends its broker task (which cancels anything it
  left waiting for approval). A timeout or crash only kills the run.
- **Writes are proposals.** `BrokerProposalBridge` compiles a mutation to SQL
  (identifiers rejected, not escaped; literals quoted) and proposes it on a
  broker task scoped to the sandbox's tenant. The broker measures it, applies
  the tenant guard on both rows matched and values written, and executes,
  parks, holds or blocks it like any other agent effect.
- **Swarms share nothing.** Messages go through the supervisor, are copied,
  stay inside one tenant, and arrive labelled `untrusted`; the recipient's later
  proposals carry that label into the broker.

```ts
import { SandboxSupervisor, BrokerProposalBridge } from "@agamemnon/sandbox";

const bridge = new BrokerProposalBridge(broker, { agent: "sandbox-runtime", connection: "app" });
const sup = new SandboxSupervisor({ bridge });
const id = await sup.spawnSandbox({
  id: "loyalty-plugin",
  tenantId: "bloom-botanicals",
  runtime: "quickjs-wasm",
  capabilities: { grants: ["READ_ONLY", "MUTATE_STATE"], maxMemoryMb: 32, timeoutMs: 3000 },
});
const r = await sup.executeInSandbox(id, `return await db.insert("loyalty_points", { merchant_id: "bloom-botanicals", customer_id: 3, points: 40 });`, {});
// r.proposals[0].status → "executed" | "awaiting_approval" | "held" | "blocked"
```

## Tests

`npx vitest run` — 138 tests: the enclave (escape attempts, CPU, memory,
stack, host-stack exhaustion, ReDoS, tampering), syscall parsing, capabilities
(URL confusion: userinfo, backslashes, homoglyphs, ports), the SQL compiler,
the supervisor lifecycle, and one suite per use case (code interpreter,
multi-tenant, plugin security, swarm IPC). Suites marked "real broker" use the
broker's test Postgres and skip when it is down; don't run them at the same
time as the broker's suite (they share that database).

## Honest limits

- **QuickJS tier: not hard preemption.** The deadline is checked between bytecodes and inside
  the regex engine. One bulk native call can overrun it by seconds, and a
  synchronous `while (true) {}` holds the host's event loop until its deadline
  (async spins are sliced and yield). The fix is hosting each enclave in a
  worker that can be `terminate()`d.
- **QuickJS lets a non-configurable global be redefined**, so a guest can
  replace its own `db` object. Harmless — no authority lives there — but the
  surface is not tamper-proof.
- **`worker-thread` is refused**: a Node worker has the host's full authority.
- **The microVM tier** (`microvm-adapter`: Firecracker on KVM, Python, hard
  deadlines) needs a KVM host — see [vmhost/README.md](vmhost/README.md) for
  the architecture, `make vm-check`, and its own limits (no jailer yet, ~4 s
  boot under nested virtualization).
- **`api.fetch` has no DNS-rebinding defence** — allowlist names you control.
