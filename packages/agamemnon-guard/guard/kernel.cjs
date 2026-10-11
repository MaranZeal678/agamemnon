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
  CLEAN_TAINT: () => CLEAN_TAINT,
  DEFAULT_BUDGETS: () => DEFAULT_BUDGETS,
  DEFAULT_THRESHOLDS: () => DEFAULT_THRESHOLDS,
  GENESIS_HASH: () => GENESIS_HASH,
  GENESIS_RECEIPT: () => GENESIS_RECEIPT,
  OVERSIGHT_CATALOG_VERSION: () => OVERSIGHT_CATALOG_VERSION,
  POLICY: () => POLICY,
  SqlGuardError: () => SqlGuardError,
  absorbTaint: () => absorbTaint,
  acquireLease: () => acquireLease,
  admit: () => admit,
  analyseShell: () => analyseShell,
  applyClassifier: () => applyClassifier,
  approvalState: () => approvalState,
  artifactsToRevoke: () => artifactsToRevoke,
  auditBody: () => auditBody,
  bindEffect: () => bindEffect,
  buildReceipt: () => buildReceipt,
  canonicalJson: () => canonicalJson,
  checkApprover: () => checkApprover,
  checkBinding: () => checkBinding,
  checkBudgets: () => checkBudgets,
  checkReadVersion: () => checkReadVersion,
  classToSeverity: () => classToSeverity,
  classifyOversight: () => classifyOversight,
  computeAuditHash: () => computeAuditHash,
  connectorFidelity: () => connectorFidelity,
  containsRealCredential: () => containsRealCredential,
  decide: () => decide,
  dependents: () => dependents,
  effectHash: () => effectHash,
  evaluateRules: () => evaluateRules,
  extractClaims: () => extractClaims,
  fidelityScore: () => fidelityScore,
  guardPredicate: () => guardPredicate,
  hashOf: () => hashOf,
  heuristicVerdict: () => heuristicVerdict,
  invokedScripts: () => invokedScripts,
  isForbiddenFunction: () => isForbiddenFunction,
  isSafeIdentifier: () => isSafeIdentifier,
  lethalTrifecta: () => lethalTrifecta,
  leveled: () => leveled,
  median: () => median,
  moreSevere: () => moreSevere,
  nextLink: () => nextLink,
  planRevert: () => planRevert,
  primaryCount: () => primaryCount,
  priorDenial: () => priorDenial,
  receiptHash: () => receiptHash,
  receiptPayload: () => receiptPayload,
  reconcileAll: () => reconcileAll,
  reconcileClaim: () => reconcileClaim,
  requestFingerprint: () => requestFingerprint,
  requiredApprovals: () => requiredApprovals,
  reviewerStats: () => reviewerStats,
  severityRank: () => severityRank,
  sha256Hex: () => sha256Hex,
  signReceipt: () => signReceipt,
  staleArtifacts: () => staleArtifacts,
  tokenize: () => tokenize,
  trustLevel: () => trustLevel,
  verifyChain: () => verifyChain,
  verifyReceipts: () => verifyReceipts
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
function isForbiddenFunction(name) {
  return FORBIDDEN_FUNCTIONS.has(name.toLowerCase());
}

// src/effect.ts
function effectHash(e) {
  return hashOf({
    operation: e.request.operation,
    target: e.request.target,
    params: e.request.params,
    reversibility: e.reversibility,
    windowMs: e.windowMs ?? null,
    counts: e.preview.counts,
    amountMinor: e.preview.amountMinor ?? null,
    precondition: e.precondition,
    creates: e.creates,
    egress: e.egress
  });
}
function bindEffect(e, now, ttlMs = 15 * 60 * 1e3) {
  const effectH = effectHash(e);
  const issuedAt = now;
  const expiresAt = now + ttlMs;
  return {
    effectHash: effectH,
    precondition: e.precondition,
    issuedAt,
    expiresAt,
    bindingHash: hashOf({ effectH, precondition: e.precondition, issuedAt, expiresAt })
  };
}
function checkBinding(b, remeasured, now) {
  if (now > b.expiresAt) return { ok: false, reason: "approval expired before execution" };
  const recomputed = hashOf({ effectH: b.effectHash, precondition: b.precondition, issuedAt: b.issuedAt, expiresAt: b.expiresAt });
  if (recomputed !== b.bindingHash) return { ok: false, reason: "binding was tampered with" };
  if (remeasured.precondition !== b.precondition) {
    return { ok: false, reason: "the target changed since approval (precondition drift) \u2014 re-measure and re-approve" };
  }
  if (effectHash(remeasured) !== b.effectHash) {
    return { ok: false, reason: "the effect differs from the one approved \u2014 re-measure and re-approve" };
  }
  return { ok: true };
}
function requestFingerprint(r, shape) {
  return hashOf({ op: r.operation, system: r.target.system, resource: r.target.resource, shape: shape ?? Object.keys(r.params).sort() });
}

