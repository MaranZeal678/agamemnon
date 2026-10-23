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

import pg from "pg";
import { randomBytes } from "node:crypto";
import { parse } from "libpg-query";
import {
  classifyOversight,
  decide,
  hashOf,
  isForbiddenFunction,
  isSafeIdentifier,
  median,
  planRevert,
  type EffectRequest,
  type FiredRule,
  type Thresholds,
  type TrustLabel,
  type WriteRecord,
} from "@agamemnon/kernel";
import { ConnectorError, type Compensated, type Connector, type ConnectorContext, type Executed, type Prepared } from "./types.ts";
import type { EffectRow } from "../store.ts";

/**
 * Postgres connector — statements are parsed with libpg_query (the real
 * Postgres parser), never pattern-matched. Supported effects:
 *
 *   DELETE / UPDATE  exact preview (the primary-key set), precondition = hash
 *                    of that set; executed by primary key under a per-request
 *                    role after re-checking the set inside the transaction;
 *                    before-images kept → undo and selective revert.
 *   INSERT           exact count (VALUES) or estimated (INSERT … SELECT);
 *                    inserted keys recorded → undo.
 *   DROP TABLE       becomes a rename into a trash name (undo = rename back).
 *   TRUNCATE / COPY  refused — use DELETE (snapshotted) / postgres.query.
 *   other DDL        irreversible → two humans; runs with lock_timeout.
 *   SELECT           read path: READ ONLY, row cap, PII masking, taint labels;
 *                    bulk reads need approval (export is treated as a write).
 *
 * Defence in depth does not rely on the parser alone: measurement runs in
 * BEGIN READ ONLY, every statement uses the extended protocol (one statement
 * only), and execution runs under a role that exists for one transaction.
 */

export interface PgTableConfig {
  /** Column holding the tenant id; tasks scoped to a tenant may only touch their rows. */
  tenantColumn?: string;
  private?: boolean; // contains personal / sensitive data
  untrusted?: boolean; // contains externally-submitted text (tickets, comments)
  piiColumns?: string[];
  readApprovalRows?: number;
}

export interface PgConnectionConfig {
  secret: string; // vault secret holding the service connection URL
  ddlSecret?: string; // vault secret for an owner-level connection (DDL only)
  allowlist: string[];
  tables?: Record<string, PgTableConfig>;
  thresholds?: Partial<Thresholds>;
  defaultMedian?: number;
  readRowCap?: number;
}

const MEASURE_TIMEOUT_MS = 15000;
const EXEC_TIMEOUT_MS = 60000;
const MAX_KEYS = 1_000_000;
const MAX_PARAMS = 60000;

const ident = (n: string) => {
  if (!isSafeIdentifier(n)) throw new ConnectorError("unsafe-identifier", `refusing unsafe identifier "${n}"`);
  return `"${n}"`;
};
const q = (c: pg.Client, text: string, values: unknown[] = []) => c.query({ text, values, queryMode: "extended" } as any);

function encodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { $bytea: v.toString("base64") };
  if (v instanceof Date) return v.toISOString();
  return v;
}
export function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) o[k] = encodeValue(v);
  return o;
}
function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && typeof (v as any).$bytea === "string") return Buffer.from((v as any).$bytea, "base64");
  if (v && typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}
export const rowHash = (row: Record<string, unknown>) => hashOf(encodeRow(row));

// ── AST helpers ──────────────────────────────────────────────────────────────
function walk(node: unknown, fn: (key: string, value: any, parent: any) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, fn));
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      fn(k, v, node);
      walk(v, fn);
    }
  }
}
function locations(node: unknown): number[] {
  const out: number[] = [];
  walk(node, (k, v) => {
    if (k === "location" && typeof v === "number" && v >= 0) out.push(v);
  });
  return out;
}
function relationsIn(node: unknown): Array<{ schema?: string; name: string }> {
  // RangeVars appear both wrapped ({ RangeVar: {...} } in FROM lists) and bare
  // (the `relation` of DELETE / UPDATE / INSERT) — match on the shape, not the key.
  const out: Array<{ schema?: string; name: string }> = [];
  walk(node, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.relname === "string") out.push({ schema: v.schemaname, name: String(v.relname).toLowerCase() });
  });
  return out;
}
function functionsIn(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (k, v) => {
    if (k === "FuncCall") {
      const parts = (v?.funcname ?? []).map((p: any) => p?.String?.sval).filter(Boolean);
      if (parts.length) out.push(String(parts[parts.length - 1]));
    }
  });
  return out;
}
function hasNested(node: unknown, kinds: string[]): boolean {
  let found = false;
  walk(node, (k) => {
    if (kinds.includes(k)) found = true;
  });
  return found;
}
/** Shape fingerprint: the AST without positions or literal values. */
export function astFingerprint(stmt: unknown): string {
  const strip = (n: any): any => {
    if (Array.isArray(n)) return n.map(strip);
    if (n && typeof n === "object") {
      const o: any = {};
      for (const [k, v] of Object.entries(n)) {
        if (k === "location" || k === "stmt_location" || k === "stmt_len") continue;
        if (k === "A_Const") {
          o[k] = "?";
          continue;
        }
        o[k] = strip(v);
      }
      return o;
    }
    return n;
  };
  return hashOf(strip(stmt));
}

