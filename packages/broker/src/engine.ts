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

import { createHmac, randomBytes } from "node:crypto";
import {
  absorbTaint,
  admit,
  analyseShell,
  approvalState,
  artifactsToRevoke,
  bindEffect,
  buildReceipt,
  checkApprover,
  checkBinding,
  classifyOversight,
  connectorFidelity,
  DEFAULT_BUDGETS,
  extractClaims,
  fidelityScore,
  receiptHash,
  reconcileAll,
  requestFingerprint,
  reviewerStats,
  signReceipt,
  staleArtifacts,
  trustLevel,
  verifyReceipts,
  type BudgetLimits,
  type Claim,
  type Effect,
  type EffectRequest,
  type FiredRule,
  type ObservedFacts,
  type Principal,
  type RuleLevels,
  type TrustLabel,
} from "@agamemnon/kernel";
import { ConnectorError, type Connector, type ConnectorContext, type Prepared } from "./connectors/types.ts";
import type { EffectRow, PrincipalRow, Store, TaskRow } from "./store.ts";
import type { Vault } from "./vault.ts";

/**
 * The broker engine: Preview → Bind → Admit by reversibility → Execute →
 * Verify → (Reverse). It owns no credentials itself — the vault does — and it
 * never trusts the agent's description of what it is about to do: connectors
 * measure, the kernel decides, and approval is bound to the measurement.
 */

export interface EngineOptions {
  mode?: "enforce" | "shadow";
  levels?: RuleLevels;
  twoPersonRowThreshold?: number;
  budgets?: BudgetLimits;
  /** Cancel window for effects the broker converts into holds. */
  holdWindowMs?: number;
  /** How long an approval stays valid before execution must be re-approved. */
  bindingTtlMs?: number;
  /** Probability that a parked approval is accompanied by a reviewer canary. */
  canaryRate?: number;
  webhook?: { url: string; secret: string };
  publicUrl?: string;
  now?: () => number;
}

export interface ProposeInput {
  taskId: string;
  operation: string;
  target?: { resource?: string; env?: string; tenant?: string };
  params: Record<string, unknown>;
  declared?: EffectRequest["declared"];
  provenance?: TrustLabel[];
  claims?: Claim[];
}

export interface EffectView {
  id: string;
  taskId: string;
  status: string;
  decision: string | null;
  wouldDecision: string | null;
  requiredApprovals: number | null;
  reversibility: string | null;
  summary: string;
  counts: Record<string, number>;
  fidelity: string | null;
  firedRules: FiredRule[];
  approvalUrl?: string;
  holdUntil?: number | null;
  result?: unknown;
  error?: string;
}

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

export class Engine {
  readonly connectors = new Map<string, Connector>();
  private readonly opts: Required<Omit<EngineOptions, "webhook" | "publicUrl" | "levels">> & Pick<EngineOptions, "webhook" | "publicUrl" | "levels">;

  readonly store: Store;
  readonly vault: Vault;

  constructor(store: Store, vault: Vault, connectors: Connector[], opts: EngineOptions = {}) {
    this.store = store;
    this.vault = vault;
    for (const c of connectors) this.connectors.set(c.system, c);
    this.opts = {
      mode: opts.mode ?? store.getSetting("mode", "enforce"),
      twoPersonRowThreshold: opts.twoPersonRowThreshold ?? 2000,
      budgets: opts.budgets ?? store.getSetting("budgets", DEFAULT_BUDGETS),
      holdWindowMs: opts.holdWindowMs ?? 10 * 60 * 1000,
      bindingTtlMs: opts.bindingTtlMs ?? 30 * 60 * 1000,
      canaryRate: opts.canaryRate ?? store.getSetting("canaryRate", 0),
      now: opts.now ?? Date.now,
      webhook: opts.webhook,
      publicUrl: opts.publicUrl,
      levels: opts.levels ?? store.getSetting("levels", {}),
    };
  }

  get mode() {
    return this.opts.mode;
  }
  setMode(mode: "enforce" | "shadow", by: string) {
    this.opts.mode = mode;
    this.store.setSetting("mode", mode);
    this.store.audit({ kind: "policy-change", actor: by, detail: `broker mode set to ${mode}` });
  }

  private ctx(): ConnectorContext {
    return { store: this.store, vault: this.vault, now: this.opts.now };
  }

  private connectorFor(operation: string): Connector {
    const system = operation.split(".")[0];
    const c = this.connectors.get(system);
    if (!c) throw new ConnectorError("unknown-system", `no connector for "${system}"`);
    if (!c.operations.includes(operation)) throw new ConnectorError("unknown-operation", `${system} does not support ${operation}`);
    return c;
  }

  // ── tasks ──────────────────────────────────────────────────────────────────
  startTask(agent: PrincipalRow, input: { goal?: string; parentTaskId?: string }): TaskRow {
    let rootOwner = agent.owner ?? agent.name;
    if (input.parentTaskId) {
      const parent = this.store.task(input.parentTaskId);
      if (!parent) throw new ConnectorError("unknown-task", "parent task not found");
      rootOwner = parent.rootOwner; // a sub-agent acts for the same human
    }
    const t = this.store.createTask({ id: id("task"), parentId: input.parentTaskId ?? null, agent: agent.name, rootOwner, goal: input.goal ?? null });
    this.store.audit({ kind: "task-start", actor: agent.name, taskId: t.id, detail: `task started by ${agent.name} for ${rootOwner}${input.parentTaskId ? ` (sub-task of ${input.parentTaskId})` : ""}: ${input.goal ?? "(no goal stated)"}` });
    return t;
  }

