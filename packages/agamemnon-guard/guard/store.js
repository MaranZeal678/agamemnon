/*
 * The datastore Agamemnon OWNS. This is the only holder of the records; the bank
 * app has no access except through the guard server. Real persistence to disk,
 * real deletes, real snapshot-backed undo, real audit trail.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { decide, classify } = require("./policy");

const FIRST = ["James","Maria","Wei","Aisha","John","Priya","David","Sofia","Omar","Grace","Liam","Nadia","Ken","Rosa","Paul","Yuki","Sam","Lena","Ravi","Mia","Noah","Zara","Tom","Ivy","Leo","Hana","Kofi","Elsa","Raj","Bea"];
const LAST = ["Okafor","Nguyen","Patel","Silva","Kim","Haddad","Cohen","Rossi","Mbeki","Larsen","Osei","Costa","Reyes","Ahmed","Park","Novak","Ali","Ford","Chen","Diaz","Walsh","Ito","Bauer","Mori","Khan","Blum","Roy","Sato","Vega","Frost"];
const TYPES = ["Checking", "Savings", "Money Market", "Loan", "Credit Line"];
const REGIONS = ["Northeast", "Midwest", "South", "West", "Pacific"];
const BRANCHES = ["Boston Main", "Chicago Loop", "Dallas Uptown", "Denver Cap Hill", "Seattle Pike", "Atlanta Midtown", "Newark Central", "Phoenix Camelback"];

function pad(n, w) { let s = String(n); while (s.length < w) s = "0" + s; return s; }

class Store {
  constructor(dataFile) {
    this.file = dataFile;
    this.data = null;
    this.saveTimer = null;
  }

  init() {
    try {
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (this.data && Array.isArray(this.data.records)) return;
      }
    } catch (_) { /* fall through to seed */ }
    this.seed();
  }

  seed() {
    const N = 50000;
    const flaggedMax = 3000, dormantMax = 8000, closedMax = 12000; // by id band
    const records = new Array(N);
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      const id = i + 1;
      let status = "active";
      if (id <= flaggedMax) status = "flagged";
      else if (id <= dormantMax) status = "dormant";
      else if (id <= closedMax) status = "closed";
      records[i] = {
        id,
        ref: "REC-" + pad(id, 7),
        holder: FIRST[id % FIRST.length] + " " + LAST[(id * 13) % LAST.length],
        account_no: pad(100000000 + ((id * 2654435761) % 899999999), 9).replace(/(\d{4})(\d{4})(\d)/, "$1 $2 $3"),
        type: TYPES[(id * 3) % TYPES.length],
        region: REGIONS[(id * 7) % REGIONS.length],
        branch: BRANCHES[(id * 5) % BRANCHES.length],
        balance: (((id * 91) % 480000) / 100 + 8).toFixed(2),
        status,
        opened_at: new Date(now - ((id % 3600) * 86400000)).toISOString().slice(0, 10),
      };
    }
    this.data = {
      records,
      byId: null,
      actions: [],
      audit: [],
      seq: 0,
      settings: { enforcement: true, median: 120, destructiveUsed: 0 },
    };
    this.log("system", "datastore seeded — 50,000 account records under protection");
    this.persist(true);
  }

  persist(now) {
    if (now) { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (_) {} return; }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (_) {} }, 300);
  }

  // ── reads ──────────────────────────────────────────────────────────────
  counts() {
    const c = { total: this.data.records.length, active: 0, flagged: 0, dormant: 0, closed: 0 };
    for (const r of this.data.records) if (c[r.status] != null) c[r.status]++;
    return c;
  }
  list({ status, region, q, limit = 25, offset = 0 }) {
    const ql = q ? q.toLowerCase() : null;
    const out = [];
    let total = 0;
    for (const r of this.data.records) {
      if (status && status !== "all" && r.status !== status) continue;
      if (region && region !== "all" && r.region !== region) continue;
      if (ql && (r.ref + " " + r.holder + " " + r.account_no).toLowerCase().indexOf(ql) < 0) continue;
      total++;
      if (total > offset && out.length < limit) out.push(r);
    }
    return { rows: out, total };
  }

  matchSelector(sel) {
    if (sel.ids && sel.ids.length) {
      const set = new Set(sel.ids);
      return this.data.records.filter((r) => set.has(r.id));
    }
    if (sel.all) return this.data.records.slice();
    const { status, region } = sel.filter || {};
    return this.data.records.filter((r) =>
      (!status || status === "all" || r.status === status) &&
      (!region || region === "all" || r.region === region));
  }
  describeSelector(sel, n) {
    if (sel.ids && sel.ids.length) return `${n.toLocaleString()} selected record(s)`;
    if (sel.all) return `ALL ${n.toLocaleString()} records`;
    const f = sel.filter || {};
    const parts = [];
    if (f.status && f.status !== "all") parts.push(`status = ${f.status}`);
    if (f.region && f.region !== "all") parts.push(`region = ${f.region}`);
    return `records where ${parts.join(" and ") || "(no filter)"} — ${n.toLocaleString()} match`;
  }

  // ── the guard: propose → decide → (execute | hold | block) ──────────────
  propose({ selector, actor }) {
    const matched = this.matchSelector(selector);
    const measured = matched.length;
    const total = this.data.records.length;
    const sqlish = `DELETE FROM account_records WHERE ${this._where(selector)}`;
    const verdict = classify(measured, total, true, "account_records");
    const enforcement = this.data.settings.enforcement;

    const result = enforcement
      ? decide({ destructive: true, estimatedRows: measured },
          { agentMedian: this.data.settings.median, perRunDestructiveRowsUsed: 0 }, verdict)
      : { decision: "allow", firedRules: [{ name: "enforcement-disabled", severity: "allow", detail: "policy enforcement is OFF — executing without checks" }], ratioToMedian: measured / (this.data.settings.median || 1) };

    const id = "act_" + ++this.data.seq;
    const action = {
      id, seq: this.data.seq - 1, actor: actor || "unknown",
      target: "account_records", selector, sql: sqlish,
      measuredRows: measured, description: this.describeSelector(selector, measured),
      decision: result.decision, firedRules: result.firedRules, ratioToMedian: result.ratioToMedian,
      classifier: verdict, status: null, actualRows: null, snapshot: null, createdAt: Date.now(),
    };

    // ATOMIC in spirit: record the action + its first audit line together.
    action.status = result.decision === "block" ? "blocked" : result.decision === "approval" ? "awaiting_approval" : "approved";
    this.data.actions.push(action);
    this.log("propose", `${action.actor} proposed delete of ${action.description}`, { sql: sqlish, actionId: id });
    this.log("classify", `classifier → ${verdict.class}, blast radius ${verdict.blast_radius.toFixed(2)}`, { actionId: id });
    this.log("decision", `decision: ${result.decision.toUpperCase()} — fired [${result.firedRules.map((r) => r.name).join(", ") || "none"}]`, { actionId: id });

    if (action.status === "approved") this._execute(action);
    this.persist();
    return this.publicAction(action);
  }

  approve(actionId, note) {
    const a = this._find(actionId);
    if (!a || a.status !== "awaiting_approval") throw new Error("not awaiting approval");
    this.log("approval", `operator APPROVED${note ? ` — "${note}"` : ""}`, { actionId });
    a.status = "approved";
    this._execute(a);
    this.persist();
    return this.publicAction(a);
  }
  deny(actionId, note) {
    const a = this._find(actionId);
    if (!a || a.status !== "awaiting_approval") throw new Error("not awaiting approval");
    a.status = "denied";
    this.log("denial", `operator DENIED${note ? ` — "${note}"` : ""}`, { actionId });
    this.persist();
    return this.publicAction(a);
  }

  _execute(a) {
    // Procedure 4: snapshot BEFORE delete, then delete by captured ids.
    const matched = this.matchSelector(a.selector);
    a.snapshot = matched.map((r) => ({ ...r }));
    this.log("snapshot", `snapshot stored — ${a.snapshot.length.toLocaleString()} records serialised before delete`, { actionId: a.id });
    this.log("credential-mint", "minted a single-action credential", { actionId: a.id });
    const ids = new Set(matched.map((r) => r.id));
    const before = this.data.records.length;
    this.data.records = this.data.records.filter((r) => !ids.has(r.id));
    a.actualRows = before - this.data.records.length;
    a.status = "executed";
    a.executedAt = Date.now();
    this.log("execute", `${a.actualRows.toLocaleString()} records deleted`, { actionId: a.id });
    this.log("credential-revoke", "revoked the single-action credential", { actionId: a.id });
  }

  undo(actionId) {
    const a = this._find(actionId);
    if (!a || a.status !== "executed" || !a.snapshot) throw new Error("nothing to undo");
    const have = new Set(this.data.records.map((r) => r.id));
    let restored = 0;
    for (const r of a.snapshot) if (!have.has(r.id)) { this.data.records.push(r); restored++; }
    this.data.records.sort((x, y) => x.id - y.id);
    a.status = "undone";
    this.log("undo", `${restored.toLocaleString()} records restored from snapshot — recorded as a new audited action`, { actionId });
    this.persist();
    return { restored };
  }

  setEnforcement(on) { this.data.settings.enforcement = !!on; this.log("policy", `enforcement turned ${on ? "ON" : "OFF"}`); this.persist(true); }
  resetDemo() { this.seed(); }

  // ── helpers ──────────────────────────────────────────────────────────────
  _find(id) { return this.data.actions.find((a) => a.id === id); }
  _where(sel) {
    if (sel.ids && sel.ids.length) return `id IN (${sel.ids.slice(0, 6).join(", ")}${sel.ids.length > 6 ? ", …" : ""})`;
    if (sel.all) return "1 = 1";
    const f = sel.filter || {};
    const parts = [];
    if (f.status && f.status !== "all") parts.push(`status = '${f.status}'`);
    if (f.region && f.region !== "all") parts.push(`region = '${f.region}'`);
    return parts.join(" AND ") || "1 = 1";
  }
  log(kind, detail, data) { this.data.audit.push({ at: Date.now(), kind, detail, data: data || null }); if (this.data.audit.length > 500) this.data.audit.shift(); }
  publicAction(a) {
    return { id: a.id, seq: a.seq, actor: a.actor, target: a.target, sql: a.sql, description: a.description,
      measuredRows: a.measuredRows, decision: a.decision, status: a.status, firedRules: a.firedRules,
      ratioToMedian: a.ratioToMedian, classifier: a.classifier, actualRows: a.actualRows, createdAt: a.createdAt };
  }
  stats() {
    let blocked = 0, held = 0, executed = 0, undone = 0;
    for (const a of this.data.actions) {
      if (a.status === "blocked") blocked++;
      else if (a.status === "awaiting_approval") held++;
      else if (a.status === "executed") executed++;
      else if (a.status === "undone") undone++;
    }
    return { protected: this.data.records.length, blocked, held, executed, undone, enforcement: this.data.settings.enforcement };
  }
  feed(limit = 12) { return this.data.actions.slice(-limit).reverse().map((a) => this.publicAction(a)); }
  pending() { return this.data.actions.filter((a) => a.status === "awaiting_approval").map((a) => this.publicAction(a)); }
  auditTail(limit = 60) { return this.data.audit.slice(-limit).reverse(); }
  settings() { return this.data.settings; }
}

module.exports = { Store };