/** Text of the clause introduced by `keyword` whose expression subtree is `clause`. */
function clauseText(sql: string, keyword: RegExp, clause: unknown, endNode?: unknown, endKeyword?: RegExp): string {
  const locs = locations(clause);
  if (!locs.length) throw new ConnectorError("unparseable", "could not locate clause");
  const start = Math.min(...locs);
  const head = sql.slice(0, start);
  let kwEnd = -1;
  for (const m of head.matchAll(new RegExp(keyword.source, "gi"))) kwEnd = (m.index ?? 0) + m[0].length;
  if (kwEnd < 0) throw new ConnectorError("unparseable", "could not locate clause keyword");
  let end = sql.length;
  if (endNode) {
    const endLocs = locations(endNode);
    if (endLocs.length && endKeyword) {
      const first = Math.min(...endLocs);
      let kw = -1;
      for (const m of sql.slice(0, first).matchAll(new RegExp(endKeyword.source, "gi"))) kw = m.index ?? -1;
      if (kw > kwEnd) end = kw;
    }
  }
  return sql.slice(kwEnd, end).trim().replace(/;\s*$/, "");
}

interface Analysed {
  kind: "delete" | "update" | "insert" | "drop" | "truncate" | "copy" | "select" | "ddl";
  table?: string;
  tables?: string[];
  where?: string;
  set?: string;
  setConstColumns?: string[];
  referenced: string[];
  insertRows?: number;
  /** The parsed INSERT / UPDATE node — read by the write-side tenant check. */
  stmt?: any;
  fingerprint: string;
  sql: string;
  statementName: string;
}

export async function analyse(sql: string, allowlist: string[]): Promise<Analysed> {
  let tree: any;
  try {
    tree = await parse(sql);
  } catch (e: any) {
    throw new ConnectorError("parse-error", `not valid SQL: ${e?.message ?? e}`);
  }
  const stmts = tree?.stmts ?? [];
  if (stmts.length !== 1) throw new ConnectorError("multi-statement", `exactly one statement is allowed (got ${stmts.length})`);
  const stmtNode = stmts[0].stmt;
  const statementName = Object.keys(stmtNode)[0];
  const s = stmtNode[statementName];
  const clean = sql.trim().replace(/;\s*$/, "");
  const fingerprint = astFingerprint(stmtNode);

  for (const fn of functionsIn(stmtNode)) {
    if (isForbiddenFunction(fn)) throw new ConnectorError("forbidden-function", `function ${fn}() is not allowed`);
  }
  const rels = relationsIn(stmtNode);
  for (const r of rels) {
    if (r.schema && r.schema !== "public") throw new ConnectorError("foreign-schema", `only the public schema is reachable (saw ${r.schema}.${r.name})`);
  }
  const allowed = new Set(allowlist.map((t) => t.toLowerCase()));
  const notAllowed = rels.map((r) => r.name).filter((n) => !allowed.has(n));
  const referenced = [...new Set(rels.map((r) => r.name))];

  const requireAllowed = () => {
    if (notAllowed.length) throw new ConnectorError("table-not-allowed", `not on the allowlist: ${[...new Set(notAllowed)].join(", ")}`);
  };

  switch (statementName) {
    case "DeleteStmt": {
      requireAllowed();
      if (s.withClause) throw new ConnectorError("unsupported-shape", "WITH … DELETE is not supported; use a subquery");
      if (s.usingClause?.length) throw new ConnectorError("unsupported-shape", "DELETE … USING is not supported; use WHERE … IN (subquery)");
      const table = String(s.relation.relname).toLowerCase();
      if (!s.whereClause) return { kind: "delete", table, where: "TRUE", referenced, fingerprint, sql: clean, statementName };
      if (hasNested(s.whereClause, ["DeleteStmt", "UpdateStmt", "InsertStmt"])) throw new ConnectorError("nested-dml", "data-modifying statements inside a predicate are not allowed");
      const where = clauseText(clean, /\bwhere\b/, s.whereClause, s.returningList, /\breturning\b/);
      return { kind: "delete", table, where, referenced, fingerprint, sql: clean, statementName };
    }
    case "UpdateStmt": {
      requireAllowed();
      if (s.withClause) throw new ConnectorError("unsupported-shape", "WITH … UPDATE is not supported");
      if (s.fromClause?.length) throw new ConnectorError("unsupported-shape", "UPDATE … FROM is not supported; use a subquery in WHERE");
      const table = String(s.relation.relname).toLowerCase();
      if (hasNested(s, ["DeleteStmt", "InsertStmt"]) || (s.whereClause && hasNested(s.whereClause, ["UpdateStmt"]))) {
        throw new ConnectorError("nested-dml", "data-modifying statements inside an UPDATE are not allowed");
      }
      const setLocs = locations(s.targetList);
      const setStart = Math.min(...setLocs);
      let setKw = -1;
      for (const m of clean.slice(0, setStart).matchAll(/\bset\b/gi)) setKw = (m.index ?? 0) + m[0].length;
      const setEnd = s.whereClause
        ? (() => {
            const w = Math.min(...locations(s.whereClause));
            let kw = clean.length;
            for (const m of clean.slice(0, w).matchAll(/\bwhere\b/gi)) kw = m.index ?? kw;
            return kw;
          })()
        : s.returningList
          ? (() => {
              const r = Math.min(...locations(s.returningList));
              let kw = clean.length;
              for (const m of clean.slice(0, r).matchAll(/\breturning\b/gi)) kw = m.index ?? kw;
              return kw;
            })()
          : clean.length;
      const set = clean.slice(setKw, setEnd).trim();
      const where = s.whereClause ? clauseText(clean, /\bwhere\b/, s.whereClause, s.returningList, /\breturning\b/) : "TRUE";
      const setConstColumns = (s.targetList ?? [])
        .filter((t: any) => t?.ResTarget?.val?.A_Const)
        .map((t: any) => String(t.ResTarget.name));
      return { kind: "update", table, where, set, setConstColumns, stmt: s, referenced, fingerprint, sql: clean, statementName };
    }
    case "InsertStmt": {
      requireAllowed();
      if (s.withClause) throw new ConnectorError("unsupported-shape", "WITH … INSERT is not supported");
      const table = String(s.relation.relname).toLowerCase();
      const values = s.selectStmt?.SelectStmt?.valuesLists;
      const insertRows = Array.isArray(values) ? values.length : undefined;
      return { kind: "insert", table, insertRows, stmt: s, referenced, fingerprint, sql: clean, statementName };
    }
    case "DropStmt": {
      if (s.removeType !== "OBJECT_TABLE") return { kind: "ddl", referenced, fingerprint, sql: clean, statementName };
      requireAllowed();
      const tables = (s.objects ?? []).map((o: any) => {
        const parts = (o?.List?.items ?? []).map((i: any) => i?.String?.sval);
        return String(parts[parts.length - 1]).toLowerCase();
      });
      if (s.behavior === "DROP_CASCADE") throw new ConnectorError("cascade-drop", "DROP … CASCADE is refused — drop dependants explicitly");
      return { kind: "drop", tables, referenced: tables, fingerprint, sql: clean, statementName };
    }
    case "TruncateStmt":
      throw new ConnectorError("truncate-refused", "TRUNCATE cannot be snapshotted — use DELETE so the rows can be restored");
    case "CopyStmt":
      throw new ConnectorError("export-verb", "COPY is a bulk export/import verb — use postgres.query (reads go through approval)");
    case "SelectStmt": {
      requireAllowed();
      if (s.intoClause) throw new ConnectorError("unsupported-shape", "SELECT … INTO writes a table — not a read");
      if (s.lockingClause?.length) throw new ConnectorError("unsupported-shape", "SELECT … FOR UPDATE takes locks — not allowed on the read path");
      if (hasNested(s, ["DeleteStmt", "UpdateStmt", "InsertStmt"])) throw new ConnectorError("nested-dml", "data-modifying CTEs are not reads");
      return { kind: "select", referenced, fingerprint, sql: clean, statementName };
    }
    case "TransactionStmt":
    case "VariableSetStmt":
    case "DoStmt":
    case "CallStmt":
    case "ExecuteStmt":
    case "PrepareStmt":
      throw new ConnectorError("statement-refused", `${statementName} is not allowed through the broker`);
    default:
      if (rels.length) requireAllowed();
      return { kind: "ddl", referenced, fingerprint, sql: clean, statementName };
  }
}

