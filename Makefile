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
        test psql

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

provision: convex-env seed-policy ## Push env + seed policy into the running Convex
	@echo "Convex provisioned."

convex-env: ## Push AGAMEMNON_DATABASE_URL + Nebius config into Convex (no values printed)
	@bash scripts/convex-env.sh

seed-policy: ## Seed the policy allowlist + agent 30-day median into Convex
	@$(CONVEX) run internal.core.seed '{"agent":"dispatch-copilot","median30d":1210,"allowlist":["loads","bookings"],"perRunDestructiveRowBudget":5000}'

## ── Run the agent ───────────────────────────────────────────────────────────
agent-unprotected: ## Act 1: run the agent UNPROTECTED (deletes directly!)
	@cp $(AGENT)/.env.unprotected $(AGENT)/.env && cd $(AGENT) && npx tsx dispatch-copilot.ts

agent-protected: ## Act 2: run the agent PROTECTED (routed through Agamemnon)
	@cp $(AGENT)/.env.protected $(AGENT)/.env && cd $(AGENT) && npx tsx dispatch-copilot.ts

## ── Reset / verify ──────────────────────────────────────────────────────────
reset: ## Restore a cold demo state (re-seed Postgres; clear Convex runs)
	@bash scripts/reset.sh

verify: ## Show the most recent actions recorded in Convex
	@$(CONVEX) data actions | tail -8

test: ## Run the policy engine unit tests
	@cd $(AGA) && npx vitest run

psql: ## Open psql on the meridian database as the app role
	@bash -c 'source scripts/lib.sh && load_env && psql_app'
