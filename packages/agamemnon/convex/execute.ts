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
import pg from "pg";

/**
 * The ONLY holder of the Postgres credential.
 *
 * The connection string lives solely in the Convex environment variable
 * AGAMEMNON_DATABASE_URL — never in the agent's environment, never printed.
 * Because this runs in Agamemnon's LOCAL deployment, it can reach the local
 * Postgres; nothing else in the agent's process can.
 *
 * Phase 1 uses only countMatching (measuring true blast radius). The
 * destructive snapshot/delete/undo operations arrive in Phase 4.
 */

function connectionString(): string {
  const url = process.env.AGAMEMNON_DATABASE_URL;
  if (!url) {
    throw new Error(
      "AGAMEMNON_DATABASE_URL is not set in the Convex environment. " +
        "Run: npm run convex:pushenv (sets it from .env without printing it).",
    );
  }
  return url;
}

// A target must be a bare identifier we recognise. This guards the COUNT/DELETE
// table name specifically; the agent-controlled predicate is checked by policy,
// and every destructive path is snapshot-backed and reversible.
const KNOWN_TARGETS = new Set(["loads", "bookings"]);
function assertTarget(target: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(target) || !KNOWN_TARGETS.has(target)) {
    throw new Error(`refusing to operate on unrecognised target "${target}"`);
  }
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

/**
 * Measure the TRUE blast radius of a proposed delete using Agamemnon's own
 * credential — independent of whatever the agent claimed. Also returns the
 * table total so the heuristic can compute a blast-radius fraction.
 */
export const countMatching = internalAction({
  args: { target: v.string(), predicate: v.string() },
  handler: async (_ctx, { target, predicate }): Promise<{ matchingRows: number; totalRows: number }> => {
    assertTarget(target);
    return withClient(async (c) => {
      const matching = await c.query(`SELECT count(*)::bigint AS n FROM ${target} WHERE ${predicate}`);
      const total = await c.query(`SELECT count(*)::bigint AS n FROM ${target}`);
      return {
        matchingRows: Number(matching.rows[0].n),
        totalRows: Number(total.rows[0].n),
      };
    });
  },
});

/**
 * REVERSIBLE destructive execution. Before deleting anything:
 *   1. lock + select the exact matching rows,
 *   2. reconcile the real count against the estimate (halt if it diverges),
 *   3. serialise the rows to JSON in Convex file storage,
 *   4. commit the undo plan,
 * and ONLY THEN delete — by the captured ids, so the snapshot is exactly the
 * set removed. All in one Postgres transaction. No mocked deletes.
 */
export const snapshotAndDelete = internalAction({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }): Promise<void> => {
    const a = await ctx.runQuery(internal.core.actionForExecution, { actionId });
    if (!a) throw new Error("unknown action");
    assertTarget(a.target);
    await ctx.runMutation(internal.core.markExecuting, { actionId });
  // build-ref AGMN-I3F1SOIJLKZZ

    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await client.query("BEGIN");
      const sel = await client.query(`SELECT * FROM ${a.target} WHERE ${a.predicate} FOR UPDATE`);
      const rows = sel.rows;
      const columns = sel.fields.map((f) => f.name);

      // Reconcile BEFORE deleting; halt the run if reality diverges from the estimate.
      if (a.estimatedRows > 0 && Math.abs(rows.length - a.estimatedRows) / a.estimatedRows > 0.05) {
        await client.query("ROLLBACK");
        await ctx.runMutation(internal.core.markFailed, {
          actionId,
          error: `reconcile halt: matched ${rows.length} rows but estimate was ${a.estimatedRows} (>5% divergence) — nothing deleted`,
        });
        return;
      }

      // Snapshot to Convex file storage, then commit the undo plan.
      const blob = new Blob([JSON.stringify({ target: a.target, columns, rows })], {
        type: "application/json",
      });
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.core.commitUndoPlan, {
        actionId,
        target: a.target,
        storageId,
        rowCount: rows.length,
      });

      // Only now delete — by captured ids, so snapshot == deleted set exactly.
      const ids = rows.map((r: any) => r.id);
      const del = await client.query(`DELETE FROM ${a.target} WHERE id = ANY($1::bigint[])`, [ids]);
      await client.query("COMMIT");
      await ctx.runMutation(internal.core.markExecuted, { actionId, actualRows: del.rowCount ?? 0 });
    } catch (e: any) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      await ctx.runMutation(internal.core.markFailed, { actionId, error: e?.message ?? String(e) });
    } finally {
      await client.end();
    }
  },
});

/**
 * Undo: replay the stored snapshot as an insert (restoring exact ids), and
 * record it as a NEW audited action with its own approval record. Public so the
 * operator console can invoke it directly.
 */
export const undo = action({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }): Promise<{ restored: number }> => {
    const plan = await ctx.runQuery(internal.core.undoPlanForAction, { actionId });
    if (!plan) throw new Error("no undo plan for this action");
    if (plan.applied) return { restored: 0 };
    assertTarget(plan.target);

    const blob = await ctx.storage.get(plan.storageId);
    if (!blob) throw new Error("snapshot blob missing");
    const snapshot = JSON.parse(await blob.text()) as {
      target: string;
      columns: string[];
      rows: Record<string, any>[];
    };
    const { columns, rows } = snapshot;
    if (rows.length === 0) return { restored: 0 };

    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      // Multi-row parameterized insert, overriding the identity so ids match.
      const colList = columns.map((c) => `"${c}"`).join(", ");
      const values: any[] = [];
      const tuples = rows.map((row, i) => {
        const placeholders = columns.map((_, j) => `$${i * columns.length + j + 1}`);
        columns.forEach((c) => values.push(row[c]));
        return `(${placeholders.join(", ")})`;
      });
      const sql = `INSERT INTO ${plan.target} (${colList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(", ")}`;
      const res = await client.query(sql, values);
      const restored = res.rowCount ?? rows.length;
      await ctx.runMutation(internal.core.recordUndoAction, {
        originalActionId: actionId,
        restoredRows: restored,
      });
      return { restored };
    } finally {
      await client.end();
    }
  },
});