/** Text of a bare literal as `::text` would render it; null for NULL, undefined for anything that is not a literal. */
function constText(node: any): string | null | undefined {
  const k = node?.A_Const;
  if (!k) return undefined;
  if (k.isnull) return null;
  if (k.ival) return String(k.ival.ival ?? 0);
  if (k.fval) return String(k.fval.fval);
  if (k.sval) return String(k.sval.sval ?? "");
  if (k.boolval) return String(k.boolval.boolval ?? false);
  return undefined;
}

/**
 * Write-side tenant check: the VALUES an INSERT writes, or the value an UPDATE
 * assigns to the tenant column, must be a literal equal to the task's tenant.
 * Anything the parser cannot pin to a literal fails closed. Returns why it is
 * refused, or null.
 */
function foreignTenantWrite(a: Analysed, tcol: string, tenant: string): string | null {
  const col = tcol.toLowerCase();
  const s = a.stmt;
  const assigns = (targetList: any[] | undefined, verb: string): string | null => {
    for (const t of targetList ?? []) {
      const r = t?.ResTarget;
      if (String(r?.name ?? "").toLowerCase() !== col) continue;
      const v = r.indirection ? undefined : constText(r.val);
      if (v === undefined) return `${verb} assigns ${tcol} from a non-literal expression — the tenant it writes cannot be verified`;
      if (v !== tenant) return `${verb} sets ${tcol} to ${v === null ? "NULL" : `"${v}"`} — the rows would move out of tenant "${tenant}"`;
    }
    return null;
  };
  if (a.kind === "update") return assigns(s?.targetList, "UPDATE");
  if (a.kind === "insert") {
    const cols = (s?.cols ?? []).map((c: any) => c?.ResTarget);
    if (!cols.length) return `INSERT without a column list — name ${tcol} explicitly so the tenant it writes can be verified`;
    const idx = cols.findIndex((c: any) => String(c?.name ?? "").toLowerCase() === col);
    if (idx < 0) return `INSERT omits ${tcol} — its value would come from a default, not the task's tenant "${tenant}"`;
    const values = s.selectStmt?.SelectStmt?.valuesLists;
    if (!Array.isArray(values)) return `INSERT … SELECT into a tenant-scoped table — the ${tcol} values it writes cannot be verified before execution`;
    let foreign = 0;
    for (const [n, row] of values.entries()) {
      const v = cols[idx].indirection ? undefined : constText(row?.List?.items?.[idx]);
      if (v === undefined) return `${tcol} in inserted row ${n + 1} is not a literal — the tenant it writes cannot be verified`;
      if (v !== tenant) foreign++;
    }
    if (foreign) return `${foreign.toLocaleString()} inserted row(s) set ${tcol} to a tenant other than "${tenant}"`;
    const oc = s.onConflictClause;
    if (oc?.action === "ONCONFLICT_UPDATE") {
      // The row DO UPDATE changes is whichever existing row conflicts — it can belong to
      // any tenant, so even an update that leaves ${tcol} alone is refused.
      return assigns(oc.targetList, "ON CONFLICT DO UPDATE") ?? `ON CONFLICT DO UPDATE would change whichever existing row conflicts, which may belong to a tenant other than "${tenant}"`;
    }
    return null;
  }
  return null;
}

