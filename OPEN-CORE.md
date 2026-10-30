# Open core: what is open, what is not

Agamemnon is open-core. The safety system is open source under the
[Apache License 2.0](LICENSE). Convenience, interface and compliance add-ons are
proprietary.

**The rule:** anything that makes an agent safe is open. You can run the whole
preview → bind → admit by reversibility → verify loop without paying for
anything.

## Open (Apache-2.0)

| Part | What it includes |
|---|---|
| `packages/kernel` | Effect model, admission, binding, oversight catalogue, claims, budgets, leases, taint, approvals, receipts, selective revert, shell analysis |
| `packages/broker` | Engine, vault, HTTP API, all connectors, two-person approvals, break-glass, policy changes, reviewer canaries, audit chain, signed receipts, evidence export, metrics, webhook, approval page, extension point |
| `packages/agamemnon-mcp` | MCP server for agents |
| `packages/hooks` | Pre-tool hooks for coding agents |
| `packages/agamemnon-cli` | `init`, `sweep`, `coverage`, `harden-db`, `check-migration`, `receipts verify`, `pending` / `approve` / `deny`, `admin` |
| `packages/sandbox` | QuickJS-Wasm mini-sandboxes and the Firecracker microVM tier, whose only way out is a broker proposal |
| `packages/larkspur` | Gen 2 demo company run end to end under the broker and sandboxes |
| `bench/`, `deploy/`, `docs/` | Agent Incident Replay Bench, Docker files, documentation |
| `packages/agamemnon`, `packages/meridian` | Gen 1 database guard and its sample application |

## Proprietary

| Part | Where |
|---|---|
| Full operator console for the broker | Agamemnon Enterprise, loaded as a broker extension |
| Compliance annotations for the evidence pack (EU AI Act, SOC 2, AIUC-1) | Agamemnon Enterprise, loaded as a broker extension |
| Desktop apps and their consoles | `packages/agamemnon-guard`, `packages/halcyon`, `packages/desktop`, `packages/northwind-bank`, `packages/console`, `packages/agamemnon/console` (each has its own LICENSE) |

## Our promise

- **Safety features stay open.** Nothing that decides whether an agent's action
  runs (admission, binding, reversibility, approvals, verification, revert,
  audit and receipts) will move into a paid product.
- **The open broker stays complete.** Approvals work without the console, from
  the approval page or the CLI.
- **Open code stays open.** Code released under Apache-2.0 keeps that licence.

## How the paid parts plug in

The broker has an extension point (`packages/broker/src/extensions.ts`). An
extension can replace the `/` and `/console` pages, add operator routes, and
annotate evidence lines. It cannot override core routes or reach `/v1/admin/`.
Extensions are trusted code that runs inside the broker process, so only load
extensions you trust.

```bash
AGAMEMNON_EXTENSIONS=@agamemnon/enterprise make broker
```

Questions about Agamemnon Enterprise: contact@elamaran.co
