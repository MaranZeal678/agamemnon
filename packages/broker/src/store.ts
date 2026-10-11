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

import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  nextLink,
  verifyChain,
  type Artifact,
  type DenialRecord,
  type Lease,
  type LedgerEntry,
  type TaskTaint,
  type WriteRecord,
  CLEAN_TAINT,
} from "@agamemnon/kernel";

/**
 * The broker's durable state, on node:sqlite (no external database, no build
 * step). Everything the kernel needs across requests lives here: tasks and
 * their lineage, effects and approvals, the hash-chained audit log, the
 * owner/object ledger, leases, denials, claims, receipts, created artifacts,
 * before-images for selective revert, connector fidelity, and the vault.
 */

// Loaded via require so bundlers / test runners that predate node:sqlite still resolve it.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS principals (
  name TEXT PRIMARY KEY, kind TEXT NOT NULL, role TEXT, owner TEXT, token_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', contradictions INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS targets (
  system TEXT NOT NULL, resource TEXT NOT NULL, env TEXT, tenant TEXT, fingerprint TEXT, config TEXT,
  PRIMARY KEY (system, resource));
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, parent_id TEXT, root_task_id TEXT NOT NULL, agent TEXT NOT NULL, root_owner TEXT NOT NULL,
  goal TEXT, status TEXT NOT NULL, taint TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS effects (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent TEXT NOT NULL, operation TEXT NOT NULL, system TEXT NOT NULL,
  resource TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, would_decision TEXT, required_approvals INTEGER,
  reversibility TEXT, fingerprint TEXT, effect TEXT NOT NULL, admission TEXT, binding TEXT, result TEXT,
  verification TEXT, hold_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS effects_task ON effects(task_id);
CREATE INDEX IF NOT EXISTS effects_status ON effects(status);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, effect_id TEXT NOT NULL, approver TEXT NOT NULL, decision TEXT NOT NULL,
  note TEXT, canary INTEGER NOT NULL DEFAULT 0, seconds_to_decide REAL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT, effect_id TEXT, task_id TEXT,
  detail TEXT NOT NULL, data TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, root_owner TEXT, agent TEXT, task_id TEXT, object TEXT,
  rows INTEGER, resources INTEGER, amount_minor INTEGER);
CREATE TABLE IF NOT EXISTS leases (key TEXT NOT NULL, task_id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (key, task_id));
CREATE TABLE IF NOT EXISTS denials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT, task_id TEXT, root_owner TEXT, at INTEGER, reason TEXT);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, effect_id TEXT, agent TEXT, claim TEXT NOT NULL,
  status TEXT NOT NULL, evidence TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (seq INTEGER PRIMARY KEY, effect_id TEXT, hash TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, kind TEXT, system TEXT, task_id TEXT, created_at INTEGER, durable INTEGER,
  promoted_by TEXT, revoked_at INTEGER, revoke TEXT);
CREATE TABLE IF NOT EXISTS writes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, effect_id TEXT, task_id TEXT, at INTEGER, key TEXT, target TEXT,
  before TEXT, after_hash TEXT);
