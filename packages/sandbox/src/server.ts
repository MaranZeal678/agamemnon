// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import http from "node:http";
import { randomBytes } from "node:crypto";
import { hashToken, type Broker } from "@agamemnon/broker";
import { RuntimeUnavailable } from "./runtimes/base.runtime.ts";
import type { SandboxSupervisor } from "./supervisor.ts";
import type { MiniSandboxConfig } from "./types.ts";

/**
 * The sandbox REST server — the control plane in front of the supervisor.
 *
 *   client / SDK ──REST + bearer token──▶ sandbox server ──▶ supervisor ──▶ runtime (QuickJS | microVM)
 *
 * Nobody reaches a sandbox except through here. Every request carries a
 * broker principal's token. Agents create sandboxes, which then act as that
 * agent (narrowed by capabilities) on a broker task scoped to the tenant; only
 * the owning agent may run code in its sandbox. Operators (approvers, admins)
 * may list, inspect and terminate any sandbox and read violations, but never
 * run code — that would let a human act as an agent.
 *
 *   POST   /v1/sandboxes               { tenantId, runtime, capabilities, id? }   agent
 *   GET    /v1/sandboxes                                                         owner | operator
 *   GET    /v1/sandboxes/:id                                                     owner | operator
 *   POST   /v1/sandboxes/:id/execute   { code, context? }                        owner
 *   DELETE /v1/sandboxes/:id                                                     owner | operator
 *   GET    /v1/violations                                                        operator
 *   GET    /v1/health                                                            anyone
 */

export interface Caller {
  name: string;
  kind: string;
  role?: string | null;
}

export interface SandboxServerOptions {
  supervisor: SandboxSupervisor;
  /** Resolve a bearer token to a principal, or null. */
  authenticate(token: string): Caller | null;
  /** May this agent create sandboxes for this tenant? Default: yes. */
  allowTenant?(caller: Caller, tenantId: string): boolean;
  /** Live sandboxes one agent may hold at once. Default 20. */
  maxPerOwner?: number;
}

const MAX_BODY = 1 << 20;
const isOperator = (c: Caller) => c.kind === "human" && (c.role === "approver" || c.role === "admin");
const isAgent = (c: Caller) => c.kind !== "human";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Authenticate against a broker's principals (same tokens as the broker API). */
export function brokerAuthenticator(broker: Pick<Broker, "store">) {
  return (token: string): Caller | null => {
    const p = broker.store.principalByTokenHash(hashToken(token));
    if (!p || p.status === "revoked") return null;
    return { name: p.name, kind: p.kind, role: p.role };
  };
}

export function createSandboxServer(opts: SandboxServerOptions): http.Server {
  const { supervisor } = opts;
  const maxPerOwner = opts.maxPerOwner ?? 20;

  const visible = (c: Caller, id: string) => {
    let st;
    try {
      st = supervisor.status(id);
    } catch {
      throw new HttpError(404, "no such sandbox");
    }
    // Someone else's sandbox is indistinguishable from none.
    if (!isOperator(c) && st.owner !== c.name) throw new HttpError(404, "no such sandbox");
    return st;
  };

  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://sandbox.local");
      const path = url.pathname;
      if (req.method === "GET" && path === "/v1/health") {
        let microvm = false;
        try {
          microvm = !!process.env.AGAMEMNON_VMHOST;
        } catch {}
        return send(200, { ok: true, runtimes: { "quickjs-wasm": true, "microvm-adapter": microvm, "worker-thread": false } });
      }

      const h = req.headers.authorization ?? "";
      const caller = h.startsWith("Bearer ") ? opts.authenticate(h.slice(7).trim()) : null;
      if (!caller) throw new HttpError(401, "missing or invalid bearer token");

      let body: any = {};
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) throw new HttpError(413, "request body too large");
          chunks.push(c as Buffer);
        }
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        } catch {
          throw new HttpError(400, "body must be JSON");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
      }

      if (path === "/v1/sandboxes" && req.method === "POST") {
        if (!isAgent(caller)) throw new HttpError(403, "only agents create sandboxes");
        const tenantId = String(body.tenantId ?? "");
        if (!tenantId) throw new HttpError(400, "tenantId is required");
        if (opts.allowTenant && !opts.allowTenant(caller, tenantId)) throw new HttpError(403, `${caller.name} may not act for tenant ${tenantId}`);
        const live = supervisor.list().filter((s) => s.owner === caller.name && s.status !== "terminated").length;
        if (live >= maxPerOwner) throw new HttpError(429, `${caller.name} already holds ${live} live sandboxes`);
        const config: MiniSandboxConfig = {
          id: typeof body.id === "string" ? body.id : `sbx_${randomBytes(6).toString("hex")}`,
          tenantId,
          runtime: body.runtime ?? "quickjs-wasm",
          capabilities: body.capabilities ?? { grants: [], maxMemoryMb: 64, timeoutMs: 5000 },
          role: typeof body.role === "string" ? body.role : undefined,
          owner: caller.name, // never taken from the body
        };
        try {
          const id = await supervisor.spawnSandbox(config);
          return send(201, supervisor.status(id));
        } catch (e: any) {
          throw new HttpError(e instanceof RuntimeUnavailable ? 422 : 400, e?.message ?? String(e));
        }
      }

      if (path === "/v1/sandboxes" && req.method === "GET") {
        return send(200, { sandboxes: supervisor.list().filter((s) => isOperator(caller) || s.owner === caller.name) });
      }

      if (path === "/v1/violations" && req.method === "GET") {
        if (!isOperator(caller)) throw new HttpError(403, "operators only");
        return send(200, { violations: supervisor.violations() });
      }

      const m = /^\/v1\/sandboxes\/([A-Za-z0-9._-]{1,64})(\/execute)?$/.exec(path);
      if (m) {
        const st = visible(caller, m[1]);
        if (m[2] && req.method === "POST") {
          if (st.owner !== caller.name) throw new HttpError(403, "only the owning agent runs code in a sandbox");
          if (typeof body.code !== "string") throw new HttpError(400, "code must be a string");
          const context = body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context : {};
          try {
            return send(200, await supervisor.executeInSandbox(st.id, body.code, context));
          } catch (e: any) {
            throw new HttpError(409, e?.message ?? String(e));
          }
        }
        if (!m[2] && req.method === "GET") return send(200, st);
        if (!m[2] && req.method === "DELETE") {
          await supervisor.terminateSandbox(st.id);
          return send(200, supervisor.status(st.id));
        }
      }
      throw new HttpError(404, "not found");
    } catch (e: any) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      return send(500, { error: "internal error" });
    }
  });
}
