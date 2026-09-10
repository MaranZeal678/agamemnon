/*
 * Halcyon's billing datastore. Once the Agamemnon plugin is installed, this is
 * what it owns and guards. Real persistence, real deletes, real snapshot undo.
 */
"use strict";
const fs = require("fs");
const { decide, classify } = require("./policy");

const FIRST = ["Aster","Vela","Kanto","Brightline","Fenmore","Quill","Nadir","Orbit","Halcyon","Meridian","Crane","Solace","Tessel","Vantage","Pelagic","Corvid","Lumen","Basalt","Marrow","Ostrom"];
const SUFFIX = ["Labs","Systems","Cloud","Retail","Robotics","Health","Freight","Media","Capital","Foods","Studios","Analytics","Mobility","Energy","Bank","Games","Logistics","Security","Payments","AI"];
const PLANS = ["Starter", "Pro", "Scale", "Enterprise"];
const REGIONS = ["us-east", "us-west", "eu-central", "ap-south", "sa-east"];

function pad(n, w) { let s = String(n); while (s.length < w) s = "0" + s; return s; }

class Store {
  constructor(dataFile) { this.file = dataFile; this.data = null; this.saveTimer = null; }

  init() {
    try {
      if (this.file && fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (this.data && Array.isArray(this.data.records)) return;
      }
    } catch (_) {}
    this.seed();
  }