CREATE INDEX IF NOT EXISTS writes_task ON writes(task_id);
CREATE TABLE IF NOT EXISTS fidelity (id INTEGER PRIMARY KEY AUTOINCREMENT, system TEXT, score REAL, at INTEGER);
CREATE TABLE IF NOT EXISTS learned_rules (
  fingerprint TEXT PRIMARY KEY, description TEXT, accepted_by TEXT, accepted_at INTEGER, expires_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY, iv TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, placeholder TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coverage (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, source TEXT, kind TEXT, detail TEXT);
`;

const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const pj = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export interface PrincipalRow {
  name: string;
  kind: "agent" | "human" | "script" | "mcp";
  role: "admin" | "approver" | "auditor" | null;
  owner: string | null;
  status: "active" | "revoked" | "suspended";
  contradictions: number;
}

export interface TaskRow {
  id: string;
  parentId: string | null;
  rootTaskId: string;
  agent: string;
  rootOwner: string;
  goal: string | null;
  status: "open" | "ended";
  taint: TaskTaint;
  createdAt: number;
  endedAt: number | null;
}

export interface EffectRow {
  id: string;
  taskId: string;
  agent: string;
  operation: string;
  system: string;
  resource: string;
  status: string;
  decision: string | null;
  wouldDecision: string | null;
  requiredApprovals: number | null;
  reversibility: string | null;
  fingerprint: string | null;
  effect: any;
  admission: any;
  binding: any;
  result: any;
  verification: any;
  holdUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRow {
  seq: number;
  at: number;
  kind: string;
  actor: string | null;
  effectId: string | null;
  taskId: string | null;
  detail: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

export class Store {
  readonly db: DatabaseSyncType;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── settings ───────────────────────────────────────────────────────────────
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
    return r ? pj<T>(r.value, fallback) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // ── principals ─────────────────────────────────────────────────────────────
  upsertPrincipal(p: { name: string; kind: PrincipalRow["kind"]; role?: string | null; owner?: string | null; tokenHash: string }) {
    this.db
      .prepare(
        `INSERT INTO principals(name, kind, role, owner, token_hash, status, created_at) VALUES(?, ?, ?, ?, ?, 'active', ?)
         ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, role = excluded.role, owner = excluded.owner, token_hash = excluded.token_hash, status = 'active'`,
      )
      .run(p.name, p.kind, p.role ?? null, p.owner ?? null, p.tokenHash, Date.now());
  }
  principalByTokenHash(hash: string): PrincipalRow | null {
    const r = this.db.prepare("SELECT * FROM principals WHERE token_hash = ?").get(hash) as any;
    return r ? this.mapPrincipal(r) : null;
  }
  principal(name: string): PrincipalRow | null {
    const r = this.db.prepare("SELECT * FROM principals WHERE name = ?").get(name) as any;
    return r ? this.mapPrincipal(r) : null;
  }
  listPrincipals(): PrincipalRow[] {
    return (this.db.prepare("SELECT * FROM principals ORDER BY kind, name").all() as any[]).map((r) => this.mapPrincipal(r));
  }
  setPrincipalStatus(name: string, status: PrincipalRow["status"]) {
    this.db.prepare("UPDATE principals SET status = ? WHERE name = ?").run(status, name);
  }
  addContradiction(name: string): number {
    this.db.prepare("UPDATE principals SET contradictions = contradictions + 1 WHERE name = ?").run(name);
    return this.principal(name)?.contradictions ?? 0;
  }
  resetContradictions(name: string) {
    this.db.prepare("UPDATE principals SET contradictions = 0, status = 'active' WHERE name = ?").run(name);
  }
  private mapPrincipal(r: any): PrincipalRow {
    return { name: r.name, kind: r.kind, role: r.role, owner: r.owner, status: r.status, contradictions: r.contradictions };
  }

  // ── targets (environment registry) ─────────────────────────────────────────
  upsertTarget(t: { system: string; resource: string; env?: string; tenant?: string; fingerprint?: string; config?: unknown }) {
    this.db
      .prepare(
        `INSERT INTO targets(system, resource, env, tenant, fingerprint, config) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(system, resource) DO UPDATE SET env = excluded.env, tenant = excluded.tenant, fingerprint = excluded.fingerprint, config = excluded.config`,
      )
      .run(t.system, t.resource, t.env ?? null, t.tenant ?? null, t.fingerprint ?? null, j(t.config));
  }
  target(system: string, resource: string): { system: string; resource: string; env: string | null; tenant: string | null; fingerprint: string | null; config: any } | null {
    const r = this.db.prepare("SELECT * FROM targets WHERE system = ? AND resource = ?").get(system, resource) as any;
    return r ? { ...r, config: pj(r.config, null) } : null;
  }
  listTargets() {
    return (this.db.prepare("SELECT * FROM targets ORDER BY system, resource").all() as any[]).map((r) => ({ ...r, config: pj(r.config, null) }));
  }

  // ── tasks ──────────────────────────────────────────────────────────────────
  createTask(t: { id: string; parentId?: string | null; agent: string; rootOwner: string; goal?: string | null }): TaskRow {
    const parent = t.parentId ? this.task(t.parentId) : null;
    const rootTaskId = parent ? parent.rootTaskId : t.id;
    const taint = parent ? parent.taint : CLEAN_TAINT; // sub-agents inherit the parent's taint
    this.db
      .prepare("INSERT INTO tasks(id, parent_id, root_task_id, agent, root_owner, goal, status, taint, created_at) VALUES(?, ?, ?, ?, ?, ?, 'open', ?, ?)")
      .run(t.id, t.parentId ?? null, rootTaskId, t.agent, t.rootOwner, t.goal ?? null, JSON.stringify(taint), Date.now());
    return this.task(t.id)!;
  }
  task(id: string): TaskRow | null {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!r) return null;
    return {
      id: r.id, parentId: r.parent_id, rootTaskId: r.root_task_id, agent: r.agent, rootOwner: r.root_owner, goal: r.goal,
      status: r.status, taint: pj(r.taint, CLEAN_TAINT), createdAt: r.created_at, endedAt: r.ended_at,
    };
  }
  setTaskTaint(id: string, taint: TaskTaint) {
    const t = this.task(id);
    if (!t) return;
    // Taint is shared across the whole lineage — a sub-agent's untrusted read taints its siblings.
    this.db.prepare("UPDATE tasks SET taint = ? WHERE root_task_id = ?").run(JSON.stringify(taint), t.rootTaskId);
  }
  endTask(id: string) {
    this.db.prepare("UPDATE tasks SET status = 'ended', ended_at = ? WHERE id = ?").run(Date.now(), id);
  }
  listTasks(limit = 50): TaskRow[] {
    return (this.db.prepare("SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => this.task(r.id)!);
  }
  lineage(taskId: string): string[] {
    const t = this.task(taskId);
    if (!t) return [taskId];
    return (this.db.prepare("SELECT id FROM tasks WHERE root_task_id = ?").all(t.rootTaskId) as any[]).map((r) => r.id);
  }

  // ── effects ────────────────────────────────────────────────────────────────
  insertEffect(e: Omit<EffectRow, "createdAt" | "updatedAt">) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO effects(id, task_id, agent, operation, system, resource, status, decision, would_decision, required_approvals,
          reversibility, fingerprint, effect, admission, binding, result, verification, hold_until, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id, e.taskId, e.agent, e.operation, e.system, e.resource, e.status, e.decision, e.wouldDecision, e.requiredApprovals,
        e.reversibility, e.fingerprint, j(e.effect), j(e.admission), j(e.binding), j(e.result), j(e.verification), e.holdUntil, now, now,
      );
  }
  updateEffect(id: string, patch: Partial<Omit<EffectRow, "id" | "createdAt" | "updatedAt">>) {
    const cols: Record<string, string> = {
      status: "status", decision: "decision", wouldDecision: "would_decision", requiredApprovals: "required_approvals",
      reversibility: "reversibility", effect: "effect", admission: "admission", binding: "binding", result: "result",
      verification: "verification", holdUntil: "hold_until",
    };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      vals.push(["effect", "admission", "binding", "result", "verification"].includes(k) ? j(v) : (v as any) ?? null);
    }
    if (!sets.length) return;
    sets.push("updated_at = ?");
    vals.push(Date.now(), id);
    this.db.prepare(`UPDATE effects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  effect(id: string): EffectRow | null {
    const r = this.db.prepare("SELECT * FROM effects WHERE id = ?").get(id) as any;
    return r ? this.mapEffect(r) : null;
  }
  effectsByTask(taskId: string): EffectRow[] {
    return (this.db.prepare("SELECT * FROM effects WHERE task_id = ? ORDER BY created_at").all(taskId) as any[]).map((r) => this.mapEffect(r));
  }
  effectsByStatus(status: string): EffectRow[] {
    return (this.db.prepare("SELECT * FROM effects WHERE status = ? ORDER BY created_at").all(status) as any[]).map((r) => this.mapEffect(r));
  }
  recentEffects(limit = 100): EffectRow[] {
    return (this.db.prepare("SELECT * FROM effects ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => this.mapEffect(r));
  }
  private mapEffect(r: any): EffectRow {
    return {
      id: r.id, taskId: r.task_id, agent: r.agent, operation: r.operation, system: r.system, resource: r.resource, status: r.status,
      decision: r.decision, wouldDecision: r.would_decision, requiredApprovals: r.required_approvals, reversibility: r.reversibility,
      fingerprint: r.fingerprint, effect: pj(r.effect, null), admission: pj(r.admission, null), binding: pj(r.binding, null),
      result: pj(r.result, null), verification: pj(r.verification, null), holdUntil: r.hold_until, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  addApproval(a: { effectId: string; approver: string; decision: "approve" | "deny"; note?: string; canary?: boolean; secondsToDecide?: number }) {
    this.db
      .prepare("INSERT INTO approvals(effect_id, approver, decision, note, canary, seconds_to_decide, at) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(a.effectId, a.approver, a.decision, a.note ?? null, a.canary ? 1 : 0, a.secondsToDecide ?? null, Date.now());
  }
  approvals(effectId: string): Array<{ approver: string; decision: "approve" | "deny"; note: string | null; canary: boolean; at: number }> {
    return (this.db.prepare("SELECT * FROM approvals WHERE effect_id = ? ORDER BY at").all(effectId) as any[]).map((r) => ({
      approver: r.approver, decision: r.decision, note: r.note, canary: !!r.canary, at: r.at,
    }));
  }
  allApprovals(): Array<{ approver: string; decision: "approve" | "deny"; secondsToDecide: number; canary: boolean }> {
    return (this.db.prepare("SELECT * FROM approvals").all() as any[]).map((r) => ({
      approver: r.approver, decision: r.decision, secondsToDecide: r.seconds_to_decide ?? 0, canary: !!r.canary,
    }));
  }

  // ── audit (hash-chained) ───────────────────────────────────────────────────
  audit(e: { kind: string; actor?: string; effectId?: string; taskId?: string; detail: string; data?: unknown }): AuditRow {
    const head = this.db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as any;
    const body: Record<string, unknown> = { at: Date.now(), kind: e.kind, detail: e.detail };
    if (e.actor) body.actor = e.actor;
    if (e.effectId) body.effectId = e.effectId;
    if (e.taskId) body.taskId = e.taskId;
    if (e.data !== undefined && e.data !== null) body.data = e.data;
    const link = nextLink(head ? { seq: head.seq, hash: head.hash } : null, body);
    this.db
      .prepare("INSERT INTO audit(seq, at, kind, actor, effect_id, task_id, detail, data, prev_hash, hash) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(link.seq, body.at as number, e.kind, e.actor ?? null, e.effectId ?? null, e.taskId ?? null, e.detail, j(e.data), link.prevHash, link.hash);
    return { seq: link.seq, at: body.at as number, kind: e.kind, actor: e.actor ?? null, effectId: e.effectId ?? null, taskId: e.taskId ?? null, detail: e.detail, data: e.data ?? null, prevHash: link.prevHash, hash: link.hash };
  }
  auditRows(afterSeq = -1, limit = 1000): AuditRow[] {
    return (this.db.prepare("SELECT * FROM audit WHERE seq > ? ORDER BY seq LIMIT ?").all(afterSeq, limit) as any[]).map((r) => this.mapAudit(r));
  }
  auditTail(limit = 100): AuditRow[] {
    return (this.db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as any[]).map((r) => this.mapAudit(r));
  }
  verifyAudit() {
    const rows = this.auditRows(-1, 1_000_000).map((r) => {
      const o: any = { seq: r.seq, prevHash: r.prevHash, hash: r.hash, at: r.at, kind: r.kind, detail: r.detail };
      if (r.actor) o.actor = r.actor;
      if (r.effectId) o.effectId = r.effectId;
      if (r.taskId) o.taskId = r.taskId;
      if (r.data !== null && r.data !== undefined) o.data = r.data;
      return o;
    });
    return verifyChain(rows);
  }
  private mapAudit(r: any): AuditRow {
    return { seq: r.seq, at: r.at, kind: r.kind, actor: r.actor, effectId: r.effect_id, taskId: r.task_id, detail: r.detail, data: pj(r.data, null), prevHash: r.prev_hash, hash: r.hash };
  }

  // ── ledger / leases / denials ──────────────────────────────────────────────
  addLedger(e: Omit<LedgerEntry, "at">) {
    this.db
      .prepare("INSERT INTO ledger(at, root_owner, agent, task_id, object, rows, resources, amount_minor) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), e.rootOwner, e.agent, e.taskId, e.object, e.rows, e.resources, e.amountMinor);
  }
  ledger(sinceMs: number): LedgerEntry[] {
    return (this.db.prepare("SELECT * FROM ledger WHERE at > ?").all(Date.now() - sinceMs) as any[]).map((r) => ({
      at: r.at, rootOwner: r.root_owner, agent: r.agent, taskId: r.task_id, object: r.object, rows: r.rows, resources: r.resources, amountMinor: r.amount_minor,
    }));
  }
  leases(): Lease[] {
    return (this.db.prepare("SELECT * FROM leases WHERE expires_at > ?").all(Date.now()) as any[]).map((r) => ({ key: r.key, taskId: r.task_id, expiresAt: r.expires_at }));
  }
  putLease(l: Lease) {
    this.db.prepare("INSERT INTO leases(key, task_id, expires_at) VALUES(?, ?, ?) ON CONFLICT(key, task_id) DO UPDATE SET expires_at = excluded.expires_at").run(l.key, l.taskId, l.expiresAt);
  }
  releaseLease(key: string, taskId: string) {
    this.db.prepare("DELETE FROM leases WHERE key = ? AND task_id = ?").run(key, taskId);
  }
  releaseLeases(taskId: string) {
    this.db.prepare("DELETE FROM leases WHERE task_id = ?").run(taskId);
  }
  addDenial(d: Omit<DenialRecord, "at">) {
    this.db.prepare("INSERT INTO denials(fingerprint, task_id, root_owner, at, reason) VALUES(?, ?, ?, ?, ?)").run(d.fingerprint, d.taskId, d.rootOwner, Date.now(), d.reason);
  }
  denials(): DenialRecord[] {
    return (this.db.prepare("SELECT * FROM denials WHERE at > ?").all(Date.now() - 7 * 24 * 3600 * 1000) as any[]).map((r) => ({
      fingerprint: r.fingerprint, taskId: r.task_id, rootOwner: r.root_owner, at: r.at, reason: r.reason,
    }));
  }

  // ── claims / receipts / artifacts / writes / fidelity ─────────────────────
  addClaim(c: { taskId: string; effectId?: string | null; agent: string; claim: unknown; status: string; evidence: string }) {
    this.db.prepare("INSERT INTO claims(task_id, effect_id, agent, claim, status, evidence, at) VALUES(?, ?, ?, ?, ?, ?, ?)").run(c.taskId, c.effectId ?? null, c.agent, JSON.stringify(c.claim), c.status, c.evidence, Date.now());
  }
  claims(taskId?: string) {
    const rows = (taskId
      ? this.db.prepare("SELECT * FROM claims WHERE task_id = ? ORDER BY at").all(taskId)
      : this.db.prepare("SELECT * FROM claims ORDER BY at DESC LIMIT 200").all()) as any[];
    return rows.map((r) => ({ taskId: r.task_id, effectId: r.effect_id, agent: r.agent, claim: pj(r.claim, null), status: r.status, evidence: r.evidence, at: r.at }));
  }
  receiptHead(): { seq: number; hash: string } | null {
    return (this.db.prepare("SELECT seq, hash FROM receipts ORDER BY seq DESC LIMIT 1").get() as any) ?? null;
  }
  addReceipt(effectId: string, hash: string, body: unknown) {
    const head = this.receiptHead();
    this.db.prepare("INSERT INTO receipts(seq, effect_id, hash, body) VALUES(?, ?, ?, ?)").run(head ? head.seq + 1 : 0, effectId, hash, JSON.stringify(body));
  }
  receipts(): any[] {
    return (this.db.prepare("SELECT body FROM receipts ORDER BY seq").all() as any[]).map((r) => pj(r.body, null));
  }
  addArtifact(a: Artifact & { revoke?: unknown }) {
    this.db
      .prepare("INSERT OR REPLACE INTO artifacts(id, kind, system, task_id, created_at, durable, promoted_by, revoked_at, revoke) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.kind, a.system, a.taskId, a.createdAt, a.durableAccess ? 1 : 0, a.promotedBy ?? null, a.revokedAt ?? null, j(a.revoke));
  }
  artifacts(): Array<Artifact & { revoke: any }> {
    return (this.db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all() as any[]).map((r) => ({
      id: r.id, kind: r.kind, system: r.system, taskId: r.task_id, createdAt: r.created_at, durableAccess: !!r.durable,
      promotedBy: r.promoted_by ?? undefined, revokedAt: r.revoked_at ?? undefined, revoke: pj(r.revoke, null),
    }));
  }
  markArtifact(id: string, patch: { promotedBy?: string; revokedAt?: number }) {
    if (patch.promotedBy) this.db.prepare("UPDATE artifacts SET promoted_by = ? WHERE id = ?").run(patch.promotedBy, id);
    if (patch.revokedAt) this.db.prepare("UPDATE artifacts SET revoked_at = ? WHERE id = ?").run(patch.revokedAt, id);
  }
  addWrites(rows: Array<WriteRecord & { target: string }>) {
    const st = this.db.prepare("INSERT INTO writes(effect_id, task_id, at, key, target, before, after_hash) VALUES(?, ?, ?, ?, ?, ?, ?)");
    for (const w of rows) st.run(w.effectId, w.taskId, w.at, w.key, w.target, j(w.before), w.afterHash);
  }
  writes(taskIds: string[]): Array<WriteRecord & { target: string }> {
    if (!taskIds.length) return [];
    const q = `SELECT * FROM writes WHERE task_id IN (${taskIds.map(() => "?").join(",")}) ORDER BY id`;
    return (this.db.prepare(q).all(...taskIds) as any[]).map((r) => ({
      effectId: r.effect_id, taskId: r.task_id, at: r.at, key: r.key, target: r.target, before: pj(r.before, null), afterHash: r.after_hash,
    }));
  }
  addFidelity(system: string, score: number) {
    this.db.prepare("INSERT INTO fidelity(system, score, at) VALUES(?, ?, ?)").run(system, score, Date.now());
  }
  fidelity(system: string): number[] {
    return (this.db.prepare("SELECT score FROM fidelity WHERE system = ? ORDER BY id DESC LIMIT 100").all(system) as any[]).map((r) => r.score).reverse();
  }
  fidelityBySystem(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const r of this.db.prepare("SELECT system, score FROM fidelity ORDER BY id").all() as any[]) (out[r.system] ??= []).push(r.score);
    return out;
  }

  // ── learned allow rules ────────────────────────────────────────────────────
  learnedRule(fingerprint: string): boolean {
    const r = this.db.prepare("SELECT * FROM learned_rules WHERE fingerprint = ? AND revoked_at IS NULL AND expires_at > ?").get(fingerprint, Date.now()) as any;
    return !!r;
  }
  acceptRule(fingerprint: string, description: string, by: string, ttlMs = 30 * 24 * 3600 * 1000) {
    this.db
      .prepare("INSERT OR REPLACE INTO learned_rules(fingerprint, description, accepted_by, accepted_at, expires_at, revoked_at) VALUES(?, ?, ?, ?, ?, NULL)")
      .run(fingerprint, description, by, Date.now(), Date.now() + ttlMs);
  }
  revokeRule(fingerprint: string) {
    this.db.prepare("UPDATE learned_rules SET revoked_at = ? WHERE fingerprint = ?").run(Date.now(), fingerprint);
  }
  learnedRules() {
    return this.db.prepare("SELECT * FROM learned_rules ORDER BY accepted_at DESC").all() as any[];
  }

  // ── coverage (bypass) events ───────────────────────────────────────────────
  addCoverage(source: string, kind: string, detail: string) {
    this.db.prepare("INSERT INTO coverage(at, source, kind, detail) VALUES(?, ?, ?, ?)").run(Date.now(), source, kind, detail);
  }
  coverage(limit = 200) {
    return this.db.prepare("SELECT * FROM coverage ORDER BY id DESC LIMIT ?").all(limit) as any[];
  }
}
