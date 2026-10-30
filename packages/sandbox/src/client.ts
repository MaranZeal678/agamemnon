// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import type { CapabilityFlag, RuntimeKind, SandboxExecutionResult } from "./types.ts";

/**
 * Client SDK for the sandbox REST server.
 *
 *   const client = new SandboxClient({ url: "http://127.0.0.1:7711", token: AGENT_TOKEN });
 *   const sbx = await client.create({ tenantId: "bloom-botanicals", runtime: "microvm-adapter",
 *                                     grants: ["READ_ONLY"], maxMemoryMb: 128, timeoutMs: 10_000 });
 *   const r = await sbx.run(`return db.select("orders", {"status": "refunded"})`);
 *   await sbx.destroy();
 *
 * The token is a broker agent token. The client never sees a credential, a
 * VM, or a socket — only the server's answers.
 */

export interface CreateOptions {
  tenantId: string;
  runtime?: RuntimeKind;
  grants?: CapabilityFlag[];
  allowedDomains?: string[];
  maxMemoryMb?: number;
  timeoutMs?: number;
  maxSyscalls?: number;
  id?: string;
  role?: string;
}

export interface SandboxInfo {
  id: string;
  status: "ready" | "running" | "terminated";
  tenantId: string;
  owner: string | null;
  runtime: RuntimeKind;
  grants: CapabilityFlag[];
  tainted: boolean;
  pendingMessages: number;
  terminatedReason: string | null;
}

export class SandboxApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class SandboxClient {
  readonly #url: string;
  readonly #token: string;

  constructor(opts: { url: string; token: string }) {
    this.#url = opts.url.replace(/\/+$/, "");
    this.#token = opts.token;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.#url + path, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new SandboxApiError(r.status, j.error ?? `HTTP ${r.status}`);
    return j as T;
  }

  async create(o: CreateOptions): Promise<Sandbox> {
    const info = await this.#call<SandboxInfo>("POST", "/v1/sandboxes", {
      id: o.id,
      tenantId: o.tenantId,
      runtime: o.runtime ?? "quickjs-wasm",
      role: o.role,
      capabilities: { grants: o.grants ?? [], allowedDomains: o.allowedDomains, maxMemoryMb: o.maxMemoryMb ?? 64, timeoutMs: o.timeoutMs ?? 5000, maxSyscalls: o.maxSyscalls },
    });
    return new Sandbox(this, info);
  }

  async list(): Promise<SandboxInfo[]> {
    return (await this.#call<{ sandboxes: SandboxInfo[] }>("GET", "/v1/sandboxes")).sandboxes;
  }

  get(id: string): Promise<SandboxInfo> {
    return this.#call("GET", `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  execute(id: string, code: string, context: Record<string, unknown> = {}): Promise<SandboxExecutionResult> {
    return this.#call("POST", `/v1/sandboxes/${encodeURIComponent(id)}/execute`, { code, context });
  }

  destroy(id: string): Promise<SandboxInfo> {
    return this.#call("DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  health(): Promise<{ ok: boolean; runtimes: Record<string, boolean> }> {
    return this.#call("GET", "/v1/health");
  }
}

export class Sandbox {
  readonly id: string;
  info: SandboxInfo;
  readonly #client: SandboxClient;

  constructor(client: SandboxClient, info: SandboxInfo) {
    this.#client = client;
    this.info = info;
    this.id = info.id;
  }

  run(code: string, context: Record<string, unknown> = {}) {
    return this.#client.execute(this.id, code, context);
  }

  async refresh() {
    this.info = await this.#client.get(this.id);
    return this.info;
  }

  async destroy() {
    this.info = await this.#client.destroy(this.id);
  }
}
