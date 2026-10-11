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

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { run } from "../src/cli.ts";
import { checkMigration } from "../src/migration.ts";
import { hardenSql } from "../src/harden.ts";
import { sweep } from "../src/sweep.ts";

const quiet = () => {
  const out: string[] = [];
  return { out, print: (s: string) => void out.push(s) };
};

describe("agamemnon init", () => {
  it("writes Claude Code + Cursor hooks, the MCP entry, and denies agents read access to secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agm-init-"));
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
    const q = quiet();
    expect(await run(["init", "--dir", dir, "--agents", "claude,cursor", "--broker", "http://127.0.0.1:7700"], q.print)).toBe(0);
    const s = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(s.permissions.allow).toEqual(["Bash(npm test)"]); // preserved
    expect(s.permissions.deny).toContain("Read(./.env)");
    expect(JSON.stringify(s.hooks.PreToolUse)).toContain("agamemnon-hook");
    const cursor = JSON.parse(readFileSync(join(dir, ".cursor/hooks.json"), "utf8"));
    expect(cursor.hooks.beforeShellExecution[0].command).toContain("--agent cursor");
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.agamemnon.env.AGAMEMNON_AGENT_TOKEN).toBe("${AGAMEMNON_AGENT_TOKEN}");
    // idempotent
    await run(["init", "--dir", dir, "--agents", "claude,cursor"], q.print);
    expect(JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")).hooks.PreToolUse).toHaveLength(1);
  });
});

describe("agamemnon sweep", () => {
  it("finds the stray platform token and DB URL an agent could use to bypass the broker (PocketOS)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agm-sweep-"));
    writeFileSync(join(dir, ".env"), "DATABASE_URL=postgres://app:s3cretpassw0rd@db.prod.internal:5432/app\nSAFE_URL=postgres://app:agm_ph_0011223344556677@db:5432/app\n");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/domains.sh"), "export RAILWAY_TOKEN=3f2a9c1e-77b1-4c2d-9e0f-1234567890ab\n");
    const hits = sweep(dir);
    expect(hits.map((h) => h.kind).sort()).toEqual(["postgres-url", "railway-token"]);
    expect(hits[0].preview).not.toContain("s3cretpassw0rd");
  });
});

describe("agamemnon check-migration", () => {
  it("fails CI on destructive and oversight-reducing statements, warns on locking ones", async () => {
    const r = await checkMigration(`
      ALTER TABLE invoices ADD COLUMN region text NOT NULL;
      CREATE INDEX idx_inv_region ON invoices(region);
      ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;
      DROP TABLE legacy_payments;
      DELETE FROM sessions;`);
    const ids = r.findings.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["AGM-DDL-005", "AGM-DDL-006", "AGM-OVS-009", "AGM-DDL-001", "AGM-DML-011", "AGM-DDL-016"]));
    const dir = mkdtempSync(join(tmpdir(), "agm-mig-"));
    writeFileSync(join(dir, "m.sql"), "DROP TABLE legacy_payments;");
    expect(await run(["check-migration", join(dir, "m.sql")], quiet().print)).toBe(1);
    writeFileSync(join(dir, "ok.sql"), "SET lock_timeout = '5s';\nCREATE INDEX CONCURRENTLY idx ON t(c);");
    expect(await run(["check-migration", join(dir, "ok.sql")], quiet().print)).toBe(0);
  });
});

const ADMIN = process.env.AGM_TEST_PG_ADMIN_URL ?? "postgres://127.0.0.1:5432/postgres";
let pgUp = false;
try {
  const cl = new pg.Client({ connectionString: ADMIN, connectionTimeoutMillis: 1500 });
  await cl.connect();
  await cl.end();
  pgUp = true;
} catch {
  pgUp = false;
}

(pgUp ? describe : describe.skip)("agamemnon harden-db (live Postgres)", () => {
  it("the row cap stops a mass delete from the app credential but not from the broker's session", async () => {
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = 'agamemnon_cli_test'")).rowCount) await admin.query("CREATE DATABASE agamemnon_cli_test");
    await admin.end();
    const db = new pg.Client({ connectionString: "postgres://127.0.0.1:5432/agamemnon_cli_test" });
    await db.connect();
    try {
      await db.query("DROP TABLE IF EXISTS widgets; CREATE TABLE widgets (id int PRIMARY KEY); INSERT INTO widgets SELECT generate_series(1, 500);");
      await db.query(hardenSql({ tables: ["widgets"], cap: 100, brokerRole: "agamemnon_svc" }));
      await expect(db.query("DELETE FROM widgets")).rejects.toThrow(/exceeds the row cap of 100/);
      await db.query("DELETE FROM widgets WHERE id <= 50"); // under the cap
      expect(Number((await db.query("SELECT count(*) AS n FROM widgets")).rows[0].n)).toBe(450);
    } finally {
      await db.end();
    }
  });
});
