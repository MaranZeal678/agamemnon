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

import { parse } from "libpg-query";
import { classifyOversight } from "@agamemnon/kernel";

/**
 * Migration checks — parsed with libpg_query, one finding per rule ID.
 * The rule set follows the well-known Postgres migration hazards that squawk,
 * Atlas lint and strong_migrations document (credited), plus the oversight
 * class (disabling RLS, dropping policies, touching audit tables).
 */

export type Severity = "error" | "warning";
export interface MigrationFinding {
  id: string;
  severity: Severity;
  statement: number;
  message: string;
  fix?: string;
}

const rel = (r: any) => (r?.schemaname ? `${r.schemaname}.${r.relname}` : String(r?.relname ?? "?"));

export async function checkMigration(sql: string): Promise<{ statements: number; findings: MigrationFinding[] }> {
  let tree: any;
  try {
    tree = await parse(sql);
  } catch (e: any) {
    return { statements: 0, findings: [{ id: "AGM-SQL-000", severity: "error", statement: 0, message: `does not parse: ${e?.message ?? e}` }] };
  }
  const stmts = tree.stmts ?? [];
  const findings: MigrationFinding[] = [];
  let lockTimeoutSet = false;
  const add = (f: MigrationFinding) => findings.push(f);
  stmts.forEach((st: any, idx: number) => {
    const n = idx + 1;
    const [kind] = Object.keys(st.stmt);
    const s = st.stmt[kind];
    const text = sql.slice(st.stmt_location ?? 0, (st.stmt_location ?? 0) + (st.stmt_len ?? sql.length)).trim();
    if (kind === "VariableSetStmt" && s.name === "lock_timeout") lockTimeoutSet = true;
    if (kind === "DropStmt" && s.removeType === "OBJECT_TABLE") add({ id: "AGM-DDL-001", severity: "error", statement: n, message: "DROP TABLE destroys data irreversibly", fix: "rename the table first (ALTER TABLE … RENAME TO _trash_…) and drop it in a later release" });
    if (kind === "DropStmt" && s.behavior === "DROP_CASCADE") add({ id: "AGM-DDL-013", severity: "error", statement: n, message: "DROP … CASCADE removes dependants you did not list", fix: "drop dependants explicitly" });
    if (kind === "TruncateStmt") add({ id: "AGM-DDL-003", severity: "error", statement: n, message: "TRUNCATE cannot be snapshotted or undone row by row", fix: "use DELETE in batches" });
    if (kind === "AlterTableStmt") {
      for (const c of s.cmds ?? []) {
        const cmd = c.AlterTableCmd ?? {};
        const t = rel(s.relation);
        if (cmd.subtype === "AT_DropColumn") add({ id: "AGM-DDL-002", severity: "error", statement: n, message: `dropping column ${t}.${cmd.name} loses data and breaks running code`, fix: "stop reading it in code first; drop it in a later release" });
        if (cmd.subtype === "AT_AlterColumnType") add({ id: "AGM-DDL-004", severity: "warning", statement: n, message: `changing the type of ${t}.${cmd.name} rewrites the table under an ACCESS EXCLUSIVE lock`, fix: "add a new column, backfill, swap" });
        if (cmd.subtype === "AT_SetNotNull") add({ id: "AGM-DDL-008", severity: "warning", statement: n, message: `SET NOT NULL on ${t}.${cmd.name} scans the whole table under lock`, fix: "add a CHECK (… IS NOT NULL) NOT VALID constraint, VALIDATE it, then SET NOT NULL" });
        if (cmd.subtype === "AT_AddColumn") {
          const def = cmd.def?.ColumnDef ?? {};
          const cons = (def.constraints ?? []).map((x: any) => x.Constraint?.contype);
          if (cons.includes("CONSTR_NOTNULL") && !cons.includes("CONSTR_DEFAULT")) add({ id: "AGM-DDL-005", severity: "error", statement: n, message: `adding NOT NULL column ${t}.${def.colname} without a default fails on existing rows`, fix: "add it nullable or with a DEFAULT" });
        }
        if (cmd.subtype === "AT_DisableRowSecurity" || cmd.subtype === "AT_NoForceRowSecurity") add({ id: "AGM-OVS-009", severity: "error", statement: n, message: `disables row-level security on ${t} (oversight-reducing)`, fix: "needs two human approvals through Agamemnon" });
        if (cmd.subtype === "AT_DisableTrig" || cmd.subtype === "AT_DisableTrigAll" || cmd.subtype === "AT_DisableTrigUser") add({ id: "AGM-OVS-010", severity: "error", statement: n, message: `disables triggers on ${t} (oversight-reducing)` });
      }
    }
    if (kind === "RenameStmt") add({ id: "AGM-DDL-007", severity: "warning", statement: n, message: `renaming ${s.renameType?.replace("OBJECT_", "").toLowerCase() ?? "object"} breaks code that still uses the old name`, fix: "expand/contract: add the new name, migrate readers, then remove the old" });
    if (kind === "IndexStmt" && !s.concurrent) add({ id: "AGM-DDL-006", severity: "warning", statement: n, message: `CREATE INDEX on ${rel(s.relation)} without CONCURRENTLY blocks writes`, fix: "CREATE INDEX CONCURRENTLY (outside a transaction)" });
    if ((kind === "DeleteStmt" || kind === "UpdateStmt") && !s.whereClause) add({ id: "AGM-DML-011", severity: "error", statement: n, message: `${kind === "DeleteStmt" ? "DELETE" : "UPDATE"} on ${rel(s.relation)} without WHERE touches every row` });
    if (kind === "GrantStmt" && JSON.stringify(s).includes("PUBLIC")) add({ id: "AGM-SEC-012", severity: "error", statement: n, message: "grants privileges to PUBLIC" });
    if (kind === "AlterRoleStmt" && /SUPERUSER|BYPASSRLS/i.test(text)) add({ id: "AGM-SEC-014", severity: "error", statement: n, message: "grants SUPERUSER / BYPASSRLS" });
    for (const f of classifyOversight({ system: "postgres", operation: "sql", statement: text })) {
      if (!findings.some((x) => x.statement === n && x.id.startsWith("AGM-OVS"))) add({ id: "AGM-OVS-015", severity: "error", statement: n, message: `${f.rule}: ${f.detail}` });
    }
  });
  const needsLock = stmts.some((st: any) => ["AlterTableStmt", "IndexStmt", "DropStmt", "RenameStmt"].includes(Object.keys(st.stmt)[0]));
  if (needsLock && !lockTimeoutSet) add({ id: "AGM-DDL-016", severity: "warning", statement: 0, message: "schema changes without SET lock_timeout can queue behind a long query and block all traffic", fix: "start the file with SET lock_timeout = '5s';" });
  return { statements: stmts.length, findings };
}
