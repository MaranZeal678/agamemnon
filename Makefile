# Agamemnon — demo control surface.
# Local-first: Homebrew Postgres + anonymous LOCAL Convex (offline-capable).
# Convex's local backend runs "use node" actions with Node 24, so all convex
# commands are pinned to nvm's v24 and anonymous mode.

SHELL := /bin/bash
NODE24 := $(HOME)/.nvm/versions/node/v24.12.0/bin
AGA := packages/agamemnon
AGENT := packages/meridian/agent
CONVEX := cd $(AGA) && PATH="$(NODE24):$$PATH" CONVEX_AGENT_MODE=anonymous npx convex

.DEFAULT_GOAL := help
.PHONY: help gen-creds db-setup seed-db agent-env setup convex-dev convex-env \
        seed-policy provision agent-protected agent-unprotected reset verify \
        test psql principals verify-e2e broker test-all bench guards larkspur larkspur-verify vm-up vm-setup vmhost vm-check vm-down

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

## ── One-time / setup ────────────────────────────────────────────────────────
gen-creds: ## Generate DB passwords into .env (idempotent, never overwrites)
	@bash scripts/gen-creds.sh

db-setup: ## Create the meridian database + roles on local Postgres
	@bash scripts/db-setup.sh

seed-db: ## Seed 412k loads + agent history + breaking migration (~6s)
	@bash scripts/db-seed.sh

agent-env: ## (Re)generate the agent's .env.unprotected / .env.protected
	@bash scripts/agent-env.sh

setup: gen-creds db-setup seed-db agent-env ## Full local setup (everything except Convex)
	@echo "Setup complete. Next: run 'make convex-dev' in a separate terminal, then 'make provision'."

## ── Convex (local, anonymous) ───────────────────────────────────────────────
convex-dev: ## Start the local Convex backend in watch mode (leave running)
	@$(CONVEX) dev

provision: convex-env seed-policy principals ## Push env + seed policy + principals into the running Convex
	@echo "Convex provisioned."

convex-env: ## Push AGAMEMNON_DATABASE_URL + Nebius config into Convex (no values printed)
	@bash scripts/convex-env.sh

seed-policy: ## Seed the policy allowlist + agent 30-day median into Convex
	@$(CONVEX) run internal.core.seed '{"agent":"dispatch-copilot","median30d":1210,"allowlist":["loads","bookings"],"perRunDestructiveRowBudget":5000,"twoPersonRowThreshold":2000,"classifierDomain":"a freight operations system"}'

principals: ## Register the agent + console operators in Convex (token hashes only)
	@bash scripts/provision-principals.sh

## ── Demo services + acts ────────────────────────────────────────────────────
up: ## Start all demo services (Convex + Meridian web + console), idempotent
	@bash demo/up.sh

down: ## Stop all demo services
	@bash demo/down.sh

demo: up ## Start everything for the demo (then run act1/act2/act3)
	@echo "Ready. Open the two browser panes above, then: make act1"

agent-unprotected: ## run the agent UNPROTECTED (deletes directly!)
	@cp $(AGENT)/.env.unprotected $(AGENT)/.env && cd $(AGENT) && npx tsx dispatch-copilot.ts

agent-protected: ## run the agent PROTECTED (routed through Agamemnon)
	@cp $(AGENT)/.env.protected $(AGENT)/.env && cd $(AGENT) && npx tsx dispatch-copilot.ts

act1: reset ## Act 1 — unprotected: watch the board drain 412,000 → 0
	@cp $(AGENT)/.env.unprotected $(AGENT)/.env && cd $(AGENT) && npx tsx dispatch-copilot.ts

act2: reset ## Act 2 — protected: Agamemnon blocks the 412k delete
	@cp $(AGENT)/.env.protected $(AGENT)/.env && cd $(AGENT) && SCENARIO=rogue npx tsx dispatch-copilot.ts

act3: reset ## Act 3 — plausible: 900-row delete parks for approval (approve, then undo in the console)
	@cp $(AGENT)/.env.protected $(AGENT)/.env && cd $(AGENT) && SCENARIO=plausible npx tsx dispatch-copilot.ts

## ── Eval (Phase 5) ──────────────────────────────────────────────────────────
eval: ## Score tuned/stock/frontier classifiers → console Eval tab
	@cd $(AGA)/eval && npx tsx score.ts

eval-dataset: ## Regenerate the 200-case labelled dataset via Nebius
	@cd $(AGA)/eval && npx tsx generate.ts

## ── Reset / verify ──────────────────────────────────────────────────────────
reset: ## Restore a cold demo state (re-seed Postgres; clear Convex runs)
	@bash scripts/reset.sh

