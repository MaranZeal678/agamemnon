// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * Lexical guard for an agent-supplied WHERE predicate — dependency-free.
 *
 * This is ONE of four layers, not the whole defence. The others run in
 * Postgres itself and do not depend on this lexer being perfect:
 *   1. extended-protocol single-statement execution (Postgres refuses to run
 *      a second statement in a prepared query),
 *   2. measurement inside `BEGIN READ ONLY` with a statement timeout,
 *   3. execution under a per-request role granted only the needed verbs on
 *      the one target table (subqueries over any other table fail).
 * The broker additionally parses full statements with libpg_query (the real
 * Postgres parser); this lexer exists so the Convex runtime — which cannot
 * load WASM in a mutation — still rejects the obvious before any I/O.
 */

export type TokenKind = "word" | "quoted_ident" | "string" | "number" | "op" | "punct" | "param";

export interface Token {
  kind: TokenKind;
  text: string;
  /** Lower-cased value for words. */
  lower?: string;
}

export class SqlGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") throw new SqlGuardError("comment", "SQL comments are not allowed in a predicate");
    if (c === "/" && sql[i + 1] === "*") throw new SqlGuardError("comment", "SQL comments are not allowed in a predicate");
    if (c === ";") throw new SqlGuardError("multi-statement", "a predicate may not contain ';' (one statement only)");
    if (c === "$" && /[A-Za-z_$]/.test(sql[i + 1] ?? "")) {
      // $tag$ … $tag$ or $$ … $$ — dollar quoting can hide anything; refuse it.
      if (sql[i + 1] === "$" || /^\$[A-Za-z_][A-Za-z0-9_]*\$/.test(sql.slice(i))) {
        throw new SqlGuardError("dollar-quote", "dollar-quoted strings are not allowed in a predicate");
      }
    }
    if (c === "$" && /[0-9]/.test(sql[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      out.push({ kind: "param", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // E'...' escape strings and plain '...' strings ('' is an escaped quote).
    if ((c === "E" || c === "e") && sql[i + 1] === "'") {
      let j = i + 2;
      let buf = "";
      while (j < n) {
        if (sql[j] === "\\") { buf += sql[j + 1] ?? ""; j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { buf += "'"; j += 2; continue; } break; }
        buf += sql[j++];
      }
      if (j >= n) throw new SqlGuardError("unterminated", "unterminated string literal");
      out.push({ kind: "string", text: buf });
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let buf = "";
      while (j < n) {
        if (sql[j] === "'") { if (sql[j + 1] === "'") { buf += "'"; j += 2; continue; } break; }
        buf += sql[j++];
      }
      if (j >= n) throw new SqlGuardError("unterminated", "unterminated string literal");
      out.push({ kind: "string", text: buf });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < n) {
        if (sql[j] === '"') { if (sql[j + 1] === '"') { buf += '"'; j += 2; continue; } break; }
        buf += sql[j++];
      }
      if (j >= n) throw new SqlGuardError("unterminated", "unterminated quoted identifier");
      out.push({ kind: "quoted_ident", text: buf, lower: buf });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9._eE]/.test(sql[j])) {
        if ((sql[j] === "e" || sql[j] === "E") && /[+-]/.test(sql[j + 1] ?? "")) j++;
        j++;
      }
      out.push({ kind: "number", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const text = sql.slice(i, j);
      out.push({ kind: "word", text, lower: text.toLowerCase() });
      i = j;
      continue;
    }
    if ("(),.[]".includes(c)) { out.push({ kind: "punct", text: c }); i++; continue; }
    // Operators: greedy run of operator characters (::, <=, <>, !=, ||, ~~ …).
    let j = i;
    while (j < n && "+-*/<>=~!@#%^&|`?:".includes(sql[j])) {
      if (sql[j] === "-" && sql[j + 1] === "-") break;
      if (sql[j] === "/" && sql[j + 1] === "*") break;
      j++;
    }
    if (j === i) throw new SqlGuardError("bad-char", `unexpected character "${c}"`);
    out.push({ kind: "op", text: sql.slice(i, j) });
    i = j;
  }
  return out;
}

// Statement keywords that have no business inside a WHERE clause. Kept to
// words that are reserved in Postgres, so ordinary column names such as
// `owner`, `start` or `load` never trip it.
const FORBIDDEN_KEYWORDS = new Set([
  "insert", "update", "delete", "merge", "drop", "alter", "create", "truncate", "grant", "revoke",
  "copy", "commit", "rollback", "begin", "savepoint", "execute", "call", "listen", "notify",
  "unlisten", "vacuum", "prepare", "deallocate", "into", "returning", "reindex", "discard",
]);

// Functions with side effects, privilege, or time/IO abuse potential.
const FORBIDDEN_FUNCTIONS = new Set([
  "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_read_file", "pg_read_binary_file", "pg_ls_dir",
  "pg_stat_file", "lo_import", "lo_export", "lo_unlink", "lo_create", "lo_put", "dblink", "dblink_exec",
  "dblink_connect", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf", "pg_rotate_logfile",
  "set_config", "nextval", "setval", "currval", "pg_advisory_lock", "pg_advisory_xact_lock",
  "pg_try_advisory_lock", "pg_notify", "query_to_xml", "query_to_json", "xpath", "pg_file_write",
  "pg_logical_emit_message", "txid_current", "pg_current_xact_id", "pg_switch_wal",
  "pg_create_restore_point", "pg_promote", "pg_stat_reset",
]);

export interface PredicateAnalysis {
  /** Tables referenced after FROM / JOIN in subqueries (lower-cased, unqualified). */
  referencedTables: string[];
  /** The predicate with every literal replaced by $1..$n — safe to show an LLM. */
  shape: string;
  /** The literal values removed from `shape`, in order. Never sent to a model. */
  literals: string[];
  tokenCount: number;
}

export interface GuardOptions {
  /** Tables subqueries may read. The target itself is always implicitly allowed. */
  allowedTables: string[];
  maxLength?: number;
}

/**
 * Validate a predicate. Throws SqlGuardError on anything outside the
 * allowed shape; returns the analysis (referenced tables, redacted shape).
 */
export function guardPredicate(predicate: string, opts: GuardOptions): PredicateAnalysis {
  const maxLength = opts.maxLength ?? 4000;
  if (typeof predicate !== "string" || predicate.trim() === "") {
    throw new SqlGuardError("empty", "predicate is required");
  }
  if (predicate.length > maxLength) {
    throw new SqlGuardError("too-long", `predicate exceeds ${maxLength} characters`);
  }
  const tokens = tokenize(predicate);
  let depth = 0;
  const referenced = new Set<string>();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === "punct" && t.text === "(") depth++;
    if (t.kind === "punct" && t.text === ")") {
      depth--;
      if (depth < 0) throw new SqlGuardError("unbalanced", "unbalanced parentheses — a predicate cannot close the WHERE clause");
    }
    if (t.kind !== "word") continue;
    const w = t.lower!;
    if (FORBIDDEN_KEYWORDS.has(w)) {
      throw new SqlGuardError("forbidden-keyword", `"${t.text}" is not allowed in a predicate`);
    }
    const next = tokens[k + 1];
    if (next && next.kind === "punct" && next.text === "(" && FORBIDDEN_FUNCTIONS.has(w)) {
      throw new SqlGuardError("forbidden-function", `function ${t.text}() is not allowed in a predicate`);
    }
    // Schema-qualified call: pg_catalog.pg_sleep(…)
    if (next && next.kind === "punct" && next.text === "." ) {
      const fn = tokens[k + 2];
      const paren = tokens[k + 3];
      if (fn?.kind === "word" && paren?.kind === "punct" && paren.text === "(" && FORBIDDEN_FUNCTIONS.has(fn.lower!)) {
        throw new SqlGuardError("forbidden-function", `function ${fn.text}() is not allowed in a predicate`);
      }
    }
    if (w === "from" || w === "join") {
      let r = tokens[k + 1];
      if (!r) continue;
      if (r.kind === "punct" && r.text === "(") continue; // derived table, inner tokens are checked anyway
      if (r.kind !== "word" && r.kind !== "quoted_ident") continue;
      let name = r.lower!;
      // schema.table → keep schema for the check
      const dot = tokens[k + 2];
      const tbl = tokens[k + 3];
      if (dot?.kind === "punct" && dot.text === "." && (tbl?.kind === "word" || tbl?.kind === "quoted_ident")) {
        if (name !== "public") {
          throw new SqlGuardError("foreign-schema", `subqueries may only read the public schema (saw "${name}.${tbl.text}")`);
        }
        name = tbl.lower!;
      }
      referenced.add(name);
    }
  }
  if (depth !== 0) throw new SqlGuardError("unbalanced", "unbalanced parentheses");

  const allowed = new Set(opts.allowedTables.map((s) => s.toLowerCase()));
  for (const tbl of referenced) {
    if (!allowed.has(tbl)) {
      throw new SqlGuardError("table-not-allowed", `subquery reads "${tbl}", which is not on the allowlist`);
    }
  }

  const literals: string[] = [];
  const shape = tokens
    .map((t) => {
      if (t.kind === "string" || t.kind === "number") {
        literals.push(t.text);
        return `$${literals.length}`;
      }
      if (t.kind === "quoted_ident") return `"${t.text.replace(/"/g, '""')}"`;
      return t.text;
    })
    .join(" ")
    .replace(/ \( /g, " (")
    .replace(/ \)/g, ")")
    .replace(/ \. /g, ".")
    .replace(/ , /g, ", ");

  return { referencedTables: [...referenced], shape, literals, tokenCount: tokens.length };
}

/** A bare, safe SQL identifier (table/column) check. */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}

/** Is this function name on the side-effect / privilege denylist? (Shared with the broker's AST checks.) */
export function isForbiddenFunction(name: string): boolean {
  return FORBIDDEN_FUNCTIONS.has(name.toLowerCase());
}