export class PostgresConnector implements Connector {
  readonly system = "postgres";
  readonly operations = ["postgres.sql", "postgres.query"];

  private config(req: EffectRequest, ctx: ConnectorContext): { name: string; cfg: PgConnectionConfig; env: string | null; fingerprint: string | null } {
    const name = String(req.params.connection ?? req.target.resource ?? "default").split("/")[0];
    const t = ctx.store.target("postgres", `connection:${name}`);
    if (!t?.config) throw new ConnectorError("target-unregistered", `postgres connection "${name}" is not registered with the broker`);
    return { name, cfg: t.config as PgConnectionConfig, env: t.env, fingerprint: t.fingerprint };
  }

  private async client(ctx: ConnectorContext, secret: string, expectedFingerprint: string | null): Promise<pg.Client> {
    const url = ctx.vault.get(secret);
    if (!url) throw new ConnectorError("no-credential", `vault has no secret "${secret}"`);
    if (expectedFingerprint) {
      const u = new URL(url);
      const fp = `${u.hostname}:${u.port || "5432"}${u.pathname}`;
      if (fp !== expectedFingerprint) {
        throw new ConnectorError("target-fingerprint-mismatch", `credential "${secret}" now points at ${fp}, but the registered target is ${expectedFingerprint}`);
      }
    }
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return c;
  }

  private agentMedian(ctx: ConnectorContext, agent: string, object: string, fallback: number): number {
    const xs = ctx.store
      .ledger(30 * 24 * 3600 * 1000)
      .filter((e) => e.agent === agent && e.object === object && e.rows > 0)
      .map((e) => e.rows);
    return xs.length >= 5 ? median(xs) : fallback;
  }