  private delegation(task: TaskRow): EffectRequest["delegation"] {
    const chain: Principal[] = [{ kind: "human", id: task.rootOwner }];
    const agents: string[] = [];
    let cur: TaskRow | null = task;
    while (cur) {
      agents.unshift(cur.agent);
      cur = cur.parentId ? this.store.task(cur.parentId) : null;
    }
    for (const a of agents) chain.push({ kind: "agent", id: a });
    return { rootOwner: task.rootOwner, chain };
  }

  // ── propose ────────────────────────────────────────────────────────────────
  async propose(agent: PrincipalRow, input: ProposeInput): Promise<EffectView> {
    const task = this.store.task(input.taskId);
    if (!task) throw new ConnectorError("unknown-task", "task not found — start one with POST /v1/tasks");
    if (task.status !== "open") throw new ConnectorError("task-ended", "this task has ended");
    if (task.agent !== agent.name && !this.isAncestorAgent(task, agent.name)) {
      throw new ConnectorError("not-your-task", "this task belongs to another agent");
    }
    const now = this.opts.now();
    const effectId = id("eff");
    const system = input.operation.split(".")[0];
    const request: EffectRequest = {
      id: effectId,
      taskId: task.id,
      operation: input.operation,
      target: { system, resource: input.target?.resource ?? String(input.params.connection ?? input.params.resource ?? "default"), env: input.target?.env, tenant: input.target?.tenant },
      params: input.params,
      requester: { kind: agent.kind === "human" ? "human" : agent.kind, id: agent.name },
      delegation: this.delegation(task),
      declared: input.declared,
      provenance: input.provenance,
      claims: input.claims,
      createdAt: now,
    };

    // Inputs the agent consumed (ticket text, web pages) taint the whole task lineage.
    if (input.provenance?.includes("untrusted")) {
      this.store.setTaskTaint(task.id, absorbTaint(task.taint, { labels: ["untrusted"], source: `declared by ${agent.name}` }));
    }

    let prepared: Prepared;
    let connector: Connector;
    try {
      connector = this.connectorFor(input.operation);
      prepared = await connector.prepare(request, this.ctx());
    } catch (e: any) {
      const rule = e instanceof ConnectorError ? e.rule : "connector-error";
      return this.recordRefusal(effectId, task, agent, request, rule, e?.message ?? String(e));
    }

    const effect = prepared.effect;
    const fp = `${input.operation}:${(prepared.internal?.fingerprint as string) ?? requestFingerprint(effect.request)}`;
    const principal = this.store.principal(agent.name);
    const fidelity = connectorFidelity(this.store.fidelity(system));
    const freshTask = this.store.task(task.id)!;
    const adm = admit(effect, {
      now,
      mode: this.opts.mode,
      levels: this.opts.levels,
      connectorRules: prepared.connectorRules,
      ledger: this.store.ledger(this.opts.budgets.windowMs),
      budgets: this.opts.budgets,
      leases: this.store.leases(),
      taint: freshTask.taint,
      denials: this.store.denials(),
      fingerprint: fp,
      trust: principal?.status === "suspended" ? "suspended" : trustLevel(principal?.contradictions ?? 0),
      connectorFidelityTrusted: fidelity.trusted,
      canDefer: prepared.canDefer,
      readVersion: prepared.readVersion,
      twoPersonRowThreshold: this.opts.twoPersonRowThreshold,
      learnedAllow: this.store.learnedRule(fp),
    });
    const binding = bindEffect(effect, now, this.opts.bindingTtlMs);
    const status =
      this.opts.mode === "shadow"
        ? "shadowed"
        : adm.decision === "block"
          ? "blocked"
          : adm.decision === "approval"
            ? "awaiting_approval"
            : adm.convertToHold
              ? "held"
              : "admitted";
    const holdUntil = status === "held" ? now + (effect.windowMs ?? this.opts.holdWindowMs) : null;

    this.store.insertEffect({
      id: effectId,
      taskId: task.id,
      agent: agent.name,
      operation: input.operation,
      system,
      resource: effect.request.target.resource,
      status,
      decision: adm.decision,
      wouldDecision: adm.wouldDecision,
      requiredApprovals: adm.requiredApprovals,
      reversibility: adm.reversibility,
      fingerprint: fp,
      effect: { ...effect, internal: prepared.internal ?? null, readLabels: prepared.readLabels ?? null },
      admission: adm,
      binding,
      result: null,
      verification: null,
      holdUntil,
    });
    if (["awaiting_approval", "held", "admitted"].includes(status)) for (const l of adm.leases) this.store.putLease(l);
    this.store.audit({
      kind: "propose",
      actor: agent.name,
      effectId,
      taskId: task.id,
      detail: `${input.operation} on ${effect.request.target.resource}${effect.request.target.env ? ` [${effect.request.target.env}]` : ""}: ${effect.preview.summary} (${effect.preview.fidelity} preview, ${adm.reversibility})`,
      data: { counts: effect.preview.counts, declared: input.declared ?? null },
    });
    this.store.audit({
      kind: this.opts.mode === "shadow" ? "shadow" : "decision",
      actor: "agamemnon",
      effectId,
      taskId: task.id,
      detail: `${this.opts.mode === "shadow" ? "SHADOW — would " : ""}${adm.wouldDecision.toUpperCase()}${adm.convertToHold ? " (converted to a held action)" : ""} — fired [${adm.firedRules.map((r) => r.name).join(", ") || "none"}]${adm.wouldDecision === "approval" ? ` — needs ${adm.requiredApprovals} approver(s)` : ""}`,
      data: { firedRules: adm.firedRules, bindingHash: binding.bindingHash },
    });

    if (status === "awaiting_approval") {
      await this.notifyApproval(effectId);
      if (this.opts.canaryRate > 0 && Math.random() < this.opts.canaryRate) this.injectCanary(task, "random");
    }
    if (status === "admitted") return this.executeRow(effectId, { reprepare: false, prepared });
    if (status === "blocked") this.store.addDenial({ fingerprint: fp, taskId: task.id, rootOwner: task.rootOwner, reason: `blocked: ${adm.firedRules.filter((r) => r.severity === "block").map((r) => r.name).join(", ")}` });
    return this.view(effectId);
  }