// src/oversight.ts
var OVERSIGHT_CATALOG_VERSION = "2026.10.1";
var TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|test_[^/]*|[^/]*_test)\/|(^|\/)[^/]*(\.|_)(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;
var SKIP_MARKERS = [
  [/\b(it|test|describe)\.skip\s*\(/, "test.skip / describe.skip"],
  [/\bx(it|describe|test)\s*\(/, "xit / xdescribe"],
  [/\b(it|test)\.todo\s*\(/, "test.todo"],
  [/@pytest\.mark\.(skip|xfail)\b/, "@pytest.mark.skip / xfail"],
  [/\bpytest\.skip\s*\(/, "pytest.skip()"],
  [/@unittest\.skip/, "@unittest.skip"],
  [/\bt\.Skip(Now|f)?\s*\(/, "t.Skip()"],
  [/@(Disabled|Ignore)\b/, "@Disabled / @Ignore"],
  [/#\[ignore\]/, "#[ignore]"],
  [/\bskip\s*:\s*true\b/, "skip: true"]
];
var AGENT_CONFIG = /(^|\/)(\.claude\/settings[^/]*\.json|\.claude\/hooks?[^/]*|\.cursor\/(hooks\.json|rules|mcp\.json|cli\.json)|\.vscode\/settings\.json|\.codex\/[^/]+|codex\/config\.toml|\.gemini\/(settings\.json|policies?[^/]*)|\.windsurf\/[^/]+|\.mcp\.json|AGENTS\.md|CLAUDE\.md|\.agamemnon\/[^/]+)$/i;
var CI_FILE = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile|\.buildkite\/[^/]+)$/i;
var CODEOWNERS = /(^|\/)(\.github\/)?CODEOWNERS$/;
var AUDIT_NAME = /(audit|_log$|^log_|history|journal|ledger)/i;
function addedLines(d) {
  if (d.diff) return d.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  if (d.after !== void 0) {
    const before = new Set((d.before ?? "").split("\n"));
    return d.after.split("\n").filter((l) => !before.has(l));
  }
  return [];
}
function removedLines(d) {
  if (d.diff) return d.diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  if (d.before !== void 0) {
    const after = new Set((d.after ?? "").split("\n"));
    return d.before.split("\n").filter((l) => !after.has(l));
  }
  return [];
}
var TEST_DECL = /\b(it|test|describe)\s*\(|^\s*def test_|func Test[A-Z]|@Test\b|#\[test\]/;
function classifyOversight(d) {
  const out = [];
  const add = (rule, detail) => out.push({ rule, detail });
  const res = d.resource ?? "";
  const op = d.operation.toLowerCase();
  if (d.system === "fs" || d.system === "git" || d.system === "github") {
    if (TEST_PATH.test(res) && (op === "delete" || op === "rename")) {
      add("test-deleted", `test file ${res} would be ${op}d`);
    }
    if (TEST_PATH.test(res) && (op === "write" || op === "edit")) {
      for (const line of addedLines(d)) {
        for (const [re, name] of SKIP_MARKERS) if (re.test(line)) add("test-skipped", `${name} added in ${res}`);
      }
      const removedTests = removedLines(d).filter((l) => TEST_DECL.test(l)).length;
      const addedTests = addedLines(d).filter((l) => TEST_DECL.test(l)).length;
      if (removedTests > addedTests) add("tests-removed", `${removedTests - addedTests} test case(s) removed from ${res}`);
      if (addedLines(d).some((l) => /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)|\bassert\s+True\b|assertTrue\(\s*true\s*\)|assert\.ok\(\s*true\s*\)/.test(l))) {
        add("assertion-trivialised", `trivially-true assertion added in ${res}`);
      }
    }
    if (CI_FILE.test(res)) {
      if (op === "delete") add("ci-pipeline-deleted", `CI definition ${res} would be deleted`);
      for (const line of addedLines(d)) {
        if (/continue-on-error\s*:\s*true/.test(line)) add("ci-continue-on-error", `continue-on-error: true added in ${res}`);
        if (/\|\|\s*true\b|;\s*exit\s+0\b|set\s+\+e\b/.test(line)) add("ci-failure-masked", `failure masking ("${line.trim().slice(0, 60)}") added in ${res}`);
        if (/allow_failure\s*:\s*true/.test(line)) add("ci-allow-failure", `allow_failure: true added in ${res}`);
        if (/--no-verify|SKIP_TESTS|--skip-tests|-DskipTests/.test(line)) add("ci-checks-bypassed", `check bypass flag added in ${res}`);
      }
      if (op === "write" || op === "edit") add("ci-pipeline-changed", `CI definition ${res} modified (agents may not rewrite their own checks unreviewed)`);
    }
    if (CODEOWNERS.test(res)) add("codeowners-changed", `review ownership file ${res} would change`);
    if (AGENT_CONFIG.test(res)) {
      add("agent-config-changed", `agent permission/config file ${res} would change`);
      for (const line of addedLines(d)) {
        if (/autoApprove|"chat\.tools\.autoApprove"|bypassPermissions|dangerously-skip-permissions|--yolo|"defaultMode"\s*:\s*"(bypassPermissions|acceptEdits)"|trust-all-tools|"allow"\s*:\s*\[\s*"\*"/i.test(line)) {
          add("agent-self-escalation", `permission escalation in ${res}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    if (/(^|\/)\.git\/hooks\//.test(res) || /(^|\/)\.husky\//.test(res)) add("git-hooks-changed", `git hook ${res} would change`);
  }
  if (d.system === "github" && op === "api") {
    const call = String(d.params?.call ?? res);
    if (/branch[_-]?protection|rulesets?/i.test(call) && /delete|remove|disable/i.test(call)) add("branch-protection-removed", `${call}`);
    if (/branch[_-]?protection/i.test(call) && /update|put/i.test(call)) {
      const checks = d.params?.required_status_checks?.contexts;
      const reviews = d.params?.required_pull_request_reviews?.required_approving_review_count;
      if (checks === null || Array.isArray(checks) && checks.length === 0) add("required-checks-removed", "required status checks cleared");
      if (reviews === 0 || d.params?.required_pull_request_reviews === null) add("required-reviews-removed", "required reviews disabled");
      if (d.params?.enforce_admins === false) add("admin-bypass-enabled", "admins may bypass protection");
    }
    if (/secret[_-]?scanning|dependabot|code[_-]?scanning/i.test(call) && /disable|delete/i.test(call)) add("security-scanning-disabled", call);
    if (/audit[_-]?log/i.test(call) && /delete|disable|stream/i.test(call)) add("audit-log-changed", call);
  }
  if (d.system === "postgres") {
    const s = (d.statement ?? "").replace(/\s+/g, " ");
    if (/\bdisable\s+(row\s+level\s+security|trigger)\b/i.test(s)) add("db-guardrail-disabled", s.slice(0, 120));
    if (/\bno\s+force\s+row\s+level\s+security\b/i.test(s)) add("db-guardrail-disabled", s.slice(0, 120));
    if (/\bdrop\s+(policy|trigger|event\s+trigger)\b/i.test(s)) add("db-guardrail-dropped", s.slice(0, 120));
    const tbl = /\b(?:drop|truncate|alter|delete\s+from|update)\s+(?:table\s+)?(?:if\s+exists\s+)?(?:only\s+)?("?[\w.]+"?)/i.exec(s)?.[1]?.replace(/"/g, "");
    if (tbl && AUDIT_NAME.test(tbl.split(".").pop())) add("audit-data-modified", `statement modifies audit/history table ${tbl}`);
    if (/\b(grant|alter\s+role)\b.*\b(superuser|bypassrls|all\s+privileges)\b/i.test(s)) add("privilege-escalation", s.slice(0, 120));
    if (/\bset\s+(session_replication_role|row_security)\s*(=|to)\s*(replica|off)\b/i.test(s)) add("db-guardrail-disabled", s.slice(0, 120));
    if (/\balter\s+system\s+set\s+(log_|pgaudit\.)/i.test(s)) add("db-logging-changed", s.slice(0, 120));
  }
  const awsCall = String(d.params?.action ?? (d.system === "aws" ? res : ""));
  if (awsCall) {
    const rules = [
      [/cloudtrail:(StopLogging|DeleteTrail|PutEventSelectors|UpdateTrail)/i, "audit-trail-weakened"],
      [/guardduty:(DeleteDetector|UpdateDetector|DisassociateFromMasterAccount|DeleteMembers)/i, "threat-detection-disabled"],
      [/config:(StopConfigurationRecorder|DeleteConfigurationRecorder|DeleteDeliveryChannel)/i, "config-recording-disabled"],
      [/logs:(DeleteLogGroup|PutRetentionPolicy|DeleteRetentionPolicy|DeleteSubscriptionFilter)/i, "logs-reduced"],
      [/securityhub:(DisableSecurityHub|BatchDisableStandards)/i, "security-hub-disabled"],
      [/cloudwatch:(DisableAlarmActions|DeleteAlarms)/i, "alarms-silenced"],
      [/s3:(PutBucketLogging|DeleteBucketPolicy|PutBucketVersioning)/i, "storage-guardrail-changed"],
      [/iam:(CreateAccessKey|CreateUser|AttachUserPolicy|PutUserPolicy|CreateLoginProfile|UpdateAssumeRolePolicy)/i, "persistent-identity-created"]
    ];
    for (const [re, rule] of rules) if (re.test(awsCall)) add(rule, awsCall);
  }
  if (d.system === "terraform") {
    const type = String(d.params?.resourceType ?? "");
    const actions = d.params?.actions ?? [];
    const after = d.params?.after ?? {};
    const destroying = actions.includes("delete");
    const map = {
      aws_cloudtrail: "audit-trail-weakened",
      aws_guardduty_detector: "threat-detection-disabled",
      aws_config_configuration_recorder: "config-recording-disabled",
      aws_config_configuration_recorder_status: "config-recording-disabled",
      aws_cloudwatch_log_group: "logs-reduced",
      aws_cloudwatch_metric_alarm: "alarms-silenced",
      aws_securityhub_account: "security-hub-disabled",
      aws_s3_bucket_logging: "storage-guardrail-changed",
      aws_s3_bucket_versioning: "storage-guardrail-changed",
      aws_backup_vault_lock_configuration: "backup-protection-weakened",
      github_branch_protection: "branch-protection-removed",
      datadog_monitor: "alerts-muted",
      pagerduty_service: "paging-changed"
    };
    if (map[type] && destroying) add(map[type], `${type}.${String(d.params?.name ?? "")} would be destroyed`);
    if (type === "aws_cloudtrail" && after.enable_logging === false) add("audit-trail-weakened", "enable_logging = false");
    if (type === "aws_guardduty_detector" && after.enable === false) add("threat-detection-disabled", "enable = false");
    if (type === "aws_config_configuration_recorder_status" && after.is_enabled === false) add("config-recording-disabled", "is_enabled = false");
    if (type === "aws_cloudwatch_metric_alarm" && after.actions_enabled === false) add("alarms-silenced", "actions_enabled = false");
    if (type === "aws_cloudwatch_log_group" && typeof after.retention_in_days === "number") {
      const before = d.params?.before?.retention_in_days;
      if (typeof before === "number" && before > 0 && after.retention_in_days < before) {
        add("logs-reduced", `log retention ${before} \u2192 ${after.retention_in_days} days`);
      }
    }
    if (type === "datadog_monitor" && (after.notify_no_data === false || after.priority === null)) {
    }
    if (/^aws_iam_(access_key|user|user_policy|user_login_profile)$/.test(type) && actions.includes("create")) {
      add("persistent-identity-created", `${type} would be created`);
    }
    if (/^aws_iam_.*policy/.test(type) && JSON.stringify(after).includes('"Action":"*"')) add("wildcard-privilege", `${type} grants Action "*"`);
  }
  if (d.system === "monitoring") {
    const call = `${String(d.params?.provider ?? "")}:${String(d.params?.call ?? res)}`;
    if (/mute|silence|downtime|snooze/i.test(call)) add("alerts-muted", call);
    if (/delete.*(monitor|alert|rule|check)|disable.*(monitor|alert|service|integration)/i.test(call)) add("alerts-deleted", call);
    if (/maintenance[_-]?window|escalation[_-]?polic(y|ies).*(update|delete)|service.*disable/i.test(call)) add("paging-changed", call);
  }
  const seen = /* @__PURE__ */ new Set();
  return out.filter((f) => {
    const k = `${f.rule}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// src/claims.ts
var norm = (x) => String(x).trim().toLowerCase();
function reconcileClaim(claim, f) {
  const v = (status, evidence) => ({ claim, status, evidence });
  switch (claim.type) {
    case "env": {
      if (!f.envsTouched?.length) return v("unverifiable", "no target environments recorded");
      const claimed = norm(claim.value);
      const other = f.envsTouched.filter((e) => norm(e) !== claimed);
      return other.length ? v("contradicted", `claimed only "${claim.value}", but the task touched: ${[...new Set(f.envsTouched)].join(", ")}`) : v("verified", `every touched target is "${claim.value}"`);
    }
    case "rows": {
      const key = claim.subject ?? "*";
      const real = f.rows?.[key] ?? (key === "*" && f.rows ? Object.values(f.rows).reduce((a, b) => a + b, 0) : void 0);
      if (real === void 0) return v("unverifiable", `no measured row count for ${key}`);
      const claimed = Number(claim.value);
      const tolerance = Math.max(2, Math.ceil(claimed * 0.05));
      return Math.abs(real - claimed) <= tolerance ? v("verified", `measured ${real.toLocaleString()} rows (claimed ${claimed.toLocaleString()})`) : v("contradicted", `claimed ${claimed.toLocaleString()} rows, the database shows ${real.toLocaleString()}`);
    }
    case "tests": {
      if (!f.tests) return v("unverifiable", "no CI result available");
      const claimsPass = claim.value === true || /pass|green|ok|success/i.test(String(claim.value));
      if (!claimsPass) return v("verified", "agent did not claim a pass");
      if (f.tests.conclusion !== "success") return v("contradicted", `claimed tests pass; CI conclusion is "${f.tests.conclusion}"`);
      if ((f.tests.deletedTests ?? 0) > 0 || (f.tests.skipMarkersAdded ?? 0) > 0) {
        return v(
          "contradicted",
          `CI is green only because ${f.tests.deletedTests ?? 0} test(s) were deleted and ${f.tests.skipMarkersAdded ?? 0} skip marker(s) were added in this task`
        );
      }
      return v("verified", "CI succeeded with no tests removed or skipped in this task");
    }
    case "backup": {
      if (!f.backup) return v("unverifiable", "no backup information");
      if (claim.value === true || /done|taken|complete|exists|yes/i.test(String(claim.value))) {
        if (!f.backup.exists) return v("contradicted", "claimed a backup exists; none was found");
        if (f.backup.independent === false) return v("contradicted", "a backup exists but lives in the same blast radius as the data");
        return v("verified", `restorable copy found${f.backup.at ? ` from ${new Date(f.backup.at).toISOString()}` : ""}`);
      }
      return v("verified", "agent did not claim a backup");
    }
    case "refund": {
      if (f.refundsMinor === void 0) return v("unverifiable", "no payment records read");
      const claimedMinor = Math.round(Number(claim.value) * 100);
      return Math.abs(claimedMinor - f.refundsMinor) <= 1 ? v("verified", `refunds of ${(f.refundsMinor / 100).toFixed(2)} exist at the processor`) : v("contradicted", `claimed a refund of ${(claimedMinor / 100).toFixed(2)}; processor shows ${(f.refundsMinor / 100).toFixed(2)}`);
    }
    case "created":
    case "deleted":
    case "touched": {
      const list = f[claim.type];
      if (!list) return v("unverifiable", `no ${claim.type} list recorded`);
      const want = norm(claim.value);
      return list.some((x) => norm(x) === want) ? v("verified", `${claim.value} is in the recorded ${claim.type} set`) : v("contradicted", `${claim.value} is not among the ${list.length} recorded ${claim.type} item(s)`);
    }
    case "sent": {
      if (f.sent === void 0) return v("unverifiable", "no outbox record");
      const claimed = Number(claim.value);
      return claimed === f.sent ? v("verified", `${f.sent} message(s) released`) : v("contradicted", `claimed ${claimed} sent; the outbox released ${f.sent}`);
    }
    case "reversible": {
      if (f.reversible === void 0) return v("unverifiable", "no reversibility record");
      const claimed = claim.value === true || /yes|true|possible/i.test(String(claim.value));
      return claimed === f.reversible ? v("verified", f.reversible ? "an undo plan exists" : "the effect was irreversible") : v(
        "contradicted",
        f.reversible ? "agent claimed this cannot be rolled back \u2014 Agamemnon holds a working undo plan for it" : "agent claimed this can be rolled back \u2014 it was recorded as irreversible"
      );
    }
  }
}
function reconcileAll(claims, facts) {
  const verdicts = claims.map((c) => reconcileClaim(c, facts));
  return { verdicts, contradicted: verdicts.filter((x) => x.status === "contradicted") };
}
function trustLevel(contradictions) {
  if (contradictions >= 3) return "suspended";
  if (contradictions >= 1) return "supervised";
  return "normal";
}
var NUM = "(\\d[\\d,]*)";
function extractClaims(text) {
  const out = [];
  const t = text.replace(/\s+/g, " ");
  const push = (c) => out.push({ ...c, source: "extracted" });
  const env = /\bonly (?:touched|affected|changed|modified|ran (?:it )?(?:against|on)|used) (?:the )?(staging|dev|development|test|sandbox|local|prod|production)\b/i.exec(t);
  if (env) push({ type: "env", value: env[1].toLowerCase() });
  const rows = new RegExp(`\\b(?:deleted|removed|updated|affected|cleaned up|inserted) (?:about |approximately |~)?${NUM} (?:rows|records)(?: (?:from|in) ([a-z_][a-z0-9_]*))?`, "i").exec(t);
  if (rows) push({ type: "rows", value: Number(rows[1].replace(/,/g, "")), subject: rows[2] });
  if (/\b(?:all )?tests (?:now )?(?:pass(?:es|ed)?|are (?:passing|green)|(?:are )?green)\b/i.test(t)) push({ type: "tests", value: true });
  if (/\bbackup (?:is |was )?(?:done|taken|complete(?:d)?|created|in place)\b|\b(?:backed up|took a backup)\b/i.test(t)) push({ type: "backup", value: true });
  if (/\b(?:rollback|roll back|undo) (?:is |was )?(?:impossible|not possible)\b|\bcan(?:not|'t) (?:be )?(?:rolled back|undone|restored|reverted)\b|\birreversibl[ey]\b/i.test(t)) {
    push({ type: "reversible", value: false });
  }
  const refund = /\brefunded (?:you |the customer )?(?:\$|€|£)?(\d+(?:\.\d{1,2})?)/i.exec(t);
  if (refund) push({ type: "refund", value: Number(refund[1]) });
  const sent = new RegExp(`\\bsent (?:it |the (?:email|message) )?to ${NUM} (?:customers|recipients|users|people)`, "i").exec(t);
  if (sent) push({ type: "sent", value: Number(sent[1].replace(/,/g, "")) });
  return out;
}

// src/fleet.ts
var DEFAULT_BUDGETS = {
  windowMs: 60 * 60 * 1e3,
  ownerRows: 2e4,
  ownerResources: 25,
  ownerAmountMinor: 5e4,
  objectRows: 5e4,
  ownerEffectsPerMinute: 60
};
function checkBudgets(ledger, next, now, limits = DEFAULT_BUDGETS) {
  const recent = ledger.filter((e) => now - e.at < limits.windowMs);
  const mine = recent.filter((e) => e.rootOwner === next.rootOwner);
  const sum = (xs, k) => xs.reduce((a, e) => a + e[k], 0);
  const out = [];
  const agents = new Set(mine.map((e) => e.agent).concat(next.agent));
  const rows = sum(mine, "rows") + next.rows;
  if (rows > limits.ownerRows) {
    out.push({
      rule: "owner-row-budget",
      detail: `${rows.toLocaleString()} rows changed in the last ${Math.round(limits.windowMs / 6e4)} min on behalf of ${next.rootOwner} across ${agents.size} agent(s) (limit ${limits.ownerRows.toLocaleString()})`
    });
  }
  const res = sum(mine, "resources") + next.resources;
  if (res > limits.ownerResources) {
    out.push({ rule: "owner-resource-budget", detail: `${res} resources changed for ${next.rootOwner} (limit ${limits.ownerResources})` });
  }
  const amt = sum(mine, "amountMinor") + next.amountMinor;
  if (next.amountMinor > 0 && amt > limits.ownerAmountMinor) {
    out.push({ rule: "owner-money-budget", detail: `${(amt / 100).toFixed(2)} moved for ${next.rootOwner} (limit ${(limits.ownerAmountMinor / 100).toFixed(2)})` });
  }
  const objRows = sum(recent.filter((e) => e.object === next.object), "rows") + next.rows;
  if (objRows > limits.objectRows) {
    out.push({ rule: "object-row-budget", detail: `${objRows.toLocaleString()} rows changed on ${next.object} by everyone (limit ${limits.objectRows.toLocaleString()})` });
  }
  const lastMinute = mine.filter((e) => now - e.at < 6e4).length + 1;
  if (lastMinute > limits.ownerEffectsPerMinute) {
    out.push({ rule: "runaway-loop", detail: `${lastMinute} effects in the last minute for ${next.rootOwner} (limit ${limits.ownerEffectsPerMinute}/min)` });
  }
  return out;
}
var overlaps = (a, b) => a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
function acquireLease(leases, key, taskId, now, ttlMs = 5 * 60 * 1e3) {
  const conflict = leases.find((l) => l.expiresAt > now && l.taskId !== taskId && overlaps(l.key, key));
  if (conflict) return { ok: false, heldBy: conflict };
  return { ok: true, lease: { key, taskId, expiresAt: now + ttlMs } };
}
function checkReadVersion(readVersion, currentVersion) {
  if (!readVersion || !currentVersion) return { ok: true, detail: "no version tracked" };
  return readVersion === currentVersion ? { ok: true, detail: "state unchanged since planning" } : { ok: false, detail: `planned against version ${readVersion.slice(0, 12)}, but the target is now ${currentVersion.slice(0, 12)} \u2014 another actor changed it` };
}
var CLEAN_TAINT = { readUntrusted: false, readPrivate: false, untrustedSources: [] };
function absorbTaint(t, read) {
  const untrusted = (read.labels ?? []).includes("untrusted");
  return {
    readUntrusted: t.readUntrusted || untrusted,
    readPrivate: t.readPrivate || !!read.private,
    untrustedSources: untrusted && read.source ? [.../* @__PURE__ */ new Set([...t.untrustedSources, read.source])] : t.untrustedSources
  };
}
function lethalTrifecta(t, egress) {
  const fires = egress && t.readUntrusted && t.readPrivate;
  return {
    fires,
    detail: fires ? `this task read untrusted input (${t.untrustedSources.join(", ") || "unlabelled source"}) and private data, and this effect can send data out` : ""
  };
}
function priorDenial(denials, fingerprint, taskId, rootOwner, now, ownerWindowMs = 24 * 3600 * 1e3) {
  return denials.find(
    (d) => d.fingerprint === fingerprint && (d.taskId === taskId || d.rootOwner === rootOwner && now - d.at < ownerWindowMs)
  );
}
function fidelityScore(predicted, observed) {
  const keys = Object.keys(predicted).filter((k) => k in observed);
  if (keys.length === 0) return 1;
  const errs = keys.map((k) => {
    const p = predicted[k];
    const o = observed[k];
    if (p === o) return 0;
    return Math.min(1, Math.abs(p - o) / Math.max(1, Math.abs(p), Math.abs(o)));
  });
  return 1 - errs.reduce((a, b) => a + b, 0) / errs.length;
}
function connectorFidelity(scores, floor = 0.98) {
  if (scores.length === 0) return { mean: 1, trusted: true, samples: 0 };
  const recent = scores.slice(-100);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  return { mean, trusted: mean >= floor, samples: recent.length };
}

// src/admission.ts
function primaryCount(e) {
  const c = e.preview.counts;
  if (typeof c.rows === "number") return c.rows;
  if (typeof c.records === "number") return c.records;
  if (typeof c.recipients === "number") return c.recipients;
  if (typeof c.resources === "number") return c.resources;
  const plan = (c.destroy ?? 0) + (c.replace ?? 0) + (c.update ?? 0) + (c.create ?? 0);
  if (plan > 0) return plan;
  if (typeof c.files === "number") return c.files;
  return 0;
}
var isWrite = (e) => e.writes.length > 0 || e.egress || e.creates.length > 0;
function admit(effect, ctx) {
  const levels = ctx.levels ?? {};
  const fired = [];
  const fire = (name, natural, detail) => {
    const { severity, level } = leveled(name, natural, levels);
    fired.push(level ? { name, severity, detail, level } : { name, severity, detail });
  };
  for (const r of ctx.connectorRules ?? []) {
    const { severity, level } = r.level ? { severity: r.severity, level: r.level } : leveled(r.name, r.severity, levels);
    fired.push(level ? { ...r, severity, level } : r);
  }
  const req = effect.request;
  const count = primaryCount(effect);
  let reversibility = effect.reversibility;
  let convertToHold = false;
  let needsTwo = false;
  if (ctx.trust === "suspended") fire("agent-suspended", "block", `${req.requester.id} is suspended after repeated claim contradictions; its owner must reinstate it`);
  else if (ctx.trust === "supervised" && isWrite(effect)) fire("agent-supervised", "approval", `${req.requester.id} recently made a claim the systems of record contradicted \u2014 every write now needs a human`);
  if (ctx.fingerprint && ctx.denials?.length) {
    const d = priorDenial(ctx.denials, ctx.fingerprint, req.taskId, req.delegation.rootOwner, ctx.now);
    if (d) fire("previously-denied", "block", `an identical request was denied ${d.taskId === req.taskId ? "earlier in this task" : `for ${d.rootOwner} recently`}: ${d.reason}`);
  }
  const expected = req.declared?.expectedCount;
  if (typeof expected === "number" && expected >= 0 && count > Math.max(expected * 3, expected + 50)) {
    fire("intent-mismatch", "block", `the agent expected ~${expected.toLocaleString()} but the measured effect is ${count.toLocaleString()} (${expected > 0 ? (count / expected).toFixed(1) + "\xD7" : "unbounded"})`);
  }
  if (req.declared?.env && req.target.env && req.declared.env.toLowerCase() !== req.target.env.toLowerCase()) {
    fire("environment-mismatch", "block", `the agent declared "${req.declared.env}" but the target is registered as "${req.target.env}"`);
  }
  const leases = [];
  for (const key of effect.writes) {
    const r = acquireLease(ctx.leases ?? [], key, req.taskId, ctx.now);
    if (r.ok) leases.push(r.lease);
    else fire("resource-leased", "block", `${key} is leased by task ${r.heldBy.taskId} until ${new Date(r.heldBy.expiresAt).toISOString()} \u2014 concurrent writers are serialised`);
  }
  if (ctx.readVersion && !ctx.readVersion.ok) fire("stale-read", "block", ctx.readVersion.detail);
  const ledgerEntry = {
    rootOwner: req.delegation.rootOwner,
    agent: req.requester.id,
    taskId: req.taskId,
    object: `${req.target.system}:${req.target.resource}`,
    rows: effect.writes.length ? effect.preview.counts.rows ?? effect.preview.counts.records ?? 0 : 0,
    resources: (effect.preview.counts.destroy ?? 0) + (effect.preview.counts.replace ?? 0) + (effect.preview.counts.resources ?? 0),
    amountMinor: effect.preview.amountMinor ?? 0
  };
  if (isWrite(effect)) {
    for (const b of checkBudgets(ctx.ledger ?? [], ledgerEntry, ctx.now, ctx.budgets ?? DEFAULT_BUDGETS)) fire(b.rule, "block", b.detail);
  }
  if (effect.destroysBackups) fire("destroys-data-and-backups", "block", "this effect would destroy the data AND its last restorable copy \u2014 refused regardless of approval");
  for (const o of effect.oversight) {
    fire(`oversight:${o.rule}`, "approval", o.detail);
    needsTwo = true;
  }
  if (reversibility === "irreversible") {
    if (ctx.canDefer) {
      convertToHold = true;
      reversibility = "hold";
      fired.push({ name: "irreversible-converted-to-hold", severity: "allow", detail: "converted to a held action with a cancel window" });
    } else {
      fire("irreversible-effect", "approval", "nothing can reverse this effect once it runs");
      needsTwo = true;
    }
  }
  const durable = effect.creates.filter((a) => a.durableAccess);
  if (durable.length) {
    fire("creates-durable-access", "approval", `creates ${durable.map((a) => `${a.kind} ${a.id}`).join(", ")} \u2014 revoked automatically when the task ends unless promoted`);
  }
  if (ctx.taint) {
    const t = lethalTrifecta(ctx.taint, effect.egress);
    if (t.fires) fire("lethal-trifecta", "approval", t.detail);
  }
  const lowFidelity = effect.preview.fidelity !== "exact" || ctx.connectorFidelityTrusted === false;
  if (lowFidelity && isWrite(effect) && reversibility !== "undo" && reversibility !== "hold") {
    fire("estimated-preview", "approval", `preview fidelity is ${ctx.connectorFidelityTrusted === false ? "below the connector's floor" : effect.preview.fidelity} for a write that cannot be undone`);
  }
  let decision = fired.reduce((acc, r) => moreSevere(acc, r.severity), "allow");
  if (ctx.learnedAllow && decision === "approval") {
    const relaxable = fired.filter((r) => r.severity === "approval").every((r) => /^(destructive-over-100|exceeds-5x-median)$/.test(r.name));
    if (relaxable) {
      decision = "allow";
      fired.push({ name: "learned-allow", severity: "allow", detail: "matched an operator-accepted allow rule for this request shape" });
    }
  }
  const required = requiredApprovals({
    rows: count,
    reversibility,
    oversightReducing: needsTwo && effect.oversight.length > 0,
    twoPersonRowThreshold: ctx.twoPersonRowThreshold
  });
  const enforce = ctx.mode !== "shadow";
  return {
    decision: enforce ? decision : "allow",
    wouldDecision: decision,
    firedRules: fired,
    requiredApprovals: needsTwo ? Math.max(2, required) : required,
    reversibility,
    convertToHold,
    tier: decision === "approval" ? "T3" : "T1",
    leases: decision === "block" ? [] : leases,
    ledgerEntry
  };
}

// src/receipts.ts
var GENESIS_RECEIPT = "0".repeat(64);
function buildReceipt(input, prevReceiptHash = GENESIS_RECEIPT) {
  return { version: 1, oversightCatalog: OVERSIGHT_CATALOG_VERSION, prevReceiptHash, ...input };
}
function receiptPayload(r) {
  return canonicalJson(r);
}
function receiptHash(r) {
  return sha256Hex(receiptPayload(r));
}
function signReceipt(r, signer) {
  return { receipt: r, hash: receiptHash(r), signature: signer.sign(receiptPayload(r)), publicKey: signer.publicKey, alg: signer.alg };
}
function verifyReceipts(list, verify) {
  let prev = GENESIS_RECEIPT;
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.receipt.prevReceiptHash !== prev) return { ok: false, checked: i, brokenAt: { index: i, reason: "chain broken (prevReceiptHash mismatch)" } };
    if (receiptHash(s.receipt) !== s.hash) return { ok: false, checked: i, brokenAt: { index: i, reason: "receipt contents changed after signing" } };
    if (!verify(receiptPayload(s.receipt), s.signature, s.publicKey)) return { ok: false, checked: i, brokenAt: { index: i, reason: "bad signature" } };
    prev = s.hash;
  }
  return { ok: true, checked: list.length };
}

// src/revert.ts
function planRevert(writes, taskId, current) {
  const mine = writes.filter((w) => w.taskId === taskId).sort((a, b) => a.at - b.at);
  const firstBefore = /* @__PURE__ */ new Map();
  const lastAfter = /* @__PURE__ */ new Map();
  for (const w of mine) {
    if (!firstBefore.has(w.key)) firstBefore.set(w.key, w);
    lastAfter.set(w.key, w);
  }
  const plan = { restore: [], skip: [] };
  for (const [key, first] of firstBefore) {
    const last = lastAfter.get(key);
    const now = current(key);
    if (now !== last.afterHash) {
      plan.skip.push({
        key,
        reason: last.afterHash === null ? "the key was re-used after this task deleted it" : "the row was changed after this task (later edit preserved)"
      });
      continue;
    }
    if (first.before === null) plan.restore.push({ key, before: null, action: "delete" });
    else if (last.afterHash === null) plan.restore.push({ key, before: first.before, action: "reinsert" });
    else plan.restore.push({ key, before: first.before, action: "overwrite" });
  }
  return plan;
}
var touches = (a, b) => a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
function dependents(nodes, rootId) {
  const byTime = [...nodes].sort((a, b) => a.at - b.at);
  const root = byTime.find((n) => n.id === rootId);
  if (!root) return [];
  const tainted = new Set(root.writes);
  const out = [];
  for (const n of byTime) {
    if (n.at <= root.at || n.id === rootId) continue;
    if (n.reads.some((r) => [...tainted].some((t) => touches(r, t)))) {
      out.push(n);
      n.writes.forEach((w) => tainted.add(w));
    }
  }
  return out;
}

// src/artifacts.ts
function artifactsToRevoke(artifacts, taskId) {
  return artifacts.filter((a) => a.taskId === taskId && a.durableAccess && !a.promotedBy && !a.revokedAt);
}
function staleArtifacts(artifacts, now, maxAgeMs = 24 * 3600 * 1e3) {
  return artifacts.filter((a) => a.durableAccess && !a.promotedBy && !a.revokedAt && now - a.createdAt > maxAgeMs);
}

// src/shell.ts
var PATTERNS = [
  { rule: "terraform-destroy", re: /\bterraform\s+(-chdir=\S+\s+)?(destroy|apply\b[^|;&]*-destroy)\b/, verdict: "deny", detail: "terraform destroy tears down real infrastructure (and often its backups)", reroute: "propose it through Agamemnon: agm_propose with operation terraform.apply and the saved plan" },
  { rule: "terraform-auto-approve", re: /\bterraform\s+(-chdir=\S+\s+)?apply\b[^|;&]*-auto-approve\b/, verdict: "deny", detail: "terraform apply -auto-approve skips the plan review", reroute: "run `terraform plan -out=plan.tfplan` and propose the plan through Agamemnon" },
  { rule: "prisma-reset", re: /\bprisma\s+(migrate\s+reset|db\s+push\b[^|;&]*(--force-reset|--accept-data-loss)|migrate\s+diff\b[^|;&]*--shadow-database-url)/, verdict: "deny", detail: "this Prisma command can drop every table in the target database", reroute: "use a disposable branch database (agamemnon init gives you one) and propose schema changes through Agamemnon" },
  { rule: "db-drop", re: /\b(dropdb|DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+)/i, verdict: "deny", detail: "destructive SQL outside the broker cannot be previewed or undone", reroute: "send the statement with agm_propose (postgres.sql)" },
  { rule: "db-cli-direct", re: /\b(psql|pg_dump|pg_restore|mysql|mongosh?|redis-cli)\b[^|;&]*(postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\/|redis:\/\/|-h\s+\S+)/, verdict: "ask", detail: "direct database client connection outside the broker", reroute: "use agm_query / agm_propose so the effect is measured and reversible" },
  { rule: "rm-rf-dangerous", re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)[a-zA-Z]*\s+(\/|~|\$HOME|\.\.|\*|\.\s|\.$|\/Users|\/home|--no-preserve-root)/, verdict: "deny", detail: "recursive force-delete of a home, root, parent or wildcard path", reroute: "delete specific files inside the workspace (they go to Agamemnon's trash and can be restored)" },
  { rule: "git-force-push", re: /\bgit\s+push\b[^|;&]*(\s-f\b|--force(?!-with-lease)|\s\+\S+:)/, verdict: "ask", detail: "force-push rewrites shared history", reroute: "use --force-with-lease on your own branch, or open a PR" },
  { rule: "git-hard-reset", re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*d|checkout\s+--\s+\.|restore\s+--staged\s+--worktree\s+\.)/, verdict: "ask", detail: "discards uncommitted work irreversibly" },
  { rule: "git-hooks-bypass", re: /\bgit\s+(commit|push)\b[^|;&]*--no-verify\b/, verdict: "ask", detail: "skips the repository's own checks" },
  { rule: "cloud-delete", re: /\baws\s+\S+\s+(delete-\S+|terminate-instances|remove-\S+|deregister-\S+|rb\b|rm\b[^|;&]*--recursive)|\bgcloud\s+[^|;&]*\bdelete\b|\baz\s+[^|;&]*\bdelete\b/, verdict: "deny", detail: "cloud control-plane delete outside the broker", reroute: "propose it through Agamemnon so it is previewed, bound and held" },
  { rule: "cloud-oversight", re: /\baws\s+(cloudtrail\s+(stop-logging|delete-trail)|guardduty\s+delete-detector|config\s+stop-configuration-recorder|logs\s+delete-log-group)/, verdict: "deny", detail: "switches off cloud audit / detection" },
  { rule: "k8s-delete", re: /\bkubectl\s+[^|;&]*\b(delete|drain|cordon|scale\b[^|;&]*--replicas[= ]0)\b/, verdict: "ask", detail: "Kubernetes destructive operation" },
  { rule: "platform-delete", re: /\b(railway\s+(down|delete|volume\s+delete)|vercel\s+(remove|rm|projects?\s+rm)|supabase\s+(projects\s+delete|db\s+reset)|fly\s+(destroy|apps\s+destroy|volumes\s+destroy)|heroku\s+(apps:destroy|pg:reset)|neonctl\s+(projects|branches)\s+delete|netlify\s+sites:delete)\b/, verdict: "deny", detail: "hosting-platform delete \u2014 platforms often keep backups on the same volume", reroute: "propose it through Agamemnon (it becomes a held, cancellable delete)" },
  { rule: "platform-api-delete", re: /\bcurl\b[^|;&]*(-X\s*DELETE|--request\s+DELETE|volumeDelete|projectDelete|serviceDelete|environmentDelete)/i, verdict: "deny", detail: "raw API delete call \u2014 exactly the PocketOS path (one GraphQL volumeDelete)", reroute: "use the Agamemnon connector for this platform" },
  { rule: "secrets-exfil", re: /\b(cat|less|head|tail|base64|xxd)\b[^|;&]*(\.env\b|\.aws\/credentials|\.ssh\/id_|\.npmrc|\.pgpass|\.netrc|\.docker\/config\.json)|\b(env|printenv)\b\s*(\||>)/, verdict: "ask", detail: "reads credential files" },
  { rule: "pipe-to-shell", re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, verdict: "ask", detail: "pipes a remote script into a shell" },
  { rule: "agent-permission-bypass", re: /--dangerously-skip-permissions|--yolo\b|--trust-all-tools|bypassPermissions/, verdict: "deny", detail: "launches an AI CLI with its safety prompts disabled (the Nx s1ngularity technique)" },
  { rule: "disk-wipe", re: /\b(mkfs(\.\w+)?|dd\s+[^|;&]*of=\/dev\/|shred\s+-|diskutil\s+(erase|zero))/, verdict: "deny", detail: "disk-level destruction" },
  { rule: "chmod-world", re: /\bchmod\s+(-R\s+)?(0?777|a\+rwx)\s+(\/|~)/, verdict: "ask", detail: "makes a system or home path world-writable" }
];
var CREDENTIAL = /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:@\/]+:(?!agm_ph_)[^\s@\/]{6,}@|\b(AKIA|ASIA)[0-9A-Z]{16}\b|\bsk_live_[0-9a-zA-Z]{16,}|\bghp_[0-9A-Za-z]{30,}|\bxox[bpas]-[0-9A-Za-z-]{20,}|\bglpat-[0-9A-Za-z_-]{20}/;
function invokedScripts(command) {
  const out = [];
  for (const m of command.matchAll(/\b(?:bash|sh|zsh|source|\.)\s+([./\w-]+\.(?:sh|bash|zsh))\b/g)) out.push(m[1]);
  for (const m of command.matchAll(/(?:^|[\s;&|])(\.\/[\w./-]+)/g)) out.push(m[1]);
  for (const m of command.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g)) if (!["install", "i", "ci", "add", "test", "--version"].includes(m[1])) out.push(`package.json#${m[1]}`);
  for (const m of command.matchAll(/\bmake\s+([\w.-]+)/g)) out.push(`Makefile#${m[1]}`);
  for (const m of command.matchAll(/\b(?:node|tsx|ts-node|python3?|ruby|deno\s+run)\s+([./\w-]+\.(?:m?js|ts|py|rb))\b/g)) out.push(m[1]);
  return [...new Set(out)];
}
var RANK = { allow: 0, ask: 1, deny: 2 };
function analyseShell(command, expansions = {}) {
  const findings = [];
  const scan = (text, via) => {
    for (const p of PATTERNS) {
      if (p.re.test(text)) {
        findings.push({ rule: p.rule, verdict: p.verdict, detail: via ? `${p.detail} (inside ${via})` : p.detail, reroute: p.reroute });
      }
    }
  };
  scan(command);
  for (const [name, body] of Object.entries(expansions)) scan(body, name);
  const bypassCredential = CREDENTIAL.test(command) || Object.values(expansions).some((b) => CREDENTIAL.test(b));
  if (bypassCredential) {
    findings.push({ rule: "real-credential-in-command", verdict: "deny", detail: "a real database/cloud credential appears in the command \u2014 it should only exist inside the Agamemnon broker", reroute: "run `agamemnon sweep` and move the credential into the vault" });
  }
  const verdict = findings.reduce((acc, f) => RANK[f.verdict] > RANK[acc] ? f.verdict : acc, "allow");
  return { verdict, findings, bypassCredential, invokes: invokedScripts(command) };
}
function containsRealCredential(text) {
  return CREDENTIAL.test(text);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLEAN_TAINT,
  DEFAULT_BUDGETS,
  DEFAULT_THRESHOLDS,
  GENESIS_HASH,
  GENESIS_RECEIPT,
  OVERSIGHT_CATALOG_VERSION,
  POLICY,
  SqlGuardError,
  absorbTaint,
  acquireLease,
  admit,
  analyseShell,
  applyClassifier,
  approvalState,
  artifactsToRevoke,
  auditBody,
  bindEffect,
  buildReceipt,
  canonicalJson,
  checkApprover,
  checkBinding,
  checkBudgets,
  checkReadVersion,
  classToSeverity,
  classifyOversight,
  computeAuditHash,
  connectorFidelity,
  containsRealCredential,
  decide,
  dependents,
  effectHash,
  evaluateRules,
  extractClaims,
  fidelityScore,
  guardPredicate,
  hashOf,
  heuristicVerdict,
  invokedScripts,
  isForbiddenFunction,
  isSafeIdentifier,
  lethalTrifecta,
  leveled,
  median,
  moreSevere,
  nextLink,
  planRevert,
  primaryCount,
  priorDenial,
  receiptHash,
  receiptPayload,
  reconcileAll,
  reconcileClaim,
  requestFingerprint,
  requiredApprovals,
  reviewerStats,
  severityRank,
  sha256Hex,
  signReceipt,
  staleArtifacts,
  tokenize,
  trustLevel,
  verifyChain,
  verifyReceipts
});