  async prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared> {
    const { name, cfg, env, fingerprint } = this.config(req, ctx);
    const sql = String(req.params.sql ?? "");
    if (!sql) throw new ConnectorError("missing-sql", "params.sql is required");
    const a = await analyse(sql, cfg.allowlist);
    if (req.operation === "postgres.query" && a.kind !== "select") throw new ConnectorError("not-a-read", "postgres.query only accepts SELECT");
    if (req.operation === "postgres.sql" && a.kind === "select") throw new ConnectorError("use-query", "use postgres.query for reads");

    const table = a.table ?? a.tables?.[0] ?? a.referenced[0] ?? "(statement)";
    const object = `postgres:${name}/${table}`;
    const scopeTenant = req.target.tenant;
    const target = { system: "postgres", resource: `${name}/${table}`, env: env ?? undefined, tenant: scopeTenant };
    const oversight = classifyOversight({ system: "postgres", operation: "sql", statement: a.sql });
    const rules: FiredRule[] = [];
    const base = {
      request: { ...req, target },
      oversight,
      creates: [],
      egress: false,
      reads: a.referenced.map((t) => `postgres:${name}/${t}`),
    };
    const c = await this.client(ctx, cfg.secret, fingerprint);
    try {
      await q(c, "BEGIN READ ONLY");
      await q(c, `SET LOCAL statement_timeout = ${MEASURE_TIMEOUT_MS}`);
      try {
        if (a.kind === "select") {
          const cnt = Number((await q(c, `SELECT count(*)::bigint AS n FROM (${a.sql}) agm_q`)).rows[0].n);
          const tcfg = a.referenced.map((t) => cfg.tables?.[t] ?? {});
          const priv = tcfg.some((t) => t.private || (t.piiColumns?.length ?? 0) > 0);
          const untrusted = tcfg.some((t) => t.untrusted);
          const threshold = Math.min(...tcfg.map((t) => t.readApprovalRows ?? 1000), 1000);
          if (cnt > threshold) rules.push({ name: "bulk-read", severity: "approval", detail: `reads ${cnt.toLocaleString()} rows (>${threshold}) — bulk export is treated as a write` });
          if (priv && cnt > 100) rules.push({ name: "bulk-private-read", severity: "approval", detail: `reads ${cnt.toLocaleString()} rows from tables holding personal data` });
          const labels: TrustLabel[] = untrusted ? ["untrusted"] : ["internal"];
          return {
            effect: { ...base, reversibility: "undo", preview: { summary: `read ${cnt.toLocaleString()} rows`, counts: { rows: cnt }, fidelity: "exact" }, precondition: `read:${a.fingerprint}`, writes: [], readsPrivate: priv },
            connectorRules: rules,
            internal: { kind: "select", connection: name, sql: a.sql, referenced: a.referenced, fingerprint: a.fingerprint, tenant: scopeTenant ?? null },
            readLabels: { labels, private: priv, source: `postgres:${name}/${a.referenced.join(",")}` },
          };
        }

        if (a.kind === "delete" || a.kind === "update") {
          const tbl = a.table!;
          const pk = await this.singlePk(c, tbl);
          const keys = (await q(c, `SELECT ${ident(pk)}::text AS k FROM ${ident(tbl)} WHERE ${a.where} LIMIT ${MAX_KEYS + 1}`)).rows.map((r: any) => r.k as string);
          if (keys.length > MAX_KEYS) throw new ConnectorError("too-large", `more than ${MAX_KEYS.toLocaleString()} rows — split the change`);
          const total = Number((await q(c, `SELECT count(*)::bigint AS n FROM ${ident(tbl)}`)).rows[0].n);
          const tcol = cfg.tables?.[tbl]?.tenantColumn;
          if (scopeTenant && tcol) {
            const foreign = Number((await q(c, `SELECT count(*)::bigint AS n FROM ${ident(tbl)} WHERE (${a.where}) AND ${ident(tcol)}::text IS DISTINCT FROM $1`, [scopeTenant])).rows[0].n);
            if (foreign > 0) rules.push({ name: "cross-tenant", severity: "block", detail: `${foreign.toLocaleString()} matching row(s) belong to a tenant other than "${scopeTenant}"` });
            const why = foreignTenantWrite(a, tcol, String(scopeTenant));
            if (why) rules.push({ name: "cross-tenant", severity: "block", detail: why });
          }
          const sample = (await q(c, `SELECT * FROM ${ident(tbl)} WHERE ${a.where} LIMIT 5`)).rows.map((r: any) => this.mask(encodeRow(r), cfg.tables?.[tbl]));
          if (a.kind === "delete") {
            const children = await this.cascadingChildren(c, tbl);
            if (children.length) rules.push({ name: "cascade-blocked", severity: "block", detail: `deleting from ${tbl} would also change ${children.join(", ")} — the snapshot cannot cover cascades` });
            const trig = await this.triggers(c, tbl, 8);
            if (trig.length) rules.push({ name: "trigger-blocked", severity: "block", detail: `${tbl} has DELETE triggers (${trig.join(", ")}) whose side effects cannot be undone` });
          } else if ((a.setConstColumns?.length ?? 0) > 0 && keys.length > 50) {
            for (const col of a.setConstColumns!) {
              if (!isSafeIdentifier(col)) continue;
              const d = Number((await q(c, `SELECT count(DISTINCT ${ident(col)})::bigint AS n FROM ${ident(tbl)} WHERE ${a.where}`)).rows[0].n);
              if (d > 1) rules.push({ name: "value-collapse", severity: "approval", detail: `${d.toLocaleString()} distinct values of ${col} across ${keys.length.toLocaleString()} rows would all become one constant` });
            }
          }
          const policy = decide(
            { tool: `postgres.${a.kind}`, target: tbl, destructive: true, estimatedRows: keys.length },
            { allowlist: cfg.allowlist, agentMedian: this.agentMedian(ctx, req.requester.id, object, cfg.defaultMedian ?? 1000), perRunDestructiveRowsUsed: 0 },
            null,
            { thresholds: cfg.thresholds },
          );
          rules.push(...policy.firedRules);
          if (a.where === "TRUE") rules.push({ name: "unbounded-statement", severity: "approval", detail: `${a.kind.toUpperCase()} without WHERE touches every row of ${tbl}` });
          return {
            effect: {
              ...base,
              reversibility: "undo",
              preview: {
                summary: `${a.kind} ${keys.length.toLocaleString()} of ${total.toLocaleString()} rows in ${tbl}${a.kind === "update" ? ` (SET ${a.set})` : ""}`,
                counts: { rows: keys.length, total },
                fidelity: "exact",
                sample,
                details: { where: a.where, set: a.set ?? null },
              },
              precondition: hashOf({ table: tbl, keys: [...keys].sort() }),
              writes: [object],
            },
            connectorRules: rules,
            internal: { kind: a.kind, connection: name, table: tbl, pk, where: a.where, set: a.set ?? null, referenced: a.referenced.filter((t) => t !== tbl), fingerprint: a.fingerprint },
          };
        }

        if (a.kind === "insert") {
          const tcol = cfg.tables?.[a.table!]?.tenantColumn;
          if (scopeTenant && tcol) {
            const why = foreignTenantWrite(a, tcol, String(scopeTenant));
            if (why) rules.push({ name: "cross-tenant", severity: "block", detail: why });
          }
          let rows = a.insertRows;
          let fidelity: "exact" | "estimated" = "exact";
          if (rows === undefined) {
            const plan = (await q(c, `EXPLAIN (FORMAT JSON) ${a.sql}`)).rows[0]["QUERY PLAN"];
            rows = Math.round(plan?.[0]?.Plan?.["Plan Rows"] ?? 0);
            fidelity = "estimated";
          }
          const policy = decide(
            { tool: "postgres.insert", target: a.table!, destructive: false, estimatedRows: rows },
            { allowlist: cfg.allowlist, agentMedian: 1, perRunDestructiveRowsUsed: 0 },
            null,
            { thresholds: cfg.thresholds },
          );
          rules.push(...policy.firedRules);
          return {
            effect: { ...base, reversibility: "undo", preview: { summary: `insert ${fidelity === "exact" ? "" : "~"}${rows.toLocaleString()} rows into ${a.table}`, counts: { rows }, fidelity }, precondition: `insert:${hashOf(a.sql)}`, writes: [object] },
            connectorRules: rules,
            internal: { kind: "insert", connection: name, table: a.table, sql: a.sql, referenced: a.referenced.filter((t) => t !== a.table), fingerprint: a.fingerprint },
          };
        }

        if (a.kind === "drop") {
          let rows = 0;
          for (const t of a.tables!) rows += Number((await q(c, `SELECT count(*)::bigint AS n FROM ${ident(t)}`)).rows[0].n);
          if (!cfg.ddlSecret) rules.push({ name: "no-ddl-credential", severity: "block", detail: "this connection has no owner-level credential registered for DDL" });
          return {
            effect: {
              ...base,
              reversibility: "undo",
              preview: { summary: `drop ${a.tables!.join(", ")} (${rows.toLocaleString()} rows) — executed as a rename into trash`, counts: { tables: a.tables!.length, rows }, fidelity: "exact" },
              precondition: hashOf({ drop: a.tables, rows }),
              writes: a.tables!.map((t) => `postgres:${name}/${t}`),
            },
            connectorRules: [...rules, { name: "ddl-drop", severity: "approval", detail: "dropping a table always needs a human (it is renamed into trash, recoverable)" }],
            internal: { kind: "drop", connection: name, tables: a.tables, fingerprint: a.fingerprint },
          };
        }

        // Generic DDL: no automatic inverse.
        if (!cfg.ddlSecret) rules.push({ name: "no-ddl-credential", severity: "block", detail: "this connection has no owner-level credential registered for DDL" });
        return {
          effect: {
            ...base,
            reversibility: "irreversible",
            preview: { summary: `${a.statementName.replace(/Stmt$/, "")}: ${a.sql.slice(0, 160)}`, counts: { statements: 1 }, fidelity: "rendered" },
            precondition: `ddl:${hashOf(a.sql)}`,
            writes: a.referenced.map((t) => `postgres:${name}/${t}`).concat(a.referenced.length ? [] : [`postgres:${name}/schema`]),
          },
          connectorRules: rules,
          internal: { kind: "ddl", connection: name, sql: a.sql, fingerprint: a.fingerprint },
        };
      } finally {
        await q(c, "ROLLBACK").catch(() => {});
      }
    } finally {
      await c.end();
    }
  }

