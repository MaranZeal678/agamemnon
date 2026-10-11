/* GENERATED from packages/kernel by scripts/build-guards.mjs — do not edit.
 * Agamemnon — Copyright (c) 2026 Elamaran Elangovan. All rights reserved. ref: AGMN-BOZW-F6BTKX-X3LAO */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  DEFAULT_THRESHOLDS: () => DEFAULT_THRESHOLDS,
  GENESIS_HASH: () => GENESIS_HASH,
  POLICY: () => POLICY,
  SqlGuardError: () => SqlGuardError,
  applyClassifier: () => applyClassifier,
  approvalState: () => approvalState,
  auditBody: () => auditBody,
  canonicalJson: () => canonicalJson,
  checkApprover: () => checkApprover,
  classToSeverity: () => classToSeverity,
  computeAuditHash: () => computeAuditHash,
  decide: () => decide,
  evaluateRules: () => evaluateRules,
  guardPredicate: () => guardPredicate,
  hashOf: () => hashOf,
  heuristicVerdict: () => heuristicVerdict,
  isSafeIdentifier: () => isSafeIdentifier,
  leveled: () => leveled,
  median: () => median,
  moreSevere: () => moreSevere,
  nextLink: () => nextLink,
  requiredApprovals: () => requiredApprovals,
  reviewerStats: () => reviewerStats,
  severityRank: () => severityRank,
  sha256Hex: () => sha256Hex,
  tokenize: () => tokenize,
  verifyChain: () => verifyChain
});
module.exports = __toCommonJS(index_exports);

// src/hash.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function utf8(s) {
  return new TextEncoder().encode(s);
}
function sha256Hex(input) {
  const msg = typeof input === "string" ? utf8(input) : input;
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(msg.length + 9 + 63 >> 6 << 6);
  padded.set(msg);
  padded[msg.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const H = new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => x >>> n | x << 32 - n;
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ W[i - 15] >>> 3;
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ W[i - 2] >>> 10;
      W[i] = W[i - 16] + s0 + W[i - 7] + s1 >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = h + S1 + ch + K[i] + W[i] >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    H[0] = H[0] + a >>> 0;
    H[1] = H[1] + b >>> 0;
    H[2] = H[2] + c >>> 0;
    H[3] = H[3] + d >>> 0;
    H[4] = H[4] + e >>> 0;
    H[5] = H[5] + f >>> 0;
    H[6] = H[6] + g >>> 0;
    H[7] = H[7] + h >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += H[i].toString(16).padStart(8, "0");
  return out;
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === void 0 ? null : v)).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const obj = value;
  const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
function hashOf(value) {
  return sha256Hex(canonicalJson(value));
}

