// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { SandboxKill } from "./runtimes/base.runtime.ts";
import { checkSyscall } from "./capabilities.ts";
import type { AgamemnonProposalBridge, AgentMessage, MiniSandboxConfig, ProposalOutcome, Scalar, SandboxMutation, Syscall } from "./types.ts";

/**
 * The IPC broker — every syscall an enclave makes lands here.
 *
 *   parse    untrusted JSON → a typed Syscall, or a violation
 *   check    capabilities (capabilities.ts) — a refusal is a violation
 *   route    db.*   → the Agamemnon bridge (writes become effect proposals)
 *            http.* → HTTPS GET only, no redirects, size/time capped
 *            ipc.*  → per-sandbox mailboxes, same tenant only, labelled untrusted
 *
 * A violation reports to the supervisor and then throws SandboxKill, which the
 * runtime turns into an immediate kill. An ordinary failure (no such agent,
 * inbox full, broker refused) is an Error the guest can catch.
 */

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_INBOX = 100;
export const MAX_FETCH_BYTES = 256 * 1024;
export const FETCH_TIMEOUT_MS = 5000;

/** The supervisor's view of one sandbox, as the broker needs it. */
export interface SandboxRecord {
  config: MiniSandboxConfig;
  status: "ready" | "running" | "terminated";
  inbox: AgentMessage[];
  /** Has this sandbox consumed another agent's output? Then its proposals are untrusted. */
  tainted: boolean;
}

export interface IpcBrokerOptions {
  bridge: AgamemnonProposalBridge;
  /** Look up another sandbox (for ipc.send). */
  lookup: (sandboxId: string) => SandboxRecord | undefined;
  /** Called before the kill, with whatever could be read of the request. */
  onViolation: (sb: SandboxRecord, syscall: unknown, reason: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A request that is not a well-formed syscall. The prelude never sends one, so it means tampering. */
export class MalformedSyscall extends Error {}

export class IpcBroker {
  readonly #o: Required<IpcBrokerOptions>;

  constructor(opts: IpcBrokerOptions) {
    this.#o = { fetch: globalThis.fetch, now: Date.now, ...opts };
  }

  /** The SyscallHandler body for one sandbox. Mutation outcomes are appended to `proposals`. */
  async handle(sb: SandboxRecord, raw: unknown, proposals: ProposalOutcome[]): Promise<unknown> {
    let call: Syscall;
    try {
      call = parseSyscall(raw);
    } catch (e: any) {
      return this.#violate(sb, raw, `malformed syscall: ${e?.message ?? e}`);
    }
    const decision = checkSyscall(sb.config.capabilities, call);
    if (!decision.allowed) return this.#violate(sb, call, decision.reason);

    const { bridge } = this.#o;
    switch (call.op) {
      case "db.select": {
        const r = await bridge.handleSandboxRead(sb.config.id, { table: call.table, where: call.where });
        if (r.outcome.status !== "executed") throw new Error(`read ${r.outcome.status}: ${r.outcome.summary}`);
        return r.rows;
      }
      case "db.mutate": {
        const outcome = await bridge.handleSandboxWriteProposal(sb.config.id, call.mutation, sb.tainted ? { provenance: ["untrusted"] } : undefined);
        proposals.push(outcome);
        return outcome;
      }
      case "http.fetch":
        return httpGet(this.#o.fetch, call.url);
      case "ipc.send":
        return this.#send(sb, call.to, call.message);
      case "ipc.recv": {
        const messages = sb.inbox.splice(0);
        if (messages.length) sb.tainted = true;
        return messages;
      }
    }
  }

  #violate(sb: SandboxRecord, syscall: unknown, reason: string): never {
    this.#o.onViolation(sb, syscall, reason);
    throw new SandboxKill(`policy violation: ${reason}`);
  }

  #send(from: SandboxRecord, to: string, message: unknown) {
    const target = this.#o.lookup(to);
    // A sandbox in another tenant is indistinguishable from one that does not exist.
    const reachable =
      target && target.status !== "terminated" && target.config.tenantId === from.config.tenantId && target.config.capabilities.grants.includes("AGENT_IPC");
    if (!reachable) throw new Error(`no such agent: ${to}`);
    const json = JSON.stringify(message ?? null);
    if (json.length > MAX_MESSAGE_BYTES) throw new Error(`message larger than ${MAX_MESSAGE_BYTES} bytes`);
    if (target.inbox.length >= MAX_INBOX) throw new Error(`inbox of ${to} is full`);
    // A fresh copy: sender and recipient never share a reference.
    target.inbox.push({ from: from.config.id, message: JSON.parse(json), labels: ["untrusted"], at: this.#o.now() });
    return { delivered: true };
  }
}

// --- parsing -----------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown): v is Scalar => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

function str(v: unknown, field: string, max = 2048): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new MalformedSyscall(`${field} must be a non-empty string of at most ${max} characters`);
  return v;
}

function where(v: unknown): Record<string, Scalar> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isPlainObject(v)) throw new MalformedSyscall("where must be an object");
  for (const [k, x] of Object.entries(v)) if (!isScalar(x)) throw new MalformedSyscall(`where.${k} must be a string, finite number, boolean or null`);
  return v as Record<string, Scalar>;
}

