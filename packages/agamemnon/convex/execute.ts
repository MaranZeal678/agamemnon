"use node";
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

import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * The ONLY holder of the Postgres credential.
 *
 * The connection string lives solely in the Convex environment variable
 * AGAMEMNON_DATABASE_URL — never in the agent's environment, never printed.
 *
 * Defence in depth for the agent-supplied predicate (the lexical guard in
 * kickoff is only the first layer):
 *  - every statement is sent with the extended query protocol, so Postgres
 *    refuses a second statement outright;
 *  - measurement runs inside BEGIN READ ONLY with a statement timeout, so even
 *    a volatile function in the predicate cannot write;
 *  - execution runs under a per-request role granted exactly the verbs needed
 *    on exactly the tables involved. The role is created, used, revoked and
 *    dropped inside ONE transaction — it never exists outside it.
 */

const MEASURE_TIMEOUT_MS = 15000;
const EXECUTE_TIMEOUT_MS = 60000;
// Postgres caps a statement at 65,535 bind parameters; stay well under.
const MAX_PARAMS_PER_INSERT = 60000;

function connectionString(): string {
  const url = process.env.AGAMEMNON_DATABASE_URL;
  if (!url) {
    throw new Error(
      "AGAMEMNON_DATABASE_URL is not set in the Convex environment. Run: make convex-env (sets it from .env without printing it).",
    );
  }
  return url;
}

const ident = (name: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`refusing unsafe identifier "${name}"`);
  return `"${name}"`;
};

/** One statement, extended protocol — Postgres rejects anything multi-statement. */
async function q(c: pg.Client, text: string, values: unknown[] = []) {
  return c.query({ text, values, queryMode: "extended" } as any);
}

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function assertTarget(ctx: any, target: string, extra: string[] = []) {
  const policy = await ctx.runQuery(internal.core.policyQuery, {});
  for (const t of [target, ...extra]) {
    ident(t);
    if (!policy.allowlist.includes(t)) throw new Error(`refusing to operate on "${t}": not on the policy allowlist`);
  }
}

async function assertTableExists(c: pg.Client, table: string) {
  const r = await q(c, "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1", [table]);
  if (r.rowCount === 0) throw new Error(`table public.${table} does not exist`);
}

/** Primary-key columns of a table, from the catalog (no `bigint id` assumption). */
async function primaryKey(c: pg.Client, table: string): Promise<string[]> {
  const r = await q(
    c,
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ('public.' || $1)::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [table],
  );
  return r.rows.map((x: any) => x.attname);
}

/** Tables whose foreign keys would cascade or null-out when rows of `table` are deleted. */
async function cascadingChildren(c: pg.Client, table: string): Promise<string[]> {
  const r = await q(
    c,
    `SELECT conrelid::regclass::text AS child, confdeltype
       FROM pg_constraint
      WHERE contype = 'f' AND confrelid = ('public.' || $1)::regclass
        AND confdeltype IN ('c', 'n', 'd')`,
    [table],
  );
  return r.rows.map((x: any) => `${x.child} (${x.confdeltype === "c" ? "ON DELETE CASCADE" : "ON DELETE SET NULL/DEFAULT"})`);
}