  async execute(req: EffectRequest, prepared: Prepared, ctx: ConnectorContext): Promise<Executed> {
    const i = prepared.internal as any;
    const { cfg, fingerprint } = this.config(req, ctx);
    if (i.kind === "select") return this.read(i, cfg, fingerprint, ctx);
    if (i.kind === "drop" || i.kind === "ddl") return this.ddl(i, prepared, cfg, ctx);

    const c = await this.client(ctx, cfg.secret, fingerprint);
    const role = `agm_req_${randomBytes(6).toString("hex")}`;
    let committed = false;
    try {
      await q(c, "BEGIN");
      await q(c, `SET LOCAL statement_timeout = ${EXEC_TIMEOUT_MS}`);
      await q(c, "SET LOCAL lock_timeout = 5000");
      const verbs = i.kind === "delete" ? "SELECT, DELETE" : i.kind === "update" ? "SELECT, UPDATE" : "SELECT, INSERT";
      await q(c, `CREATE ROLE ${ident(role)} NOLOGIN`);
      await q(c, `GRANT ${verbs} ON ${ident(i.table)} TO ${ident(role)}`);
      for (const t of i.referenced ?? []) await q(c, `GRANT SELECT ON ${ident(t)} TO ${ident(role)}`);
      await q(c, `GRANT ${ident(role)} TO CURRENT_USER`);
      await q(c, `SET LOCAL ROLE ${ident(role)}`);

      let writes: Executed["writes"] = [];
      let n = 0;
      const target = `${i.connection}/${i.table}`;
      if (i.kind === "delete") {
        // DELETE … RETURNING locks and removes in one statement; the returned key
        // set must equal the approved one, or the whole transaction rolls back.
        const del = await q(c, `DELETE FROM ${ident(i.table)} WHERE ${i.where} RETURNING *`);
        const keys = del.rows.map((r: any) => String(r[i.pk]));
        if (hashOf({ table: i.table, keys: [...keys].sort() }) !== prepared.effect.precondition) {
          throw new ConnectorError("precondition-drift", `the rows matching the predicate changed since approval (${keys.length.toLocaleString()} now) — rolled back, nothing deleted`);
        }
        writes = del.rows.map((r: any) => ({ key: `${i.table}:${r[i.pk]}`, target, before: encodeRow(r), afterHash: null }));
        n = del.rowCount ?? 0;
      } else if (i.kind === "update") {
        const locked = (await q(c, `SELECT * FROM ${ident(i.table)} WHERE ${i.where} FOR UPDATE`)).rows;
        const keys = locked.map((r: any) => String(r[i.pk]));
        if (hashOf({ table: i.table, keys: [...keys].sort() }) !== prepared.effect.precondition) {
          throw new ConnectorError("precondition-drift", `the rows matching the predicate changed since approval (${keys.length.toLocaleString()} now) — nothing updated`);
        }
        const before = new Map(locked.map((r: any) => [String(r[i.pk]), r]));
        const upd = await q(c, `UPDATE ${ident(i.table)} SET ${i.set} WHERE ${ident(i.pk)} = ANY($1) RETURNING *`, [keys]);
        writes = upd.rows.map((r: any) => ({ key: `${i.table}:${r[i.pk]}`, target, before: encodeRow(before.get(String(r[i.pk])) as any), afterHash: rowHash(r) }));
        n = upd.rowCount ?? 0;
      } else {
        const pk = await this.singlePk(c, i.table).catch(() => null);
        const sql = /\breturning\b/i.test(i.sql) ? i.sql : `${i.sql} RETURNING *`;
        const ins = await q(c, sql);
        n = ins.rowCount ?? 0;
        writes = pk ? ins.rows.map((r: any) => ({ key: `${i.table}:${r[pk]}`, target, before: null, afterHash: rowHash(r) })) : [];
      }
      await q(c, "RESET ROLE");
      await q(c, `REVOKE ALL ON ${ident(i.table)} FROM ${ident(role)}`);
      for (const t of i.referenced ?? []) await q(c, `REVOKE ALL ON ${ident(t)} FROM ${ident(role)}`);
      await q(c, `DROP ROLE ${ident(role)}`);
      await q(c, "COMMIT");
      committed = true;
      return {
        outcome: "executed",
        observedCounts: { rows: n },
        writes,
        facts: { rows: { [i.table]: n } },
        detail: `${i.kind} of ${n.toLocaleString()} rows in ${i.table} under per-request role ${role} (created and dropped inside the transaction)`,
        undo: { role },
      };
    } catch (e) {
      if (!committed) await q(c, "ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await c.end();
    }
  }

  private async read(i: any, cfg: PgConnectionConfig, fingerprint: string | null, ctx: ConnectorContext): Promise<Executed> {
    const cap = cfg.readRowCap ?? 500;
    const c = await this.client(ctx, cfg.secret, fingerprint);
    try {
      await q(c, "BEGIN READ ONLY");
      await q(c, `SET LOCAL statement_timeout = ${MEASURE_TIMEOUT_MS}`);
      const rows = (await q(c, `SELECT * FROM (${i.sql}) agm_q LIMIT ${cap + 1}`)).rows;
      await q(c, "ROLLBACK");
      // Response-side tenant check: verify what came BACK, not just what was asked (Asana-MCP class).
      if (i.tenant) {
        const cols = new Set((i.referenced as string[]).map((t) => cfg.tables?.[t]?.tenantColumn).filter(Boolean) as string[]);
        for (const col of cols) {
          const bad = rows.filter((r: any) => col in r && String(r[col]) !== String(i.tenant)).length;
          if (bad) throw new ConnectorError("cross-tenant", `${bad} returned row(s) belong to another tenant — result withheld`);
        }
      }
      const pii = new Set((i.referenced as string[]).flatMap((t) => cfg.tables?.[t]?.piiColumns ?? []));
      const masked = rows.slice(0, cap).map((r: any) => this.mask(encodeRow(r), { piiColumns: [...pii] }));
      return {
        outcome: "executed",
        observedCounts: { rows: Math.min(rows.length, cap) },
        result: { rows: masked, truncated: rows.length > cap, masked: [...pii], untrusted: (i.referenced as string[]).some((t) => cfg.tables?.[t]?.untrusted) },
        detail: `read ${Math.min(rows.length, cap)} rows${rows.length > cap ? ` (capped at ${cap})` : ""}${pii.size ? `, masked ${[...pii].join(", ")}` : ""}`,
      };
    } finally {
      await c.end();
    }
  }

  private async ddl(i: any, prepared: Prepared, cfg: PgConnectionConfig, ctx: ConnectorContext): Promise<Executed> {
    if (!cfg.ddlSecret) throw new ConnectorError("no-ddl-credential", "no owner-level credential registered for DDL");
    const c = await this.client(ctx, cfg.ddlSecret, null);
    try {
      await q(c, "BEGIN");
      await q(c, "SET LOCAL lock_timeout = 5000");
      await q(c, `SET LOCAL statement_timeout = ${EXEC_TIMEOUT_MS}`);
      if (i.kind === "drop") {
        const renames: Array<{ from: string; to: string }> = [];
        for (const t of i.tables as string[]) {
          const to = `_agm_trash_${Date.now().toString(36)}_${t}`.slice(0, 63);
          await q(c, `ALTER TABLE ${ident(t)} RENAME TO ${ident(to)}`);
          renames.push({ from: t, to });
        }
        await q(c, "COMMIT");
        return { outcome: "executed", observedCounts: { tables: renames.length, rows: prepared.effect.preview.counts.rows ?? 0 }, undo: { renames }, detail: `renamed into trash: ${renames.map((r) => `${r.from} → ${r.to}`).join(", ")}` };
      }
      await q(c, i.sql);
      await q(c, "COMMIT");
      return { outcome: "executed", observedCounts: { statements: 1 }, detail: "DDL applied" };
    } catch (e) {
      await q(c, "ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await c.end();
    }
  }

  async compensate(row: EffectRow, ctx: ConnectorContext): Promise<Compensated> {
    const internal = row.effect?.internal;
    if (internal?.kind === "drop") {
      const renames = (row.result?.undo?.renames ?? []) as Array<{ from: string; to: string }>;
      const { cfg } = this.config(row.effect.request, ctx);
      if (!cfg.ddlSecret) throw new ConnectorError("no-ddl-credential", "no owner-level credential registered for DDL");
      const c = await this.client(ctx, cfg.ddlSecret, null);
      try {
        await q(c, "BEGIN");
        for (const r of renames) await q(c, `ALTER TABLE ${ident(r.to)} RENAME TO ${ident(r.from)}`);
        await q(c, "COMMIT");
      } finally {
        await c.end();
      }
      return { detail: `restored from trash: ${renames.map((r) => r.from).join(", ")}`, restored: renames.length };
    }
    const writes = ctx.store.writes([row.taskId]).filter((w) => w.effectId === row.id);
    return this.revertWrites(writes.map((w) => ({ ...w, taskId: "__effect__" })), ["__effect__"], ctx, row.effect.request);
  }

  async revertWrites(writes: Array<WriteRecord & { target: string }>, taskIds: string[], ctx: ConnectorContext, reqHint?: EffectRequest): Promise<Compensated> {
    if (!writes.length) return { detail: "nothing to revert", restored: 0, skipped: [] };
    const byTarget = new Map<string, Array<WriteRecord & { target: string }>>();
    for (const w of writes) byTarget.set(w.target, [...(byTarget.get(w.target) ?? []), w]);
    let restored = 0;
    const skipped: Array<{ key: string; reason: string }> = [];
    for (const [target, ws] of byTarget) {
      const [connection, table] = target.split("/");
      const req = reqHint ?? ({ params: { connection }, target: { system: "postgres", resource: connection } } as unknown as EffectRequest);
      const { cfg, fingerprint } = this.config({ ...req, params: { ...req.params, connection } } as EffectRequest, ctx);
      const c = await this.client(ctx, cfg.secret, fingerprint);
      const role = `agm_req_${randomBytes(6).toString("hex")}`;
      try {
        await q(c, "BEGIN");
        await q(c, `SET LOCAL statement_timeout = ${EXEC_TIMEOUT_MS}`);
        const pk = await this.singlePk(c, table);
        const cols = await this.restorableColumns(c, table);
        const ids = [...new Set(ws.map((w) => w.key.slice(table.length + 1)))];
        const current = new Map<string, string>();
        for (let s = 0; s < ids.length; s += 10000) {
          const part = ids.slice(s, s + 10000);
          for (const r of (await q(c, `SELECT * FROM ${ident(table)} WHERE ${ident(pk)}::text = ANY($1) FOR UPDATE`, [part])).rows) {
            current.set(`${table}:${r[pk]}`, rowHash(r));
          }
        }
        await q(c, `CREATE ROLE ${ident(role)} NOLOGIN`);
        await q(c, `GRANT SELECT, INSERT, UPDATE, DELETE ON ${ident(table)} TO ${ident(role)}`);
        await q(c, `GRANT ${ident(role)} TO CURRENT_USER`);
        await q(c, `SET LOCAL ROLE ${ident(role)}`);
        for (const tid of taskIds) {
          const plan = planRevert(ws, tid, (k) => current.get(k) ?? null);
          skipped.push(...plan.skip);
          const reinserts = plan.restore.filter((r) => r.action === "reinsert").map((r) => r.before!);
          const usable = cols.filter((col) => reinserts.length === 0 || col.name in reinserts[0]);
          const overriding = usable.some((col) => col.identityAlways) ? " OVERRIDING SYSTEM VALUE" : "";
          const per = Math.max(1, Math.floor(MAX_PARAMS / Math.max(1, usable.length)));
          for (let s = 0; s < reinserts.length; s += per) {
            const batch = reinserts.slice(s, s + per);
            const vals: unknown[] = [];
            const tuples = batch.map((row, bi) => {
              usable.forEach((col) => vals.push(decodeValue(row[col.name])));
              return `(${usable.map((_, ci) => `$${bi * usable.length + ci + 1}`).join(", ")})`;
            });
            const r = await q(c, `INSERT INTO ${ident(table)} (${usable.map((col) => ident(col.name)).join(", ")})${overriding} VALUES ${tuples.join(", ")}`, vals);
            restored += r.rowCount ?? 0;
          }
          for (const r of plan.restore.filter((x) => x.action === "overwrite")) {
            const sets = cols.filter((col) => col.name !== pk && col.name in r.before!);
            const vals = sets.map((col) => decodeValue(r.before![col.name]));
            vals.push(r.key.slice(table.length + 1));
            await q(c, `UPDATE ${ident(table)} SET ${sets.map((col, k) => `${ident(col.name)} = $${k + 1}`).join(", ")} WHERE ${ident(pk)}::text = $${sets.length + 1}`, vals);
            restored++;
          }
          const dels = plan.restore.filter((x) => x.action === "delete").map((x) => x.key.slice(table.length + 1));
          if (dels.length) restored += (await q(c, `DELETE FROM ${ident(table)} WHERE ${ident(pk)}::text = ANY($1)`, [dels])).rowCount ?? 0;
        }
        await q(c, "RESET ROLE");
        await q(c, `REVOKE ALL ON ${ident(table)} FROM ${ident(role)}`);
        await q(c, `DROP ROLE ${ident(role)}`);
        await q(c, "COMMIT");
      } catch (e) {
        await q(c, "ROLLBACK").catch(() => {});
        throw e;
      } finally {
        await c.end();
      }
    }
    return { detail: `restored ${restored.toLocaleString()} row(s); ${skipped.length} skipped to preserve later edits`, restored, skipped };
  }

  private mask(row: Record<string, unknown>, t?: PgTableConfig): Record<string, unknown> {
    if (!t?.piiColumns?.length) return row;
    const o = { ...row };
    for (const col of t.piiColumns) if (col in o && o[col] !== null) o[col] = `•••${hashOf(String(o[col])).slice(0, 6)}`;
    return o;
  }

  private async singlePk(c: pg.Client, table: string): Promise<string> {
    const r = await q(
      c,
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ('public.' || $1)::regclass AND i.indisprimary`,
      [table],
    );
    if (r.rows.length !== 1) throw new ConnectorError("no-single-pk", `${table} needs a single-column primary key for exact binding and undo`);
    return r.rows[0].attname;
  }

  private async cascadingChildren(c: pg.Client, table: string): Promise<string[]> {
    const r = await q(c, `SELECT conrelid::regclass::text AS child FROM pg_constraint WHERE contype = 'f' AND confrelid = ('public.' || $1)::regclass AND confdeltype IN ('c','n','d')`, [table]);
    return r.rows.map((x: any) => x.child);
  }

  private async triggers(c: pg.Client, table: string, typeBit: number): Promise<string[]> {
    const r = await q(c, `SELECT tgname FROM pg_trigger WHERE tgrelid = ('public.' || $1)::regclass AND NOT tgisinternal AND (tgtype & ${typeBit}) <> 0`, [table]);
    return r.rows.map((x: any) => x.tgname);
  }

  private async restorableColumns(c: pg.Client, table: string): Promise<Array<{ name: string; identityAlways: boolean }>> {
    const r = await q(
      c,
      `SELECT attname, attidentity FROM pg_attribute WHERE attrelid = ('public.' || $1)::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
      [table],
    );
    return r.rows.map((x: any) => ({ name: x.attname, identityAlways: x.attidentity === "a" }));
  }
}