// src/policy.ts
var SEVERITY = { allow: 0, approval: 1, block: 2 };
function moreSevere(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}
function severityRank(d) {
  return SEVERITY[d];
}
var DEFAULT_THRESHOLDS = {
  DESTRUCTIVE_ROW_HARD_CAP: 5e3,
  MEDIAN_BLOCK_MULTIPLIER: 20,
  MEDIAN_APPROVAL_MULTIPLIER: 5,
  BLAST_RADIUS_APPROVAL_THRESHOLD: 0.9,
  DESTRUCTIVE_APPROVAL_ROW_THRESHOLD: 100,
  PER_RUN_DESTRUCTIVE_ROW_BUDGET: 5e3
};
var POLICY = DEFAULT_THRESHOLDS;
function resolve(opts) {
  return { t: { ...DEFAULT_THRESHOLDS, ...opts?.thresholds ?? {} }, levels: opts?.levels ?? {} };
}
function leveled(name, natural, levels) {
  const level = levels[name];
  if (!level || level === "block") return { severity: natural };
  if (level === "monitor") return { severity: "allow", level };
  return { severity: natural === "block" ? "approval" : natural, level };
}
function evaluateRules(action, ctx, opts) {
  const { t, levels } = resolve(opts);
  const fired = [];
  const rows = action.estimatedRows;
  const median2 = ctx.agentMedian > 0 ? ctx.agentMedian : 1;
  const ratio = rows / median2;
  const fire = (name, natural, detail) => {
    const { severity, level } = leveled(name, natural, levels);
    fired.push(level ? { name, severity, detail, level } : { name, severity, detail });
  };
  if (ctx.allowlist && !ctx.allowlist.includes(action.target)) {
    fire(
      "target-not-allowlisted",
      "block",
      `target "${action.target}" is not on the allowlist [${ctx.allowlist.join(", ")}]`
    );
  }
  if (action.destructive) {
    if (rows > t.DESTRUCTIVE_ROW_HARD_CAP) {
      fire(
        "destructive-over-hard-cap",
        "block",
        `${rows.toLocaleString()} rows exceeds the ${t.DESTRUCTIVE_ROW_HARD_CAP.toLocaleString()}-row destructive hard cap`
      );
    }
    if (rows > t.MEDIAN_BLOCK_MULTIPLIER * median2) {
      fire(
        "exceeds-20x-median",
        "block",
        `${rows.toLocaleString()} rows is ${ratio.toFixed(1)}x the agent's 30-day median of ${median2.toLocaleString()} (limit ${t.MEDIAN_BLOCK_MULTIPLIER}x)`
      );
    } else if (rows > t.MEDIAN_APPROVAL_MULTIPLIER * median2) {
      fire(
        "exceeds-5x-median",
        "approval",
        `${rows.toLocaleString()} rows is ${ratio.toFixed(1)}x the agent's median of ${median2.toLocaleString()} (>${t.MEDIAN_APPROVAL_MULTIPLIER}x needs approval)`
      );
    }
    if (ctx.perRunDestructiveRowsUsed + rows > t.PER_RUN_DESTRUCTIVE_ROW_BUDGET) {
      fire(
        "destructive-budget-exhausted",
        "block",
        `this run has spent ${ctx.perRunDestructiveRowsUsed.toLocaleString()} destructive rows; +${rows.toLocaleString()} would exceed the ${t.PER_RUN_DESTRUCTIVE_ROW_BUDGET.toLocaleString()}-row budget`
      );
    }
    if (rows > t.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD) {
      fire(
        "destructive-over-100",
        "approval",
        `${rows.toLocaleString()} destructive rows (>${t.DESTRUCTIVE_APPROVAL_ROW_THRESHOLD}) requires approval by default`
      );
    }
  }
  const decision = fired.reduce((acc, r) => moreSevere(acc, r.severity), "allow");
  return { decision, firedRules: fired, ratioToMedian: ratio };
}
function applyClassifier(base, verdict, opts) {
  if (!verdict) return { ...base, classifierEscalated: false };
  const { t } = resolve(opts);
  const fired = [...base.firedRules];
  let decision = base.decision;
  const before = decision;
  if (verdict.blast_radius >= t.BLAST_RADIUS_APPROVAL_THRESHOLD) {
    fired.push({
      name: "blast-radius-high",
      severity: "approval",
      detail: `classifier blast radius ${verdict.blast_radius.toFixed(2)} \u2265 ${t.BLAST_RADIUS_APPROVAL_THRESHOLD} (${verdict.source})`
    });
    decision = moreSevere(decision, "approval");
  }
  const classSeverity = classToSeverity(verdict.class);
  if (SEVERITY[classSeverity] > SEVERITY[decision]) {
    fired.push({
      name: `classifier-${verdict.class}`,
      severity: classSeverity,
      detail: `classifier rated "${verdict.class}" (${verdict.source}): ${verdict.rationale}`
    });
    decision = classSeverity;
  }
  return {
    decision,
    firedRules: fired,
    ratioToMedian: base.ratioToMedian,
    classifierEscalated: SEVERITY[decision] > SEVERITY[before]
  };
}
function classToSeverity(cls) {
  switch (String(cls).toLowerCase()) {
    case "catastrophic":
      return "block";
    case "elevated":
    case "high":
      return "approval";
    default:
      return "allow";
  }
}
function decide(action, ctx, verdict = null, opts) {
  return applyClassifier(evaluateRules(action, ctx, opts), verdict, opts);
}
function heuristicVerdict(input) {
  const { matchingRows, totalRows, destructive, target } = input;
  const fraction = totalRows > 0 ? matchingRows / totalRows : matchingRows > 0 ? 1 : 0;
  const blast_radius = Math.max(0, Math.min(1, fraction));
  let cls;
  if (!destructive) cls = "benign";
  else if (blast_radius >= 0.9) cls = "catastrophic";
  else if (blast_radius >= 0.2 || matchingRows > 1e3) cls = "elevated";
  else cls = "benign";
  return {
    class: cls,
    blast_radius,
    rationale: `matches ${matchingRows.toLocaleString()} of ${totalRows.toLocaleString()} rows in ${target} (${(blast_radius * 100).toFixed(2)}% of the table)`,
    source: "heuristic"
  };
}
function median(values) {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return 0;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

// src/audit.ts
var GENESIS_HASH = "0".repeat(64);
function auditBody(row) {
  const { seq: _s, prevHash: _p, hash: _h, _id: _i, _creationTime: _c, ...body } = row;
  return body;
}
function computeAuditHash(prevHash, seq, body) {
  return sha256Hex(`${prevHash}
${seq}
${canonicalJson(body)}`);
}
function nextLink(head, body) {
  const seq = head ? head.seq + 1 : 0;
  const prevHash = head ? head.hash : GENESIS_HASH;
  return { seq, prevHash, hash: computeAuditHash(prevHash, seq, body) };
}
function verifyChain(rows) {
  let prev = GENESIS_HASH;
  let expectedSeq = rows.length ? rows[0].seq : 0;
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return { ok: false, checked: row.seq, headHash: prev, brokenAt: { seq: row.seq, reason: `gap: expected seq ${expectedSeq}` } };
    }
    if (row.prevHash !== prev && !(row.seq === rows[0].seq && rows[0].seq > 0)) {
      return { ok: false, checked: row.seq, headHash: prev, brokenAt: { seq: row.seq, reason: "prevHash does not match previous row" } };
    }
    const recomputed = computeAuditHash(row.prevHash, row.seq, auditBody(row));
    if (recomputed !== row.hash) {
      return { ok: false, checked: row.seq, headHash: prev, brokenAt: { seq: row.seq, reason: "row contents do not match its hash (edited)" } };
    }
    prev = row.hash;
    expectedSeq++;
  }
  return { ok: true, checked: rows.length, headHash: prev };
}

