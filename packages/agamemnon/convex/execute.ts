"use node";
import { internalAction } from "./_generated/server";
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