/**
 * Turn whatever an enclave sent into a typed Syscall, or throw. Field SHAPES
 * only — whether the sandbox may make the call is capabilities.ts's job, and
 * whether an identifier is safe SQL is the bridge's.
 */
export function parseSyscall(raw: unknown): Syscall {
  if (!isPlainObject(raw)) throw new MalformedSyscall("request must be an object");
  switch (raw.op) {
    case "db.select":
      return { op: "db.select", table: str(raw.table, "table", 63), where: where(raw.where) };
    case "db.mutate": {
      const m = raw.mutation;
      if (!isPlainObject(m)) throw new MalformedSyscall("mutation must be an object");
      if (m.operation !== "insert" && m.operation !== "update" && m.operation !== "delete") throw new MalformedSyscall("mutation.operation must be insert, update or delete");
      const data = m.data === undefined ? {} : m.data;
      if (!isPlainObject(data)) throw new MalformedSyscall("mutation.data must be an object");
      const mutation: SandboxMutation = { table: str(m.table, "mutation.table", 63), operation: m.operation, data, where: where(m.where) };
      return { op: "db.mutate", mutation };
    }
    case "http.fetch":
      return { op: "http.fetch", url: str(raw.url, "url") };
    case "ipc.send":
      return { op: "ipc.send", to: str(raw.to, "to", 64), message: raw.message ?? null };
    case "ipc.recv":
      return { op: "ipc.recv" };
    default:
      throw new MalformedSyscall(`unknown op ${JSON.stringify(raw.op)}`);
  }
}

// --- egress --------------------------------------------------------------------

/**
 * The only network path out of a sandbox. Mechanism, not policy: WHICH hosts
 * are allowed is decided by checkSyscall before this runs. This refuses
 * anything that could leave that decision behind — non-https, embedded
 * credentials, redirects — and caps time and size.
 *
 * Not handled here: an allowed name that RESOLVES to a private address (DNS
 * rebinding / SSRF). Allowlist only names you control or trust.
 */
export async function httpGet(fetchImpl: typeof fetch, url: string): Promise<{ status: number; contentType: string | null; body: string; truncated: boolean }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "https:") throw new Error("only https:// is allowed");
  if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
  const res = await fetchImpl(u, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "agamemnon-sandbox/0.1" } });
  if (res.status >= 300 && res.status < 400) throw new Error(`redirect (${res.status}) not followed — it could leave the allowlist`);
  let body = "";
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FETCH_BYTES) {
        truncated = true;
        await reader.cancel();
        break;
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  }
  return { status: res.status, contentType: res.headers.get("content-type"), body, truncated };
}