// src/approvals.ts
function checkApprover(approver, subject) {
  if (approver.kind !== "human") {
    return { ok: false, reason: `approvals from a ${approver.kind} count as none \u2014 a human must decide` };
  }
  if (approver.id === subject.requester.id) {
    return { ok: false, reason: "the requester cannot approve its own request" };
  }
  if (subject.launcher && approver.id === subject.launcher) {
    return { ok: false, reason: "the human who launched this agent cannot approve its requests" };
  }
  return { ok: true };
}
function approvalState(subject, records) {
  const valid = records.filter((r) => !r.canary && checkApprover(r.approver, subject).ok);
  const denial = valid.find((r) => r.decision === "deny");
  if (denial) return { state: "denied", by: denial.approver.id };
  const approvers = [...new Set(valid.filter((r) => r.decision === "approve").map((r) => r.approver.id))];
  if (approvers.length >= subject.required) return { state: "approved", approvers };
  return { state: "pending", approvals: approvers.length, required: subject.required };
}
function requiredApprovals(input) {
  if (input.oversightReducing) return 2;
  if (input.reversibility === "irreversible") return 2;
  const threshold = input.twoPersonRowThreshold ?? 2e3;
  if ((input.rows ?? 0) > threshold) return 2;
  return 1;
}
function reviewerStats(rows) {
  const by = /* @__PURE__ */ new Map();
  for (const r of rows) by.set(r.approver, [...by.get(r.approver) ?? [], r]);
  return [...by.entries()].map(([approver, rs]) => {
    const real = rs.filter((r) => !r.canary);
    const canaries = rs.filter((r) => r.canary);
    const secs = real.map((r) => r.secondsToDecide).sort((a, b) => a - b);
    return {
      approver,
      decisions: real.length,
      approvalRate: real.length ? real.filter((r) => r.decision === "approve").length / real.length : 0,
      medianSecondsToDecide: secs.length ? secs[secs.length >> 1] : 0,
      fastApprovals: real.filter((r) => r.decision === "approve" && r.secondsToDecide < 3).length,
      canariesSeen: canaries.length,
      canariesCaught: canaries.filter((r) => r.decision === "deny").length
    };
  });
}