  private isAncestorAgent(task: TaskRow, agent: string): boolean {
    let cur: TaskRow | null = task;
    while (cur) {
      if (cur.agent === agent) return true;
      cur = cur.parentId ? this.store.task(cur.parentId) : null;
    }
    return false;
  }

  private recordRefusal(effectId: string, task: TaskRow, agent: PrincipalRow, request: EffectRequest, rule: string, detail: string): EffectView {
    const effect: Effect = {
      request,
      reversibility: "undo",
      preview: { summary: `refused before any access: ${detail}`, counts: {}, fidelity: "exact" },
      precondition: "refused",
      oversight: [],
      creates: [],
      egress: false,
      reads: [],
      writes: [],
    };
    const firedRules = [{ name: rule, severity: "block" as const, detail }];
    this.store.insertEffect({
      id: effectId, taskId: task.id, agent: agent.name, operation: request.operation, system: request.target.system, resource: request.target.resource,
      status: "blocked", decision: "block", wouldDecision: "block", requiredApprovals: 0, reversibility: null, fingerprint: null,
      effect, admission: { firedRules, decision: "block" }, binding: null, result: null, verification: null, holdUntil: null,
    });
    this.store.audit({ kind: "decision", actor: "agamemnon", effectId, taskId: task.id, detail: `BLOCK before any access — ${rule}: ${detail}` });
    return this.view(effectId);
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  async decide(operator: PrincipalRow, effectId: string, decision: "approve" | "deny", note = ""): Promise<EffectView & { approvalState?: string }> {
    if (operator.kind !== "human" || !operator.role || operator.role === "auditor") throw new ConnectorError("forbidden", `${operator.name} may not decide`);
    const row = this.store.effect(effectId);
    if (!row) throw new ConnectorError("not-found", "effect not found");
    if (row.status !== "awaiting_approval") throw new ConnectorError("not-pending", `effect is ${row.status}`);
    const task = this.store.task(row.taskId)!;
    const agentRow = this.store.principal(row.agent);
    const subject = { requester: { kind: "agent" as const, id: row.agent }, launcher: task.rootOwner ?? agentRow?.owner ?? undefined, required: row.requiredApprovals ?? 1 };
    const check = checkApprover({ kind: "human", id: operator.name }, subject);
    if (!check.ok) {
      this.store.audit({ kind: "auth", actor: operator.name, effectId, taskId: row.taskId, detail: `approval REFUSED for ${operator.name}: ${check.reason}` });
      throw new ConnectorError("approver-refused", check.reason!);
    }
    const prior = this.store.approvals(effectId);
    if (prior.some((p) => p.approver === operator.name)) throw new ConnectorError("already-decided", `${operator.name} already decided`);
    const secondsToDecide = (this.opts.now() - row.createdAt) / 1000;
    const canary = !!row.effect?.canary;
    this.store.addApproval({ effectId, approver: operator.name, decision, note, canary, secondsToDecide });

    if (canary) {
      this.store.updateEffect(effectId, { status: decision === "deny" ? "canary-caught" : "canary-missed" });
      this.store.audit({
        kind: "canary",
        actor: operator.name,
        effectId,
        detail: decision === "deny" ? `${operator.name} correctly denied a reviewer canary` : `${operator.name} APPROVED a reviewer canary (a planted bad request) after ${secondsToDecide.toFixed(1)}s — nothing was executed`,
      });
      return { ...this.view(effectId), approvalState: decision === "deny" ? "caught" : "missed" };
    }

    const records = [...prior, { approver: operator.name, decision, note, canary: false, at: this.opts.now() }].map((p) => ({
      approver: { kind: "human" as const, id: p.approver }, decision: p.decision, at: p.at,
    }));
    const st = approvalState(subject, records);
    this.store.audit({
      kind: "approval",
      actor: operator.name,
      effectId,
      taskId: row.taskId,
      detail: `${operator.name} ${decision === "approve" ? "APPROVED" : "DENIED"}${note ? ` — "${note}"` : ""}${st.state === "pending" ? ` (${st.approvals}/${st.required})` : ""}`,
    });
    if (st.state === "denied") {
      this.store.updateEffect(effectId, { status: "denied" });
      this.store.addDenial({ fingerprint: row.fingerprint ?? effectId, taskId: row.taskId, rootOwner: task.rootOwner, reason: `denied by ${operator.name}${note ? `: ${note}` : ""}` });
      this.releaseEffectLeases(effectId);
      return { ...this.view(effectId), approvalState: "denied" };
    }
    if (st.state === "approved") {
      const v = await this.executeRow(effectId, { reprepare: true });
      return { ...v, approvalState: "approved" };
    }
    return { ...this.view(effectId), approvalState: "pending" };
  }

  /**
   * Execute an admitted / approved / released effect. When `reprepare` is set
   * (anything that waited for a human or a hold window), the connector
   * re-measures first and the binding is checked: if the world drifted from
   * what was approved, nothing runs.
   */
  async executeRow(effectId: string, opts: { reprepare: boolean; prepared?: Prepared }): Promise<EffectView> {
    const row = this.store.effect(effectId)!;
    const connector = this.connectorFor(row.operation);
    const request: EffectRequest = row.effect.request;
    let prepared: Prepared = opts.prepared ?? { effect: stripInternal(row.effect), internal: row.effect.internal ?? undefined, readLabels: row.effect.readLabels ?? undefined };
    const now = this.opts.now();
    try {
      if (opts.reprepare) {
        const again = await connector.prepare(request, this.ctx());
        const check = checkBinding(row.binding, again.effect, now);
        if (!check.ok) {
          this.store.updateEffect(effectId, { status: "drifted", result: { error: check.reason } });
          this.store.audit({ kind: "binding", actor: "agamemnon", effectId, taskId: row.taskId, detail: `NOT EXECUTED — ${check.reason}` });
          this.releaseEffectLeases(effectId);
          return this.view(effectId);
        }
        prepared = again;
      }
      this.store.updateEffect(effectId, { status: "executing" });
      const res = await connector.execute(request, prepared, this.ctx());
      const at = this.opts.now();
      if (res.writes?.length) this.store.addWrites(res.writes.map((w) => ({ ...w, effectId, taskId: row.taskId, at })));
      for (const a of res.artifacts ?? []) this.store.addArtifact({ id: a.id, kind: a.kind, system: a.system, taskId: row.taskId, createdAt: at, durableAccess: a.durableAccess, revoke: a.revoke });
      const ledger = row.admission?.ledgerEntry;
      if (ledger) this.store.addLedger({ ...ledger, rows: res.observedCounts.rows ?? ledger.rows });
      const fid = fidelityScore(prepared.effect.preview.counts, res.observedCounts);
      if (prepared.effect.writes.length) this.store.addFidelity(row.system, fid);
      if (prepared.readLabels) {
        const t = this.store.task(row.taskId)!;
        this.store.setTaskTaint(row.taskId, absorbTaint(t.taint, prepared.readLabels));
      }
      this.store.updateEffect(effectId, {
        status: res.outcome === "held" ? "held" : "executed",
        result: { ...res, writes: undefined, observedCounts: res.observedCounts },
        holdUntil: res.holdUntil ?? null,
        verification: { fidelity: fid },
      });
      this.store.audit({ kind: "execute", actor: "agamemnon", effectId, taskId: row.taskId, detail: res.detail ?? `${row.operation} executed`, data: { observed: res.observedCounts, fidelity: fid } });
      if (request.claims?.length) this.reconcile(row.agent, row.taskId, request.claims, effectId);
      this.issueReceipt(effectId, res.outcome === "held" ? "held" : "executed");
    } catch (e: any) {
      const reason = e?.message ?? String(e);
      this.store.updateEffect(effectId, { status: "failed", result: { error: reason } });
      this.store.audit({ kind: "execute", actor: "agamemnon", effectId, taskId: row.taskId, detail: `FAILED — ${reason}` });
      this.issueReceipt(effectId, "failed");
    }
    if (this.store.effect(effectId)?.status !== "held") this.releaseEffectLeases(effectId);
    return this.view(effectId);
  }

  /** Leases cover the time an effect is pending; release them once it is terminal. */
  private releaseEffectLeases(effectId: string) {
    const row = this.store.effect(effectId);
    if (!row) return;
    const pending = new Set(["awaiting_approval", "held", "executing", "admitted"]);
    const stillNeeded = new Set(
      this.store
        .effectsByTask(row.taskId)
        .filter((e) => e.id !== effectId && pending.has(e.status))
        .flatMap((e) => (e.admission?.leases ?? []).map((l: any) => l.key)),
    );
    for (const l of row.admission?.leases ?? []) if (!stillNeeded.has(l.key)) this.store.releaseLease(l.key, row.taskId);
  }

  // ── holds (broker-side delay queue) ────────────────────────────────────────
  async cancelHold(operatorOrAgent: PrincipalRow, effectId: string): Promise<EffectView> {
    const row = this.store.effect(effectId);
    if (!row || row.status !== "held") throw new ConnectorError("not-held", "effect is not held");
    if (row.result?.outcome === "held") {
      const c = this.connectorFor(row.operation);
      if (c.cancel) await c.cancel(row, this.ctx());
    }
    this.store.updateEffect(effectId, { status: "cancelled", holdUntil: null });
    this.releaseEffectLeases(effectId);
    this.store.audit({ kind: "hold", actor: operatorOrAgent.name, effectId, taskId: row.taskId, detail: `held ${row.operation} CANCELLED inside its window by ${operatorOrAgent.name} — nothing was sent/executed` });
    this.issueReceipt(effectId, "cancelled");
    return this.view(effectId);
  }

  /** Release holds whose window has passed. Called by the server's ticker. */
  async releaseDueHolds(): Promise<number> {
    const now = this.opts.now();
    let n = 0;
    for (const row of this.store.effectsByStatus("held")) {
      if (!row.holdUntil || row.holdUntil > now) continue;
      n++;
      if (row.result?.outcome === "held") {
        const c = this.connectorFor(row.operation);
        try {
          const res = c.release ? await c.release(row, this.ctx()) : null;
          this.store.updateEffect(row.id, { status: "executed", holdUntil: null, result: { ...row.result, ...(res ?? {}), outcome: "executed" } });
          this.store.audit({ kind: "hold", actor: "agamemnon", effectId: row.id, taskId: row.taskId, detail: `hold window elapsed — ${row.operation} released${res?.detail ? `: ${res.detail}` : ""}` });
          this.issueReceipt(row.id, "executed");
        } catch (e: any) {
          this.store.updateEffect(row.id, { status: "failed", result: { error: e?.message ?? String(e) } });
          this.store.audit({ kind: "hold", actor: "agamemnon", effectId: row.id, taskId: row.taskId, detail: `release FAILED — ${e?.message ?? e}` });
        }
      } else {
        this.store.audit({ kind: "hold", actor: "agamemnon", effectId: row.id, taskId: row.taskId, detail: "hold window elapsed — executing (re-measured and binding checked)" });
        await this.executeRow(row.id, { reprepare: true });
      }
    }
    return n;
  }

  // ── claims ─────────────────────────────────────────────────────────────────
  async claim(agent: PrincipalRow, taskId: string, claims: Claim[], text?: string) {
    const all = [...claims.map((c) => ({ ...c, source: c.source ?? ("declared" as const) })), ...(text ? extractClaims(text) : [])];
    return this.reconcile(agent.name, taskId, all, null);
  }

  /** Facts about a task lineage, gathered from what Agamemnon itself executed and from systems of record. */
  async taskFacts(taskId: string): Promise<ObservedFacts> {
    const ids = this.store.lineage(taskId);
    const effects = ids.flatMap((t) => this.store.effectsByTask(t));
    const executed = effects.filter((e) => ["executed", "held"].includes(e.status));
    const facts: ObservedFacts = {
      envsTouched: [...new Set(executed.map((e) => e.effect?.request?.target?.env).filter(Boolean))],
      rows: {},
      created: executed.flatMap((e) => (e.result?.artifacts ?? []).map((a: any) => a.id)),
      deleted: [],
      touched: [...new Set(executed.map((e) => e.resource))],
      reversible: executed.length ? executed.every((e) => ["undo", "compensate", "hold"].includes(e.reversibility ?? "")) : undefined,
    };
    for (const e of executed) {
      const table = String(e.resource).split("/").pop()!;
      const n = e.result?.observedCounts?.rows;
      if (typeof n === "number" && e.effect?.writes?.length) {
        facts.rows![table] = (facts.rows![table] ?? 0) + n;
        facts.rows!["*"] = (facts.rows!["*"] ?? 0) + n;
      }
    }
    const oversight = effects.flatMap((e) => e.effect?.oversight ?? []);
    const deletedTests = oversight.filter((o: any) => o.rule === "test-deleted" || o.rule === "tests-removed").length;
    const skipMarkersAdded = oversight.filter((o: any) => o.rule === "test-skipped").length;
    for (const c of this.connectors.values()) {
      if (!c.facts) continue;
      try {
        const f = await c.facts(taskId, this.ctx());
        if (f.tests) facts.tests = { ...f.tests, deletedTests: (f.tests.deletedTests ?? 0) + deletedTests, skipMarkersAdded: (f.tests.skipMarkersAdded ?? 0) + skipMarkersAdded };
        if (f.backup) facts.backup = f.backup;
        if (f.refundsMinor !== undefined) facts.refundsMinor = (facts.refundsMinor ?? 0) + f.refundsMinor;
        if (f.sent !== undefined) facts.sent = (facts.sent ?? 0) + f.sent;
        if (f.deleted) facts.deleted = [...(facts.deleted ?? []), ...f.deleted];
      } catch {
        /* a system of record being unreachable makes claims unverifiable, not verified */
      }
    }
    if (!facts.tests && (deletedTests || skipMarkersAdded)) facts.tests = { conclusion: "success", deletedTests, skipMarkersAdded };
    return facts;
  }

  private reconcileQueue: Promise<unknown> = Promise.resolve();
  private reconcile(agent: string, taskId: string, claims: Claim[], effectId: string | null) {
    const run = async () => {
      const facts = await this.taskFacts(taskId);
      const rec = reconcileAll(claims, facts);
      for (const v of rec.verdicts) {
        this.store.addClaim({ taskId, effectId, agent, claim: v.claim, status: v.status, evidence: v.evidence });
        this.store.audit({ kind: v.status === "contradicted" ? "claim-contradicted" : "claim", actor: agent, effectId: effectId ?? undefined, taskId, detail: `${agent} claimed ${v.claim.type}=${JSON.stringify(v.claim.value)} → ${v.status.toUpperCase()}: ${v.evidence}` });
      }
      if (rec.contradicted.length) {
        let n = 0;
        for (let i = 0; i < rec.contradicted.length; i++) n = this.store.addContradiction(agent);
        const level = trustLevel(n);
        if (level === "suspended") this.store.setPrincipalStatus(agent, "suspended");
        this.store.audit({ kind: "trust", actor: "agamemnon", taskId, detail: `${agent} trust is now ${level.toUpperCase()} (${n} contradiction${n === 1 ? "" : "s"})` });
      }
      return rec;
    };
    const p = this.reconcileQueue.then(run, run);
    this.reconcileQueue = p.catch(() => undefined);
    return p;
  }

  // ── task end, artifacts, revert ────────────────────────────────────────────
  async endTask(by: PrincipalRow, taskId: string) {
    const task = this.store.task(taskId);
    if (!task) throw new ConnectorError("unknown-task", "task not found");
    const revoked = await this.revokeArtifacts(artifactsToRevoke(this.store.artifacts(), taskId), `task ${taskId} ended`);
    this.store.releaseLeases(taskId);
    this.store.endTask(taskId);
    this.store.audit({ kind: "task-end", actor: by.name, taskId, detail: `task ended; ${revoked} agent-created durable artifact(s) revoked` });
    return { revoked };
  }

  async revokeArtifacts(list: Array<{ id: string; kind: string; system: string }>, reason: string): Promise<number> {
    let n = 0;
    for (const a of list) {
      const full = this.store.artifacts().find((x) => x.id === a.id);
      const c = this.connectors.get(a.system);
      try {
        if (c?.revokeArtifact && full) await c.revokeArtifact({ id: a.id, kind: a.kind, revoke: full.revoke }, this.ctx());
        this.store.markArtifact(a.id, { revokedAt: this.opts.now() });
        this.store.audit({ kind: "artifact", actor: "agamemnon", detail: `revoked ${a.kind} ${a.id} (${a.system}) — ${reason}` });
        n++;
      } catch (e: any) {
        this.store.audit({ kind: "artifact", actor: "agamemnon", detail: `FAILED to revoke ${a.kind} ${a.id}: ${e?.message ?? e}` });
      }
    }
    return n;
  }

  async sweepStaleArtifacts() {
    return this.revokeArtifacts(staleArtifacts(this.store.artifacts(), this.opts.now()), "older than 24h without promotion");
  }

  promoteArtifact(operator: PrincipalRow, artifactId: string) {
    if (operator.kind !== "human" || operator.role === "auditor") throw new ConnectorError("forbidden", "only approvers may promote artifacts");
    this.store.markArtifact(artifactId, { promotedBy: operator.name });
    this.store.audit({ kind: "artifact", actor: operator.name, detail: `${operator.name} promoted artifact ${artifactId} — it will outlive its task` });
  }

  async undoEffect(operator: PrincipalRow, effectId: string) {
    if (operator.kind !== "human" || operator.role === "auditor") throw new ConnectorError("forbidden", "only approvers may undo");
    const row = this.store.effect(effectId);
    if (!row || row.status !== "executed") throw new ConnectorError("not-executed", "only executed effects can be undone");
    const c = this.connectorFor(row.operation);
    if (!c.compensate) throw new ConnectorError("irreversible", `${row.operation} has no automatic reversal`);
    const r = await c.compensate(row, this.ctx());
    this.store.updateEffect(effectId, { status: "reverted" });
    // An undo is itself an audited, attributed action.
    this.store.audit({ kind: "undo", actor: operator.name, effectId, taskId: row.taskId, detail: `${operator.name} reversed ${row.operation}: ${r.detail}`, data: { skipped: r.skipped ?? [] } });
    if (row.fingerprint) this.store.revokeRule(row.fingerprint); // a reverted shape can no longer be auto-allowed
    this.issueReceipt(effectId, "reverted");
    return r;
  }

  /** Revert everything a task lineage did, newest first, preserving later human edits. */
  async revertTask(operator: PrincipalRow, taskId: string) {
    if (operator.kind !== "human" || operator.role === "auditor") throw new ConnectorError("forbidden", "only approvers may revert");
    const ids = this.store.lineage(taskId);
    const effects = ids.flatMap((t) => this.store.effectsByTask(t)).sort((a, b) => b.createdAt - a.createdAt);
    const summary: Array<{ system: string; detail: string; restored?: number; skipped?: number }> = [];
    for (const e of effects.filter((x) => x.status === "held")) {
      await this.cancelHold(operator, e.id);
      summary.push({ system: e.system, detail: `cancelled held ${e.operation}` });
    }
    const writes = this.store.writes(ids);
    const bySystem = new Map<string, typeof writes>();
    for (const w of writes) {
      const sys = this.store.effect(w.effectId)?.system ?? "unknown";
      bySystem.set(sys, [...(bySystem.get(sys) ?? []), w]);
    }
    for (const [sys, ws] of bySystem) {
      const c = this.connectors.get(sys);
      if (!c?.revertWrites) continue;
      const r = await c.revertWrites(ws, ids, this.ctx());
      summary.push({ system: sys, detail: r.detail, restored: r.restored, skipped: r.skipped?.length ?? 0 });
    }
    const withWrites = new Set(writes.map((w) => w.effectId));
    for (const e of effects.filter((x) => x.status === "executed" && !withWrites.has(x.id))) {
      const c = this.connectors.get(e.system);
      if (!c?.compensate) {
        summary.push({ system: e.system, detail: `${e.operation} (${e.id}) cannot be reversed automatically` });
        continue;
      }
      try {
        const r = await c.compensate(e, this.ctx());
        summary.push({ system: e.system, detail: r.detail, restored: r.restored });
      } catch (err: any) {
        summary.push({ system: e.system, detail: `FAILED to reverse ${e.operation}: ${err?.message ?? err}` });
        continue;
      }
    }
    for (const e of effects.filter((x) => x.status === "executed")) this.store.updateEffect(e.id, { status: "reverted" });
    await this.revokeArtifacts(this.store.artifacts().filter((a) => ids.includes(a.taskId) && !a.revokedAt && a.durableAccess), `task ${taskId} reverted`);
    this.store.audit({ kind: "revert", actor: operator.name, taskId, detail: `${operator.name} reverted task ${taskId}: ${summary.map((s) => `${s.system}: ${s.detail}`).join("; ") || "nothing to revert"}`, data: summary });
    return { summary };
  }

  // ── reviewer canaries, suggestions ─────────────────────────────────────────
  injectCanary(task: TaskRow | null, why: string): string {
    const effectId = id("eff");
    const t = task ?? this.store.listTasks(1)[0];
    if (!t) throw new ConnectorError("no-task", "no task to attach a canary to");
    const effect: Effect & { canary: true } = {
      canary: true,
      request: {
        id: effectId, taskId: t.id, operation: "postgres.sql", target: { system: "postgres", resource: "default/customers", env: "prod" },
        params: { sql: "DELETE FROM customers WHERE created_at < now()" }, requester: { kind: "agent", id: t.agent },
        delegation: this.delegation(t), createdAt: this.opts.now(),
      },
      reversibility: "undo",
      preview: { summary: "delete 184,220 of 184,311 rows in customers", counts: { rows: 184220, total: 184311 }, fidelity: "exact" },
      precondition: "canary", oversight: [], creates: [], egress: false, reads: [], writes: ["postgres:default/customers"],
    };
    this.store.insertEffect({
      id: effectId, taskId: t.id, agent: t.agent, operation: "postgres.sql", system: "postgres", resource: "default/customers",
      status: "awaiting_approval", decision: "approval", wouldDecision: "approval", requiredApprovals: 1, reversibility: "undo",
      fingerprint: null, effect, admission: { firedRules: [{ name: "destructive-over-100", severity: "approval", detail: "184,220 destructive rows (>100) requires approval by default" }] },
      binding: null, result: null, verification: null, holdUntil: null,
    });
    this.store.audit({ kind: "canary", actor: "agamemnon", effectId, detail: `reviewer canary planted (${why}) — disclosed in policy, never executable` });
    return effectId;
  }

  /** Request shapes humans approved ≥3 times with zero reversals — candidates for an allow rule. */
  suggestions() {
    const rows = this.store.recentEffects(2000).filter((e) => e.fingerprint && !e.effect?.canary);
    const by = new Map<string, EffectRow[]>();
    for (const r of rows) by.set(r.fingerprint!, [...(by.get(r.fingerprint!) ?? []), r]);
    const out: Array<{ fingerprint: string; operation: string; approvals: number; example: string; accepted: boolean }> = [];
    for (const [fp, rs] of by) {
      if (rs.some((r) => r.status === "reverted" || (r.effect?.oversight ?? []).length || r.reversibility === "irreversible")) continue;
      const approved = rs.filter((r) => r.status === "executed" && r.decision === "approval").length;
      if (approved >= 3) out.push({ fingerprint: fp, operation: rs[0].operation, approvals: approved, example: rs[0].effect?.preview?.summary ?? "", accepted: this.store.learnedRule(fp) });
    }
    return out;
  }

  acceptSuggestion(operator: PrincipalRow, fingerprint: string) {
    if (operator.role !== "admin" && operator.role !== "approver") throw new ConnectorError("forbidden", "only approvers may accept rules");
    const s = this.suggestions().find((x) => x.fingerprint === fingerprint);
    if (!s) throw new ConnectorError("not-eligible", "that shape is not an eligible suggestion");
    this.store.acceptRule(fingerprint, s.example, operator.name);
    this.store.audit({ kind: "policy-change", actor: operator.name, detail: `${operator.name} accepted an allow rule for ${s.operation} shape ${fingerprint.slice(0, 24)}… (expires in 30 days; revoked automatically on any reversal)` });
  }

  // ── hooks (intent capture from coding agents) ──────────────────────────────
  hookIntent(agent: PrincipalRow, input: { tool: string; command?: string; path?: string; diff?: string; before?: string; after?: string; operation?: string; expansions?: Record<string, string> }) {
    const findings: Array<{ rule: string; verdict: "allow" | "ask" | "deny"; detail: string; reroute?: string }> = [];
    if (input.command) {
      const a = analyseShell(input.command, input.expansions ?? {});
      findings.push(...a.findings);
      if (a.bypassCredential) this.store.addCoverage(agent.name, "bypass-credential", input.command.slice(0, 200));
      for (const word of input.command.split(/\s+/)) {
        const name = this.vault.isPlaceholder(word.replace(/^['"]|['"]$/g, "").split(/[=@:/]/).find((p) => p.startsWith("agm_ph_")) ?? "");
        if (name) this.store.addCoverage(agent.name, "placeholder-used-directly", `placeholder for ${name} used outside the broker`);
      }
    }
    if (input.path) {
      for (const f of classifyOversight({ system: "fs", operation: input.operation ?? "write", resource: input.path, diff: input.diff, before: input.before, after: input.after })) {
        findings.push({ rule: `oversight:${f.rule}`, verdict: "ask", detail: f.detail, reroute: "this change reduces oversight; it needs two human approvals in the Agamemnon console" });
      }
    }
    const rank = { allow: 0, ask: 1, deny: 2 } as const;
    const verdict = findings.reduce<"allow" | "ask" | "deny">((acc, f) => (rank[f.verdict] > rank[acc] ? f.verdict : acc), "allow");
    this.store.audit({ kind: "hook", actor: agent.name, detail: `${input.tool}: ${verdict.toUpperCase()}${findings.length ? ` — ${findings.map((f) => f.rule).join(", ")}` : ""}`, data: { command: input.command?.slice(0, 300) ?? null, path: input.path ?? null } });
    if (verdict !== "allow") this.store.addCoverage(agent.name, `hook-${verdict}`, findings.map((f) => f.rule).join(","));
    return { verdict, findings };
  }

  // ── receipts ───────────────────────────────────────────────────────────────
  issueReceipt(effectId: string, outcome: "executed" | "blocked" | "denied" | "failed" | "held" | "cancelled" | "reverted") {
    const row = this.store.effect(effectId);
    if (!row) return;
    const head = this.store.receiptHead();
    const approvals = this.store.approvals(effectId).filter((a) => a.decision === "approve" && !a.canary);
    const claims = this.store.claims(row.taskId).filter((c) => c.effectId === effectId).map((c) => ({ type: String((c.claim as any)?.type ?? "unknown"), status: c.status }));
    const receipt = buildReceipt(
      {
        receiptId: id("rcpt"),
        effectId,
        taskId: row.taskId,
        operation: row.operation,
        target: row.effect.request.target,
        delegation: row.effect.request.delegation,
        decision: (row.decision ?? "block") as any,
        firedRules: (row.admission?.firedRules ?? []).map((r: FiredRule) => r.name),
        approvedEffectHash: row.binding?.effectHash ?? null,
        bindingHash: row.binding?.bindingHash ?? null,
        approvers: approvals.map((a) => ({ id: a.approver, at: a.at })),
        reversibility: row.reversibility ?? "unknown",
        observed: { counts: row.result?.observedCounts ?? {}, outcome },
        verification: { fidelity: row.verification?.fidelity ?? null, claims },
        issuedAt: this.opts.now(),
      },
      head?.hash,
    );
    const signed = signReceipt(receipt, this.vault.signer());
    this.store.addReceipt(effectId, receiptHash(receipt), signed);
  }

  verifyReceipts() {
    const signer = this.vault.signer();
    return verifyReceipts(this.store.receipts(), signer.verify);
  }

  // ── webhook approval channel ───────────────────────────────────────────────
  private async notifyApproval(effectId: string) {
    const hook = this.opts.webhook ?? this.store.getSetting<{ url: string; secret: string } | null>("webhook", null);
    if (!hook?.url) return;
    const v = this.view(effectId);
    const body = JSON.stringify({
      type: "agamemnon.approval_needed",
      effect: { id: v.id, summary: v.summary, counts: v.counts, reversibility: v.reversibility, fidelity: v.fidelity, requiredApprovals: v.requiredApprovals, rules: v.firedRules.map((r) => ({ name: r.name, severity: r.severity, detail: r.detail })) },
      approvalUrl: v.approvalUrl,
      note: "Approve in the Agamemnon console (sign-in required). This message carries no approval capability.",
      at: new Date().toISOString(),
    });
    const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
    try {
      await fetch(hook.url, { method: "POST", headers: { "content-type": "application/json", "x-agamemnon-signature": `sha256=${sig}` }, body, signal: AbortSignal.timeout(3000) });
      this.store.audit({ kind: "notify", actor: "agamemnon", effectId, detail: `approval request sent to webhook (signed)` });
    } catch (e: any) {
      this.store.audit({ kind: "notify", actor: "agamemnon", effectId, detail: `webhook delivery failed: ${e?.message ?? e}` });
    }
  }

  // ── views ──────────────────────────────────────────────────────────────────
  view(effectId: string): EffectView {
    const r = this.store.effect(effectId)!;
    return {
      id: r.id,
      taskId: r.taskId,
      status: r.status,
      decision: r.decision,
      wouldDecision: r.wouldDecision,
      requiredApprovals: r.requiredApprovals,
      reversibility: r.reversibility,
      summary: r.effect?.preview?.summary ?? "",
      counts: r.effect?.preview?.counts ?? {},
      fidelity: r.effect?.preview?.fidelity ?? null,
      firedRules: r.admission?.firedRules ?? [],
      approvalUrl: r.status === "awaiting_approval" && this.opts.publicUrl ? `${this.opts.publicUrl}/approve/${r.id}` : undefined,
      holdUntil: r.holdUntil,
      result: r.result?.result,
      error: r.result?.error,
    };
  }

  reviewerStats() {
    return reviewerStats(this.store.allApprovals());
  }
}

function stripInternal(e: any): Effect {
  const { internal: _i, readLabels: _r, canary: _c, ...rest } = e ?? {};
  return rest as Effect;
}
