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

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@agamemnon/kernel";
import { ConnectorError } from "./connectors/types.ts";
import type { Engine } from "./engine.ts";
import type { PrincipalRow } from "./store.ts";
import { consolePage, approvePage } from "./pages.ts";

/**
 * The broker's HTTP surface.
 *
 *   Agents   (Authorization: Bearer <agent token>)  → tasks, effects, claims, hooks
 *   Operators(Authorization: Bearer <operator token>)→ approve/deny, undo, revert,
 *                                                     holds, artifacts, audit, receipts
 *   Admin                                            → principals, targets, secrets, mode
 *
 * Approvals NEVER happen in an agent's own client: the MCP server and the
 * webhook only carry a link to /approve/:id, which requires operator sign-in.
 */

export function hashToken(token: string): string {
  return sha256Hex(`agamemnon-token:${token}`);
}

export function newToken(kind: "agent" | "op"): string {
  return `agm_${kind}_${randomBytes(24).toString("hex")}`;
}

const TERMINAL = new Set(["blocked", "denied", "executed", "failed", "held", "cancelled", "reverted", "drifted", "shadowed", "canary-caught", "canary-missed"]);

function allowedOrigin(origin: string | undefined, publicUrl?: string): boolean {
  if (!origin) return true;
  if (publicUrl && origin === new URL(publicUrl).origin) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

export interface ServerOptions {
  host?: string;
  port?: number;
  publicUrl?: string;
}

export function createServer(engine: Engine, opts: ServerOptions = {}) {
  const store = engine.store;

  const auth = (req: http.IncomingMessage): PrincipalRow | null => {
    const h = req.headers.authorization ?? "";
    const tok = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!tok) return null;
    const p = store.principalByTokenHash(hashToken(tok));
    if (!p) return null;
    if (p.status === "revoked") return null;
    return p;
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const send = (code: number, body: unknown, type = "application/json") => {
      const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" };
      if (origin && allowedOrigin(origin, opts.publicUrl)) {
        headers["access-control-allow-origin"] = origin;
        headers["access-control-allow-headers"] = "authorization, content-type";
        headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
        headers.vary = "Origin";
      }
      res.writeHead(code, headers);
      res.end(type === "application/json" ? JSON.stringify(body) : String(body));
    };
    if (!allowedOrigin(origin, opts.publicUrl)) return send(403, { error: "origin not allowed" });
    if (req.method === "OPTIONS") return send(204, {});

    const url = new URL(req.url ?? "/", "http://broker");
    const path = url.pathname;
    let body: any = {};
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 2_000_000) return send(413, { error: "body too large" });
        chunks.push(c as Buffer);
      }
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        return send(400, { error: "invalid JSON" });
      }
    }

    try {
      // ── public ────────────────────────────────────────────────────────────
      if (path === "/health") {
        const v = store.verifyAudit();
        return send(200, { ok: true, service: "agamemnon-broker", mode: engine.mode, connectors: [...engine.connectors.keys()], vaultKeySource: engine.vault.source, auditChain: v.ok ? `verified (${v.checked})` : `BROKEN at ${v.brokenAt?.seq}` });
      }
      if (path === "/" || path === "/console") return send(200, consolePage(), "text/html; charset=utf-8");
      if (path.startsWith("/approve/")) return send(200, approvePage(path.slice("/approve/".length)), "text/html; charset=utf-8");

      const me = auth(req);
      if (!me) return send(401, { error: "missing or unknown token (Authorization: Bearer …)" });
      const isOperator = me.kind === "human" && !!me.role;
      const isAdmin = isOperator && me.role === "admin";
      const isAgent = !isOperator;
      const m = (re: RegExp) => re.exec(path);
      let mm: RegExpExecArray | null;

      if (path === "/v1/whoami") return send(200, { name: me.name, kind: me.kind, role: me.role, owner: me.owner, status: me.status });

      // ── agent endpoints ───────────────────────────────────────────────────
      if (req.method === "POST" && path === "/v1/tasks") {
        if (!isAgent) return send(403, { error: "tasks are started by agents" });
        if (me.status === "suspended") return send(403, { error: `${me.name} is suspended after repeated claim contradictions; its owner must reinstate it` });
        const t = engine.startTask(me, { goal: body.goal, parentTaskId: body.parentTaskId, tenant: body.tenant });
        return send(200, { taskId: t.id, rootOwner: t.rootOwner });
      }
      if (req.method === "POST" && (mm = m(/^\/v1\/tasks\/([\w-]+)\/end$/))) {
        const t = store.task(mm[1]);
        if (!t) return send(404, { error: "task not found" });
        if (isAgent && t.agent !== me.name) return send(404, { error: "task not found" });
        return send(200, await engine.endTask(me, mm[1]));
      }
      if (req.method === "POST" && path === "/v1/effects") {
        if (!isAgent) return send(403, { error: "effects are proposed by agents (operators approve them)" });
        let v = await engine.propose(me, {
          taskId: String(body.taskId ?? ""),
          operation: String(body.operation ?? ""),
          target: body.target,
          params: body.params ?? {},
          declared: body.declared,
          provenance: body.provenance,
          claims: body.claims,
        });
        const waitMs = Math.min(Number(body.waitSeconds ?? 0), 120) * 1000;
        const until = Date.now() + waitMs;
        while (!TERMINAL.has(v.status) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 500));
          v = engine.view(v.id);
        }
        return send(200, v);
      }
      if (req.method === "GET" && (mm = m(/^\/v1\/effects\/([\w-]+)$/))) {
        const row = store.effect(mm[1]);
        if (!row || (isAgent && row.agent !== me.name)) return send(404, { error: "not found" });
        return send(200, isOperator ? { ...engine.view(mm[1]), detail: row, approvals: store.approvals(mm[1]) } : engine.view(mm[1]));
      }
      if (req.method === "POST" && (mm = m(/^\/v1\/effects\/([\w-]+)\/cancel$/))) {
        const row = store.effect(mm[1]);
        if (!row || (isAgent && row.agent !== me.name)) return send(404, { error: "not found" });
        return send(200, await engine.cancelHold(me, mm[1]));
      }
      if (req.method === "POST" && path === "/v1/claims") {
        if (!isAgent) return send(403, { error: "claims are made by agents" });
        const t = store.task(String(body.taskId ?? ""));
        if (!t || (t.agent !== me.name)) return send(404, { error: "task not found" });
        const rec = await engine.claim(me, t.id, Array.isArray(body.claims) ? body.claims : [], typeof body.text === "string" ? body.text : undefined);
        return send(200, { verdicts: rec.verdicts, contradicted: rec.contradicted.length, trust: store.principal(me.name)?.status });
      }
      if (req.method === "POST" && path === "/v1/taint") {
        const t = store.task(String(body.taskId ?? ""));
        if (!t || (isAgent && t.agent !== me.name)) return send(404, { error: "task not found" });
        const { absorbTaint } = await import("@agamemnon/kernel");
        store.setTaskTaint(t.id, absorbTaint(t.taint, { labels: body.labels ?? ["untrusted"], private: !!body.private, source: String(body.source ?? "reported") }));
        store.audit({ kind: "taint", actor: me.name, taskId: t.id, detail: `task read ${body.private ? "private" : ""}${body.private && (body.labels ?? []).includes("untrusted") ? " + " : ""}${(body.labels ?? ["untrusted"]).join(",")} data from ${body.source ?? "unspecified source"}` });
        return send(200, { taint: store.task(t.id)!.taint });
      }
      if (req.method === "POST" && path === "/v1/hooks/intent") {
        return send(200, engine.hookIntent(me, body));
      }

      // ── operator endpoints ────────────────────────────────────────────────
      if (!isOperator) return send(403, { error: "operator token required" });

      if (req.method === "GET" && path === "/v1/console/state") {
        const effects = store.recentEffects(Number(url.searchParams.get("limit") ?? 80)).map((e) => ({
          ...engine.view(e.id), agent: e.agent, operation: e.operation, system: e.system, resource: e.resource, createdAt: e.createdAt,
          env: e.effect?.request?.target?.env ?? null, oversight: e.effect?.oversight ?? [], sample: e.effect?.preview?.sample ?? null,
          approvals: store.approvals(e.id).map((a) => ({ approver: a.approver, decision: a.decision, at: a.at })),
          rootOwner: e.effect?.request?.delegation?.rootOwner ?? null, canary: !!e.effect?.canary,
        }));
        const fidelity = Object.fromEntries(Object.entries(store.fidelityBySystem()).map(([k, v]) => [k, { mean: v.reduce((a, b) => a + b, 0) / v.length, samples: v.length }]));
        return send(200, {
          me: { name: me.name, role: me.role },
          mode: engine.mode,
          effects,
          tasks: store.listTasks(30),
          claims: store.claims(),
          principals: store.listPrincipals(),
          artifacts: store.artifacts().slice(0, 50),
          leases: store.leases(),
          fidelity,
          reviewers: engine.reviewerStats(),
          suggestions: engine.suggestions(),
          coverage: store.coverage(50),
          audit: store.auditTail(80),
          chain: store.verifyAudit(),
          targets: store.listTargets().map((t: any) => ({ system: t.system, resource: t.resource, env: t.env })),
          policyChanges: store.policyChanges(),
        });
      }
      if (req.method === "POST" && (mm = m(/^\/v1\/effects\/([\w-]+)\/(approve|deny)$/))) {
        return send(200, await engine.decide(me, mm[1], mm[2] as "approve" | "deny", String(body.note ?? "")));
      }
      if (req.method === "POST" && (mm = m(/^\/v1\/effects\/([\w-]+)\/undo$/))) return send(200, await engine.undoEffect(me, mm[1], { force: body.force === true }));
      if (req.method === "POST" && (mm = m(/^\/v1\/tasks\/([\w-]+)\/revert$/))) return send(200, await engine.revertTask(me, mm[1], { force: body.force === true }));
      if (req.method === "GET" && path === "/v1/taint/dependents") return send(200, { source: url.searchParams.get("source"), tasks: engine.poisoned(String(url.searchParams.get("source") ?? "")) });
      if (req.method === "GET" && path === "/v1/evidence") return send(200, engine.evidence().join("\n") + "\n", "application/x-ndjson");
      if (req.method === "POST" && path === "/v1/policy/replay") return send(200, engine.replayPolicy(body, Number(body.limit ?? 500)));
      if (req.method === "POST" && (mm = m(/^\/v1\/policy-changes\/([\w-]+)\/(approve|reject)$/))) return send(200, engine.decidePolicyChange(me, mm[1], mm[2] === "approve"));
      if (req.method === "POST" && (mm = m(/^\/v1\/artifacts\/([\w.:-]+)\/promote$/))) {
        engine.promoteArtifact(me, mm[1]);
        return send(200, { ok: true });
      }
      if (req.method === "GET" && path === "/v1/suggestions") return send(200, engine.suggestions());
      if (req.method === "POST" && (mm = m(/^\/v1\/suggestions\/(.+)\/accept$/))) {
        engine.acceptSuggestion(me, decodeURIComponent(mm[1]));
        return send(200, { ok: true });
      }
      if (req.method === "GET" && path === "/v1/audit") {
        return send(200, { rows: store.auditRows(Number(url.searchParams.get("after") ?? -1), Math.min(Number(url.searchParams.get("limit") ?? 1000), 5000)) });
      }
      if (req.method === "GET" && path === "/v1/audit/verify") return send(200, store.verifyAudit());
      if (req.method === "GET" && path === "/v1/receipts") return send(200, { publicKey: engine.vault.signer().publicKey, receipts: store.receipts() });
      if (req.method === "GET" && path === "/v1/receipts/verify") return send(200, engine.verifyReceipts());
      if (req.method === "POST" && (mm = m(/^\/v1\/principals\/([\w.-]+)\/reinstate$/))) {
        const target = store.principal(mm[1]);
        if (!target) return send(404, { error: "unknown principal" });
        if (!isAdmin && target.owner !== me.name) return send(403, { error: "only the agent's owner or an admin may reinstate it" });
        store.resetContradictions(mm[1]);
        store.audit({ kind: "trust", actor: me.name, detail: `${me.name} reinstated ${mm[1]} (contradiction count reset)` });
        return send(200, { ok: true });
      }

      // ── admin ─────────────────────────────────────────────────────────────
      if (!isAdmin) return send(403, { error: "admin token required" });
      if (req.method === "POST" && path === "/v1/admin/principals") {
        const kind = body.kind ?? "agent";
        const name = String(body.name ?? "");
        if (!/^[\w.-]{1,64}$/.test(name)) return send(400, { error: "invalid name" });
        const token = newToken(kind === "human" ? "op" : "agent");
        store.upsertPrincipal({ name, kind, role: kind === "human" ? (body.role ?? "approver") : null, owner: body.owner ?? (kind === "human" ? null : me.name), tokenHash: hashToken(token) });
        store.audit({ kind: "provision", actor: me.name, detail: `${me.name} registered ${kind} ${name}${kind === "human" ? ` (${body.role ?? "approver"})` : ` owned by ${body.owner ?? me.name}`}` });
        return send(200, { name, token, note: "store this token now — the broker keeps only its hash" });
      }
      if (req.method === "POST" && path === "/v1/admin/targets") {
        store.upsertTarget({ system: body.system, resource: body.resource, env: body.env, tenant: body.tenant, fingerprint: body.fingerprint, config: body.config });
        store.audit({ kind: "provision", actor: me.name, detail: `target ${body.system}:${body.resource} registered as ${body.env ?? "(no env)"}` });
        return send(200, { ok: true });
      }
      if (req.method === "POST" && path === "/v1/admin/secrets") {
        const placeholder = engine.vault.put(String(body.name), String(body.value));
        store.audit({ kind: "provision", actor: me.name, detail: `secret ${body.name} stored in the vault (value never logged); placeholder issued` });
        return send(200, { name: body.name, placeholder });
      }
      // Policy is never changed by one person: these create a pending change a second operator must approve.
      if (req.method === "POST" && path === "/v1/admin/mode") {
        const changeId = engine.requestPolicyChange(me, { mode: body.mode === "shadow" ? "shadow" : "enforce" });
        return send(200, { changeId, status: "pending", note: "a second operator must approve: POST /v1/policy-changes/:id/approve" });
      }
      if (req.method === "POST" && path === "/v1/admin/settings") {
        const change: Record<string, unknown> = {};
        for (const k of ["canaryRate", "webhook", "budgets", "levels", "twoPersonRowThreshold"]) if (k in body) change[k] = body[k];
        const changeId = engine.requestPolicyChange(me, change);
        return send(200, { changeId, status: "pending" });
      }
      if (req.method === "POST" && path === "/v1/admin/canary") {
        const effectId = engine.injectCanary(body.taskId ? store.task(body.taskId) : null, `manual by ${me.name}`);
        return send(200, { effectId });
      }
      return send(404, { error: "not found" });
    } catch (e: any) {
      const code = e instanceof ConnectorError ? (e.rule === "not-found" || e.rule === "unknown-task" ? 404 : e.rule === "forbidden" || e.rule === "approver-refused" ? 403 : 409) : 500;
      return send(code, { error: e?.message ?? String(e), rule: e?.rule });
    }
  });

  return server;
}

/** Constant-time string compare (exported for tests / scripts). */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