// src/sqlguard.ts
var SqlGuardError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function tokenize(sql) {
  const out = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") throw new SqlGuardError("comment", "SQL comments are not allowed in a predicate");
    if (c === "/" && sql[i + 1] === "*") throw new SqlGuardError("comment", "SQL comments are not allowed in a predicate");
    if (c === ";") throw new SqlGuardError("multi-statement", "a predicate may not contain ';' (one statement only)");
    if (c === "$" && /[A-Za-z_$]/.test(sql[i + 1] ?? "")) {
      if (sql[i + 1] === "$" || /^\$[A-Za-z_][A-Za-z0-9_]*\$/.test(sql.slice(i))) {
        throw new SqlGuardError("dollar-quote", "dollar-quoted strings are not allowed in a predicate");
      }
    }
    if (c === "$" && /[0-9]/.test(sql[i + 1] ?? "")) {
      let j2 = i + 1;
      while (j2 < n && /[0-9]/.test(sql[j2])) j2++;
      out.push({ kind: "param", text: sql.slice(i, j2) });
      i = j2;
      continue;
    }
    if ((c === "E" || c === "e") && sql[i + 1] === "'") {
      let j2 = i + 2;
      let buf = "";
      while (j2 < n) {
        if (sql[j2] === "\\") {
          buf += sql[j2 + 1] ?? "";
          j2 += 2;
          continue;
        }
        if (sql[j2] === "'") {
          if (sql[j2 + 1] === "'") {
            buf += "'";
            j2 += 2;
            continue;
          }
          break;
        }
        buf += sql[j2++];
      }
      if (j2 >= n) throw new SqlGuardError("unterminated", "unterminated string literal");
      out.push({ kind: "string", text: buf });
      i = j2 + 1;
      continue;
    }
    if (c === "'") {
      let j2 = i + 1;
      let buf = "";
      while (j2 < n) {
        if (sql[j2] === "'") {
          if (sql[j2 + 1] === "'") {
            buf += "'";
            j2 += 2;
            continue;
          }
          break;
        }
        buf += sql[j2++];
      }
      if (j2 >= n) throw new SqlGuardError("unterminated", "unterminated string literal");
      out.push({ kind: "string", text: buf });
      i = j2 + 1;
      continue;
    }
    if (c === '"') {
      let j2 = i + 1;
      let buf = "";
      while (j2 < n) {
        if (sql[j2] === '"') {
          if (sql[j2 + 1] === '"') {
            buf += '"';
            j2 += 2;
            continue;
          }
          break;
        }
        buf += sql[j2++];
      }
      if (j2 >= n) throw new SqlGuardError("unterminated", "unterminated quoted identifier");
      out.push({ kind: "quoted_ident", text: buf, lower: buf });
      i = j2 + 1;
      continue;
    }
    if (/[0-9]/.test(c) || c === "." && /[0-9]/.test(sql[i + 1] ?? "")) {
      let j2 = i;
      while (j2 < n && /[0-9._eE]/.test(sql[j2])) {
        if ((sql[j2] === "e" || sql[j2] === "E") && /[+-]/.test(sql[j2 + 1] ?? "")) j2++;
        j2++;
      }
      out.push({ kind: "number", text: sql.slice(i, j2) });
      i = j2;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j2 = i;
      while (j2 < n && /[A-Za-z0-9_$]/.test(sql[j2])) j2++;
      const text = sql.slice(i, j2);
      out.push({ kind: "word", text, lower: text.toLowerCase() });
      i = j2;
      continue;
    }
    if ("(),.[]".includes(c)) {
      out.push({ kind: "punct", text: c });
      i++;
      continue;
    }
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
var FORBIDDEN_KEYWORDS = /* @__PURE__ */ new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "commit",
  "rollback",
  "begin",
  "savepoint",
  "execute",
  "call",
  "listen",
  "notify",
  "unlisten",
  "vacuum",
  "prepare",
  "deallocate",
  "into",
  "returning",
  "reindex",
  "discard"
]);
var FORBIDDEN_FUNCTIONS = /* @__PURE__ */ new Set([
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "lo_import",
  "lo_export",
  "lo_unlink",
  "lo_create",
  "lo_put",
  "dblink",
  "dblink_exec",
  "dblink_connect",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "set_config",
  "nextval",
  "setval",
  "currval",
  "pg_advisory_lock",
  "pg_advisory_xact_lock",
  "pg_try_advisory_lock",
  "pg_notify",
  "query_to_xml",
  "query_to_json",
  "xpath",
  "pg_file_write",
  "pg_logical_emit_message",
  "txid_current",
  "pg_current_xact_id",
  "pg_switch_wal",
  "pg_create_restore_point",
  "pg_promote",
  "pg_stat_reset"
]);
function guardPredicate(predicate, opts) {
  const maxLength = opts.maxLength ?? 4e3;
  if (typeof predicate !== "string" || predicate.trim() === "") {
    throw new SqlGuardError("empty", "predicate is required");
  }
  if (predicate.length > maxLength) {
    throw new SqlGuardError("too-long", `predicate exceeds ${maxLength} characters`);
  }
  const tokens = tokenize(predicate);
  let depth = 0;
  const referenced = /* @__PURE__ */ new Set();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === "punct" && t.text === "(") depth++;
    if (t.kind === "punct" && t.text === ")") {
      depth--;
      if (depth < 0) throw new SqlGuardError("unbalanced", "unbalanced parentheses \u2014 a predicate cannot close the WHERE clause");
    }
    if (t.kind !== "word") continue;
    const w = t.lower;
    if (FORBIDDEN_KEYWORDS.has(w)) {
      throw new SqlGuardError("forbidden-keyword", `"${t.text}" is not allowed in a predicate`);
    }
    const next = tokens[k + 1];
    if (next && next.kind === "punct" && next.text === "(" && FORBIDDEN_FUNCTIONS.has(w)) {
      throw new SqlGuardError("forbidden-function", `function ${t.text}() is not allowed in a predicate`);
    }
    if (next && next.kind === "punct" && next.text === ".") {
      const fn = tokens[k + 2];
      const paren = tokens[k + 3];
      if (fn?.kind === "word" && paren?.kind === "punct" && paren.text === "(" && FORBIDDEN_FUNCTIONS.has(fn.lower)) {
        throw new SqlGuardError("forbidden-function", `function ${fn.text}() is not allowed in a predicate`);
      }
    }
    if (w === "from" || w === "join") {
      let r = tokens[k + 1];
      if (!r) continue;
      if (r.kind === "punct" && r.text === "(") continue;
      if (r.kind !== "word" && r.kind !== "quoted_ident") continue;
      let name = r.lower;
      const dot = tokens[k + 2];
      const tbl = tokens[k + 3];
      if (dot?.kind === "punct" && dot.text === "." && (tbl?.kind === "word" || tbl?.kind === "quoted_ident")) {
        if (name !== "public") {
          throw new SqlGuardError("foreign-schema", `subqueries may only read the public schema (saw "${name}.${tbl.text}")`);
        }
        name = tbl.lower;
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
  const literals = [];
  const shape = tokens.map((t) => {
    if (t.kind === "string" || t.kind === "number") {
      literals.push(t.text);
      return `$${literals.length}`;
    }
    if (t.kind === "quoted_ident") return `"${t.text.replace(/"/g, '""')}"`;
    return t.text;
  }).join(" ").replace(/ \( /g, " (").replace(/ \)/g, ")").replace(/ \. /g, ".").replace(/ , /g, ", ");
  return { referencedTables: [...referenced], shape, literals, tokenCount: tokens.length };
}
function isSafeIdentifier(name) {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(name);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_THRESHOLDS,
  GENESIS_HASH,
  POLICY,
  SqlGuardError,
  applyClassifier,
  approvalState,
  auditBody,
  canonicalJson,
  checkApprover,
  classToSeverity,
  computeAuditHash,
  decide,
  evaluateRules,
  guardPredicate,
  hashOf,
  heuristicVerdict,
  isSafeIdentifier,
  leveled,
  median,
  moreSevere,
  nextLink,
  requiredApprovals,
  reviewerStats,
  severityRank,
  sha256Hex,
  tokenize,
  verifyChain
});