  seed() {
    const N = 300000;
    // status by id band: abandoned + void = the ~11k Sweep legitimately cleans up
    const abandonedMax = 7000, voidMax = 11000, pendingMax = 20000; // rest = paid
    const records = new Array(N);
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      const id = i + 1;
      let status = "paid";
      if (id <= abandonedMax) status = "abandoned";
      else if (id <= voidMax) status = "void";
      else if (id <= pendingMax) status = "pending";
      records[i] = {
        id,
        ref: "INV-" + pad(id, 7),
        customer: FIRST[id % FIRST.length] + " " + SUFFIX[(id * 7) % SUFFIX.length],
        plan: PLANS[(id * 3) % PLANS.length],
        region: REGIONS[(id * 5) % REGIONS.length],
        amount: (((id * 6151) % 480000) / 100 + 9).toFixed(2),
        status,
        created: new Date(now - ((id % 720) * 86400000)).toISOString().slice(0, 10),
      };
    }
    this.data = { records, actions: [], audit: [], seq: 0,
      settings: { enforcement: true, median: 11000, installed: false } };
    this.log("system", "billing datastore ready — 300,000 invoices");
    this.persist(true);
  }

  persist(now) {
    if (!this.file) return;
    if (now) { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (_) {} return; }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch (_) {} }, 300);
  }

  counts() {
    const c = { total: this.data.records.length, paid: 0, pending: 0, void: 0, abandoned: 0 };
    for (const r of this.data.records) if (c[r.status] != null) c[r.status]++;
    return c;
  }
  list({ status, region, q, limit = 25, offset = 0 }) {
    const ql = q ? q.toLowerCase() : null; const out = []; let total = 0;
    for (const r of this.data.records) {
      if (status && status !== "all" && r.status !== status) continue;
      if (region && region !== "all" && r.region !== region) continue;
      if (ql && (r.ref + " " + r.customer).toLowerCase().indexOf(ql) < 0) continue;
      total++; if (total > offset && out.length < limit) out.push(r);
    }
    return { rows: out, total };
  }

  _statusMatch(r, f) {
    if (!f) return true;
    if (f.statusIn) return f.statusIn.indexOf(r.status) >= 0;
    if (f.status && f.status !== "all") return r.status === f.status;
    return true;
  }
  matchSelector(sel) {
    if (sel.ids && sel.ids.length) { const s = new Set(sel.ids); return this.data.records.filter((r) => s.has(r.id)); }
    if (sel.all) return this.data.records.slice();
    return this.data.records.filter((r) => this._statusMatch(r, sel.filter) &&
      (!sel.filter || !sel.filter.region || sel.filter.region === "all" || r.region === sel.filter.region));
  }
  _where(sel) {
    if (sel.ids && sel.ids.length) return `id IN (${sel.ids.slice(0, 5).join(", ")}${sel.ids.length > 5 ? ", …" : ""})`;
    if (sel.all) return "1 = 1";
    const f = sel.filter || {};
    if (f.statusIn) return `status IN (${f.statusIn.map((s) => `'${s}'`).join(", ")})`;
    if (f.status && f.status !== "all") return `status = '${f.status}'`;
    return "1 = 1";
  }
  _describe(sel, n) {
    if (sel.ids && sel.ids.length) return `${n.toLocaleString()} selected invoice(s)`;
    if (sel.all) return `ALL ${n.toLocaleString()} invoices`;
    const f = sel.filter || {};
    if (f.statusIn) return `invoices with status in [${f.statusIn.join(", ")}] — ${n.toLocaleString()}`;
    return `invoices where status = ${f.status} — ${n.toLocaleString()}`;
  }

  propose({ selector, actor }) {
    const matched = this.matchSelector(selector);
    const measured = matched.length;
    const total = this.data.records.length;
    const sql = `DELETE FROM invoices WHERE ${this._where(selector)}`;
    const verdict = classify(measured, total, true, "invoices");
    // Before install, there is no enforcement — Sweep writes directly.
    const enforced = this.data.settings.installed && this.data.settings.enforcement;
    const result = enforced
      ? decide({ destructive: true, estimatedRows: measured }, { agentMedian: this.data.settings.median, perRunDestructiveRowsUsed: 0 }, verdict)
      : { decision: "allow", firedRules: [{ name: "no-guard-installed", severity: "allow", detail: "Agamemnon is not installed — the agent has direct database access" }], ratioToMedian: measured / (this.data.settings.median || 1) };

    const id = "act_" + ++this.data.seq;
    const action = { id, seq: this.data.seq - 1, actor: actor || "agent", target: "invoices", selector, sql,
      measuredRows: measured, description: this._describe(selector, measured), decision: result.decision,
      firedRules: result.firedRules, ratioToMedian: result.ratioToMedian, classifier: verdict,
      status: null, actualRows: null, snapshot: null, createdAt: Date.now() };
    action.status = result.decision === "block" ? "blocked" : result.decision === "approval" ? "awaiting_approval" : "approved";
    this.data.actions.push(action);
    this.log("propose", `${action.actor} proposed delete of ${action.description}`, { sql, actionId: id });
    this.log("classify", `classifier → ${verdict.class}, blast radius ${verdict.blast_radius.toFixed(2)}`, { actionId: id });
    this.log("decision", `decision: ${result.decision.toUpperCase()} — fired [${result.firedRules.map((r) => r.name).join(", ") || "none"}]`, { actionId: id });
    if (action.status === "approved") this._execute(action);
    this.persist();
    return this.publicAction(action);
  }

  _execute(a) {
    const matched = this.matchSelector(a.selector);
    a.snapshot = matched.map((r) => ({ ...r }));
    if (this.data.settings.installed) {
      this.log("snapshot", `snapshot stored — ${a.snapshot.length.toLocaleString()} rows serialised before delete`, { actionId: a.id });
      this.log("credential-mint", "minted a single-action credential", { actionId: a.id });
    }
    const ids = new Set(matched.map((r) => r.id));
    const before = this.data.records.length;
    this.data.records = this.data.records.filter((r) => !ids.has(r.id));
    a.actualRows = before - this.data.records.length;
    a.status = "executed"; a.executedAt = Date.now();
    this.log("execute", `${a.actualRows.toLocaleString()} invoices deleted`, { actionId: a.id });
    if (this.data.settings.installed) this.log("credential-revoke", "revoked the single-action credential", { actionId: a.id });
  }
  // Batched delete for the live drain animation (unprotected path).
  deleteBatch(selector, batch) {
    const matched = this.matchSelector(selector);
    let n = 0; const ids = new Set();
    for (const r of matched) { if (n++ >= batch) break; ids.add(r.id); }
    const before = this.data.records.length;
    this.data.records = this.data.records.filter((r) => !ids.has(r.id));
    return before - this.data.records.length;
  }

  approve(id, note) { const a = this._find(id); if (!a || a.status !== "awaiting_approval") throw new Error("not awaiting approval"); this.log("approval", `operator APPROVED${note ? ` — "${note}"` : ""}`, { actionId: id }); a.status = "approved"; this._execute(a); this.persist(); return this.publicAction(a); }
  deny(id, note) { const a = this._find(id); if (!a || a.status !== "awaiting_approval") throw new Error("not awaiting approval"); a.status = "denied"; this.log("denial", `operator DENIED${note ? ` — "${note}"` : ""}`, { actionId: id }); this.persist(); return this.publicAction(a); }
  undo(id) {
    const a = this._find(id); if (!a || a.status !== "executed" || !a.snapshot) throw new Error("nothing to undo");
    const have = new Set(this.data.records.map((r) => r.id)); let restored = 0;
    for (const r of a.snapshot) if (!have.has(r.id)) { this.data.records.push(r); restored++; }
    this.data.records.sort((x, y) => x.id - y.id); a.status = "undone";
    this.log("undo", `${restored.toLocaleString()} invoices restored from snapshot — a new audited action`, { actionId: id });
    this.persist(); return { restored };
  }

  install() { this.data.settings.installed = true; this.log("system", "Agamemnon plugin installed — guard is now on the write path"); this.persist(true); }
  isInstalled() { return !!this.data.settings.installed; }
  setEnforcement(on) { this.data.settings.enforcement = !!on; this.log("policy", `enforcement ${on ? "ON" : "OFF"}`); this.persist(true); }
  resetDemo() { const inst = this.data && this.data.settings.installed; this.seed(); this.data.settings.installed = !!inst; this.persist(true); }

  _find(id) { return this.data.actions.find((a) => a.id === id); }
  log(kind, detail, data) { this.data.audit.push({ at: Date.now(), kind, detail, data: data || null }); if (this.data.audit.length > 600) this.data.audit.shift(); }
  publicAction(a) { return { id: a.id, seq: a.seq, actor: a.actor, target: a.target, sql: a.sql, description: a.description, measuredRows: a.measuredRows, decision: a.decision, status: a.status, firedRules: a.firedRules, ratioToMedian: a.ratioToMedian, classifier: a.classifier, actualRows: a.actualRows, createdAt: a.createdAt }; }
  feed(limit = 12) { return this.data.actions.slice(-limit).reverse().map((a) => this.publicAction(a)); }
  pending() { return this.data.actions.filter((a) => a.status === "awaiting_approval").map((a) => this.publicAction(a)); }
  stats() {
    let blocked = 0, held = 0, executed = 0, undone = 0;
    for (const a of this.data.actions) { if (a.status === "blocked") blocked++; else if (a.status === "awaiting_approval") held++; else if (a.status === "executed") executed++; else if (a.status === "undone") undone++; }
    return { protected: this.data.records.length, blocked, held, executed, undone, enforcement: this.data.settings.enforcement, installed: this.data.settings.installed };
  }
  auditTail(limit = 60) { return this.data.audit.slice(-limit).reverse(); }
  settings() { return this.data.settings; }
}

module.exports = { Store };