/** Row-level triggers that would fire on DELETE (their side effects are not snapshotted). */
async function deleteTriggers(c: pg.Client, table: string): Promise<string[]> {
  const r = await q(
    c,
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = ('public.' || $1)::regclass AND NOT tgisinternal
        AND (tgtype & 8) <> 0`, // TRIGGER_TYPE_DELETE
    [table],
  );
  return r.rows.map((x: any) => x.tgname);
}

/** Columns to restore: everything except stored generated columns. */
async function restorableColumns(c: pg.Client, table: string): Promise<{ name: string; identityAlways: boolean }[]> {
  const r = await q(
    c,
    `SELECT attname, attidentity FROM pg_attribute
      WHERE attrelid = ('public.' || $1)::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
      ORDER BY attnum`,
    [table],
  );
  return r.rows.map((x: any) => ({ name: x.attname, identityAlways: x.attidentity === "a" }));
}

/** Snapshot values must survive JSON: encode bytea explicitly. */
function encodeRow(row: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(row)) {
    out[k] = Buffer.isBuffer(val) ? { $bytea: val.toString("base64") } : val;
  }
  return out;
}
function decodeValue(val: any) {
  if (val && typeof val === "object" && typeof val.$bytea === "string") return Buffer.from(val.$bytea, "base64");
  if (val && typeof val === "object" && !Array.isArray(val)) return JSON.stringify(val); // json/jsonb
  return val;
}

function newRoleName() {
  return `agm_req_${randomBytes(6).toString("hex")}`;
}

/**
 * Measure the TRUE blast radius of a proposed delete — independent of whatever
 * the agent claimed. READ ONLY transaction, statement timeout, one statement.
 */
export const countMatching = internalAction({
  args: { target: v.string(), predicate: v.string() },
  handler: async (ctx, { target, predicate }): Promise<{ matchingRows: number; totalRows: number }> => {
    await assertTarget(ctx, target);
    return withClient(async (c) => {
      await q(c, "BEGIN READ ONLY");
      try {
        await q(c, `SET LOCAL statement_timeout = ${MEASURE_TIMEOUT_MS}`);
        await assertTableExists(c, target);
        const matching = await q(c, `SELECT count(*)::bigint AS n FROM ${ident(target)} WHERE ${predicate}`);
        const total = await q(c, `SELECT count(*)::bigint AS n FROM ${ident(target)}`);
        return { matchingRows: Number(matching.rows[0].n), totalRows: Number(total.rows[0].n) };
      } finally {
        await q(c, "ROLLBACK").catch(() => {});
      }
    });
  },
});

/**
 * REVERSIBLE destructive execution, all inside ONE Postgres transaction:
 *   1. refuse targets whose deletes would cascade into tables we do not snapshot,
 *   2. record the WAL position, mint a per-request role with only the verbs needed,
 *   3. DELETE … RETURNING * under that role — the snapshot IS the deleted set,
 *   4. reconcile the real count against the approved estimate (rollback if >5% off),
 *   5. store the snapshot and commit the undo plan,
 *   6. revoke + drop the role, then COMMIT.
 */
export const snapshotAndDelete = internalAction({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }): Promise<void> => {
    const a = await ctx.runQuery(internal.core.actionForExecution, { actionId });
    if (!a) throw new Error("unknown action");
    try {
      await assertTarget(ctx, a.target, a.referencedTables);
    } catch (e: any) {
      await ctx.runMutation(internal.core.markFailed, { actionId, error: e?.message ?? String(e) });
      return;
    }

    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    const role = newRoleName();
    let committed = false;
    try {
      await q(client, "BEGIN");
      await q(client, `SET LOCAL statement_timeout = ${EXECUTE_TIMEOUT_MS}`);
      await q(client, "SET LOCAL lock_timeout = 5000");

      const children = await cascadingChildren(client, a.target);
      if (children.length) {
        await q(client, "ROLLBACK");
        await ctx.runMutation(internal.core.markFailed, {
          actionId,
          error: `cascade blocked: deleting from ${a.target} would also change ${children.join(", ")}, which the snapshot cannot cover — nothing deleted`,
        });
        return;
      }
      const triggers = await deleteTriggers(client, a.target);
      if (triggers.length) {
        await q(client, "ROLLBACK");
        await ctx.runMutation(internal.core.markFailed, {
          actionId,
          error: `trigger blocked: ${a.target} has DELETE triggers (${triggers.join(", ")}) whose side effects cannot be undone — nothing deleted`,
        });
        return;
      }

      const lsn = (await q(client, "SELECT pg_current_wal_lsn()::text AS lsn").catch(() => null))?.rows?.[0]?.lsn as
        | string
        | undefined;

      // Mint the per-request role: SELECT+DELETE on the target, SELECT on tables
      // the predicate's subqueries read. Nothing else.
      const grants = [`SELECT, DELETE ON ${a.target}`, ...a.referencedTables.map((t: string) => `SELECT ON ${t}`)];
      await q(client, `CREATE ROLE ${ident(role)} NOLOGIN`);
      await q(client, `GRANT SELECT, DELETE ON ${ident(a.target)} TO ${ident(role)}`);
      for (const t of a.referencedTables) await q(client, `GRANT SELECT ON ${ident(t)} TO ${ident(role)}`);
      await q(client, `GRANT ${ident(role)} TO CURRENT_USER`);
      await ctx.runMutation(internal.core.markExecuting, { actionId, role, walLsn: lsn, grants });
      await q(client, `SET LOCAL ROLE ${ident(role)}`);

      const del = await q(client, `DELETE FROM ${ident(a.target)} WHERE ${a.predicate} RETURNING *`);
      const rows = del.rows;
      const columns = del.fields.map((f: any) => f.name);

      // Reconcile BEFORE committing; the approval was for the measured count.
      if (a.estimatedRows > 0 && Math.abs(rows.length - a.estimatedRows) / a.estimatedRows > 0.05) {
        await q(client, "ROLLBACK");
        await ctx.runMutation(internal.core.markFailed, {
          actionId,
          error: `reconcile halt: matched ${rows.length} rows but the approved estimate was ${a.estimatedRows} (>5% drift) — rolled back, nothing deleted`,
        });
        return;
      }

      await q(client, "RESET ROLE");
      const pk = await primaryKey(client, a.target);
      const blob = new Blob(
        [JSON.stringify({ version: 2, target: a.target, columns, primaryKey: pk, walLsn: lsn ?? null, rows: rows.map(encodeRow) })],
        { type: "application/json" },
      );
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.core.commitUndoPlan, { actionId, target: a.target, storageId, rowCount: rows.length });

      // The role never outlives the transaction.
      await q(client, `REVOKE ALL ON ${ident(a.target)} FROM ${ident(role)}`);
      for (const t of a.referencedTables) await q(client, `REVOKE ALL ON ${ident(t)} FROM ${ident(role)}`);
      await q(client, `DROP ROLE ${ident(role)}`);
      await q(client, "COMMIT");
      committed = true;
      await ctx.runMutation(internal.core.markExecuted, { actionId, actualRows: rows.length });
    } catch (e: any) {
      if (!committed) await q(client, "ROLLBACK").catch(() => {});
      await ctx.runMutation(internal.core.markFailed, { actionId, error: e?.message ?? String(e) });
    } finally {
      await client.end();
    }
  },
});

/**
 * Undo: replay the stored snapshot as batched inserts inside one transaction,
 * under a per-request INSERT-only role. Rows whose primary key was re-used in
 * the meantime are skipped and reported, never overwritten. Operator-only.
 */
export const undo = action({
  args: { actionId: v.id("actions"), operatorToken: v.string() },
  handler: async (ctx, { actionId, operatorToken }): Promise<{ restored: number; skipped: number }> => {
    const op = await ctx.runQuery(internal.core.operatorForToken, { token: operatorToken, roles: ["admin", "approver"] });
    if (!op || "error" in op) throw new Error(op && "error" in op ? op.error : "operator sign-in required");

    const plan = await ctx.runQuery(internal.core.undoPlanForAction, { actionId });
    if (!plan) throw new Error("no undo plan for this action");
    if (plan.applied) return { restored: 0, skipped: 0 };
    await assertTarget(ctx, plan.target);

    const blob = await ctx.storage.get(plan.storageId);
    if (!blob) throw new Error("snapshot blob missing");
    const snapshot = JSON.parse(await blob.text()) as { target: string; columns: string[]; rows: Record<string, any>[] };
    if (snapshot.rows.length === 0) return { restored: 0, skipped: 0 };

    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    const role = newRoleName();
    try {
      await q(client, "BEGIN");
      await q(client, `SET LOCAL statement_timeout = ${EXECUTE_TIMEOUT_MS}`);
      const cols = (await restorableColumns(client, plan.target)).filter((c) => snapshot.columns.includes(c.name));
      const overriding = cols.some((c) => c.identityAlways) ? " OVERRIDING SYSTEM VALUE" : "";
      await q(client, `CREATE ROLE ${ident(role)} NOLOGIN`);
      await q(client, `GRANT SELECT, INSERT ON ${ident(plan.target)} TO ${ident(role)}`);
      await q(client, `GRANT ${ident(role)} TO CURRENT_USER`);
      await q(client, `SET LOCAL ROLE ${ident(role)}`);

      const colList = cols.map((c) => ident(c.name)).join(", ");
      const perBatch = Math.max(1, Math.floor(MAX_PARAMS_PER_INSERT / Math.max(1, cols.length)));
      let restored = 0;
      for (let start = 0; start < snapshot.rows.length; start += perBatch) {
        const batch = snapshot.rows.slice(start, start + perBatch);
        const values: unknown[] = [];
        const tuples = batch.map((row, i) => {
          cols.forEach((c) => values.push(decodeValue(row[c.name])));
          return `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(", ")})`;
        });
        const res = await q(
          client,
          `INSERT INTO ${ident(plan.target)} (${colList})${overriding} VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`,
          values,
        );
        restored += res.rowCount ?? 0;
      }
      await q(client, "RESET ROLE");
      await q(client, `REVOKE ALL ON ${ident(plan.target)} FROM ${ident(role)}`);
      await q(client, `DROP ROLE ${ident(role)}`);
      await q(client, "COMMIT");

      const skipped = snapshot.rows.length - restored;
      await ctx.runMutation(internal.core.recordUndoAction, {
        originalActionId: actionId,
        restoredRows: restored,
        skippedRows: skipped,
        operator: op.name,
      });
      return { restored, skipped };
    } catch (e) {
      await q(client, "ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await client.end();
    }
  },
});