verify: ## Show the most recent actions recorded in Convex
	@$(CONVEX) data actions | tail -8

test: ## Run the kernel + policy unit tests
	@cd packages/kernel && npx vitest run
	@cd $(AGA) && npx vitest run

verify-e2e: ## Live end-to-end hardening check (needs convex-dev running + provision)
	@cd $(AGA) && PATH="$(NODE24):$$PATH" node tests/e2e-hardening.mjs

psql: ## Open psql on the meridian database as the app role
	@bash -c 'source scripts/lib.sh && load_env && psql_app'

## ── Gen 2: the effect-typed reference monitor ───────────────────────────────
BROKER_NODE := PATH="$(NODE24):$$PATH" NODE_NO_WARNINGS=1 node

larkspur: ## Larkspur demo dashboard (Gen 2 + mini-sandboxes) on http://127.0.0.1:5180 — needs local Postgres; uses microVMs if agm-kvm is up
	@T=$$(limactl shell --workdir / $(VM) -- bash -c 'cat $$HOME/.agm-vmhost.token' 2>/dev/null); \
	  AGAMEMNON_VMHOST=$${T:+127.0.0.1:7801} AGAMEMNON_VMHOST_TOKEN=$$T $(BROKER_NODE) packages/larkspur/src/server.ts

larkspur-verify: ## Run every Larkspur scene against the real broker and check Agamemnon's decisions (microVM scene if agm-kvm is up)
	@T=$$(limactl shell --workdir / $(VM) -- bash -c 'cat $$HOME/.agm-vmhost.token' 2>/dev/null); \
	  AGAMEMNON_VMHOST=$${T:+127.0.0.1:7801} AGAMEMNON_VMHOST_TOKEN=$$T $(BROKER_NODE) packages/larkspur/src/verify.ts

VMHOST_DIR := packages/sandbox/vmhost
VM := agm-kvm
VMHOST_ENV = AGAMEMNON_VMHOST=127.0.0.1:7801 AGAMEMNON_VMHOST_TOKEN=$$(limactl shell --workdir / $(VM) -- bash -c 'cat $$HOME/.agm-vmhost.token' 2>/dev/null)

vm-up: ## Boot the agm-kvm Lima VM (Linux + /dev/kvm via nested virtualization) — the microVM host
	@limactl list -q | grep -qx $(VM) && limactl start $(VM) || limactl start --tty=false --name=$(VM) $(VMHOST_DIR)/lima.yaml

vm-setup: ## Inside agm-kvm: fetch Firecracker + guest kernel/rootfs and build the read-only rootfs
	@limactl shell --workdir / $(VM) -- bash $(CURDIR)/$(VMHOST_DIR)/setup-guest.sh

vmhost: ## Run vmhost inside agm-kvm (Firecracker driver; reachable on the Mac at 127.0.0.1:7801)
	@limactl shell --workdir / $(VM) -- python3 $(CURDIR)/$(VMHOST_DIR)/vmhost.py --listen 127.0.0.1:7801 --token-file '$$HOME/.agm-vmhost.token' \
	  --firecracker '$$HOME/agm-vm/firecracker' --kernel '$$HOME/agm-vm/vmlinux' --rootfs '$$HOME/agm-vm/rootfs.ext4'

vm-check: ## Boot real microVMs through vmhost and check every isolation property
	@$(VMHOST_ENV) $(BROKER_NODE) packages/sandbox/scripts/vm-check.ts

vm-down: ## Stop the agm-kvm VM
	@limactl stop $(VM)

broker: ## Run the Gen-2 broker (http://127.0.0.1:7700/console; first run writes an admin token to ~/.agamemnon)
	@$(BROKER_NODE) packages/broker/src/main.ts

test-all: ## Every suite: kernel, policy, broker (live Postgres), sandbox, MCP, hooks, CLI, Larkspur e2e
	@cd packages/kernel && npx vitest run
	@cd $(AGA) && npx vitest run
	@cd packages/broker && PATH="$(NODE24):$$PATH" npx vitest run
	@cd packages/sandbox && PATH="$(NODE24):$$PATH" npx vitest run
	@cd packages/agamemnon-mcp && PATH="$(NODE24):$$PATH" npx vitest run
	@cd packages/hooks && PATH="$(NODE24):$$PATH" npx vitest run
	@cd packages/agamemnon-cli && PATH="$(NODE24):$$PATH" npx vitest run
	@$(BROKER_NODE) packages/larkspur/src/verify.ts

bench: ## Agent Incident Replay Bench → bench/results/scorecard.{json,md}
	@$(BROKER_NODE) bench/run.ts

guards: ## Re-bundle the shared kernel into both desktop guards
	@npm run build:guards -w @agamemnon/kernel
