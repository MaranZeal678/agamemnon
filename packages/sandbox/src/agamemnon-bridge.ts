/*
 * Agamemnon — AI-agent write-path guardian
 * Copyright (c) 2026 Elamaran Elangovan. All rights reserved.
 *
 * Proprietary and confidential. No licence is granted to use, copy, modify,
 * distribute, or run this software beyond local evaluation of this repository
 * as published. See LICENSE at the repository root.
 *
 * ref: AGMN-BOZW-F6BTKX-X3LAO
 */

import type { Broker } from "@agamemnon/broker";
import type { TrustLabel } from "@agamemnon/kernel";
import type { AgamemnonProposalBridge, PolicyViolation, ProposalOutcome, Scalar, SandboxMutation } from "./types.ts";

/**
 * The bridge from sandbox requests to Agamemnon effects.
 *
 * It adds NO policy of its own. A sandbox write becomes an ordinary
 * `postgres.sql` proposal from the sandbox's agent principal, on a broker task
 * scoped to the sandbox's tenant — so the broker measures the real blast
 * radius, applies the tenant guard (tenantColumn), types reversibility, parks
 * it for approval or blocks it, exactly as for any other agent.
 *
 * The SQL compiler below is the one place sandbox-controlled strings become
 * SQL text. The broker re-parses that text (libpg-query) before measuring, but
 * compile it as if it didn't.
 */

// --- SQL compilation -------------------------------------------------------------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * A table or column name as SQL. Only /^[A-Za-z_][A-Za-z0-9_]*$/ up to 63
 * characters (Postgres's NAMEDATALEN), double-quoted: `orders` → `"orders"`.
 * Anything else throws — reject, don't escape: there is no legitimate sandbox
 * table name that needs quoting, and escaping is where injections hide.
 */
export function quoteIdent(name: string): string {
  if (typeof name !== "string" || !IDENT.test(name)) throw new Error(`invalid identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/**
 * A JSON value as a SQL literal.
 *   null → NULL · true/false → TRUE/FALSE · finite number → its decimal text
 *   string → '…' with every ' doubled (standard_conforming_strings is on, so
 *            backslashes are literal); a string containing \u0000 → throw
 *   object / array → its JSON text as a string literal (Postgres casts to json/jsonb)
 *   NaN, ±Infinity, undefined, anything else → throw
 */
export function quoteLiteral(value: unknown): string {
  if (value === null) return "NULL";
  switch (typeof value) {
    case "boolean":
      return value ? "TRUE" : "FALSE";
    case "number":
      if (!Number.isFinite(value)) throw new Error(`cannot write ${value} to SQL`);
      return String(value);
    case "string":
      if (value.includes("\u0000")) throw new Error("strings may not contain NUL bytes");
      return `'${value.replaceAll("'", "''")}'`;
    case "object":
      return quoteLiteral(JSON.stringify(value));
    default:
      throw new Error(`cannot write a ${typeof value} to SQL`);
  }
}

/** Equality-only WHERE, AND-ed in key order; null → IS NULL; nothing → no clause. */
function whereSql(where?: Record<string, Scalar>): string {
  const terms = Object.entries(where ?? {}).map(([col, v]) => (v === null ? `${quoteIdent(col)} IS NULL` : `${quoteIdent(col)} = ${quoteLiteral(v)}`));
  return terms.length ? ` WHERE ${terms.join(" AND ")}` : "";
}

/**
 * Compile a mutation. No where (or {}) → no WHERE clause — the broker will
 * measure the whole-table blast radius and gate it.
 *
 *   insert  INSERT INTO "t" ("a", "b") VALUES (1, 'x')        empty data → throw
 *   update  UPDATE "t" SET "a" = 1, "b" = 'x' WHERE "id" = 3   empty data → throw
 *   delete  DELETE FROM "t" WHERE "status" = 'stale' AND "note" IS NULL
 */
export function mutationToSql(m: SandboxMutation): string {
  const table = quoteIdent(m.table);
  const cols = Object.entries(m.data ?? {});
  switch (m.operation) {
    case "insert":
      if (!cols.length) throw new Error("insert needs at least one column");
      return `INSERT INTO ${table} (${cols.map(([c]) => quoteIdent(c)).join(", ")}) VALUES (${cols.map(([, v]) => quoteLiteral(v)).join(", ")})`;
    case "update":
      if (!cols.length) throw new Error("update needs at least one column to set");
      return `UPDATE ${table} SET ${cols.map(([c, v]) => `${quoteIdent(c)} = ${quoteLiteral(v)}`).join(", ")}${whereSql(m.where)}`;
    case "delete":
      return `DELETE FROM ${table}${whereSql(m.where)}`;
    default:
      throw new Error(`unknown mutation operation ${JSON.stringify((m as { operation: unknown }).operation)}`);
  }
}

/** SELECT * FROM "t" WHERE … — same WHERE rules as mutationToSql. */
export function selectToSql(q: { table: string; where?: Record<string, Scalar> }): string {
  return `SELECT * FROM ${quoteIdent(q.table)}${whereSql(q.where)}`;
}

// --- the bridge ------------------------------------------------------------------

type Engine = Broker["engine"];
type Principal = NonNullable<ReturnType<Broker["store"]["principal"]>>;
type EffectView = Awaited<ReturnType<Engine["propose"]>>;

export interface BrokerBridgeOptions {
  /** The broker principal every sandbox acts as (kind "agent", with an owner). */
  agent: string;
  /** The registered Postgres connection name (`connection:<name>` target). */
  connection: string;
}

export class BrokerProposalBridge implements AgamemnonProposalBridge {
  readonly #broker: Pick<Broker, "engine" | "store">;
  readonly #opts: BrokerBridgeOptions;
  readonly #tasks = new Map<string, string>();

  constructor(broker: Pick<Broker, "engine" | "store">, opts: BrokerBridgeOptions) {
    this.#broker = broker;
    this.#opts = opts;
  }

  #agent(): Principal {
    const p = this.#broker.store.principal(this.#opts.agent);
    if (!p) throw new Error(`broker principal ${this.#opts.agent} is not registered`);
    return p;
  }

  #task(sandboxId: string): string {
    const t = this.#tasks.get(sandboxId);
    if (!t) throw new Error(`sandbox ${sandboxId} is not attached to the broker`);
    return t;
  }

  /** Broker task id for a sandbox (for operators and tests). */
  taskOf(sandboxId: string): string | undefined {
    return this.#tasks.get(sandboxId);
  }

  async attach(sandboxId: string, tenantId: string): Promise<void> {
    const task = this.#broker.engine.startTask(this.#agent(), { goal: `mini-sandbox ${sandboxId}`, tenant: tenantId });
    this.#tasks.set(sandboxId, task.id);
  }

  async detach(sandboxId: string): Promise<void> {
    const taskId = this.#tasks.get(sandboxId);
    if (!taskId) return;
    this.#tasks.delete(sandboxId);
    await this.#broker.engine.endTask(this.#agent(), taskId);
  }

  async handleSandboxWriteProposal(sandboxId: string, mutation: SandboxMutation, meta?: { provenance?: TrustLabel[] }): Promise<ProposalOutcome> {
    const sql = mutationToSql(mutation);
    const v = await this.#broker.engine.propose(this.#agent(), {
      taskId: this.#task(sandboxId),
      operation: "postgres.sql",
      params: { connection: this.#opts.connection, sql },
      provenance: meta?.provenance,
    });
    return toOutcome(v);
  }

  async handleSandboxRead(sandboxId: string, query: { table: string; where?: Record<string, Scalar> }) {
    const sql = selectToSql(query);
    const v = await this.#broker.engine.propose(this.#agent(), {
      taskId: this.#task(sandboxId),
      operation: "postgres.query",
      params: { connection: this.#opts.connection, sql },
    });
    const rows = (v.result as { rows?: unknown[] } | undefined)?.rows ?? [];
    return { rows, outcome: toOutcome(v) };
  }

  async recordViolation(v: PolicyViolation): Promise<void> {
    this.#broker.store.audit({
      kind: "sandbox-violation",
      actor: this.#opts.agent,
      taskId: this.#tasks.get(v.sandboxId),
      detail: `mini-sandbox ${v.sandboxId} (tenant ${v.tenantId}) killed: ${v.reason}`,
      data: { syscall: v.syscall },
    });
  }
}

function toOutcome(v: EffectView): ProposalOutcome {
  return { proposalId: v.id, status: v.status, approved: v.status === "executed", summary: v.summary, counts: v.counts, firedRules: v.firedRules };
}
