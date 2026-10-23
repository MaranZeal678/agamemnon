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

import { IpcBroker, type SandboxRecord } from "./ipc-broker.ts";
import { QuickJSRuntime } from "./runtimes/quickjs.runtime.ts";
import { WorkerThreadRuntime } from "./runtimes/worker.runtime.ts";
import { MicroVmRuntime, microVmFromEnv } from "./runtimes/microvm.runtime.ts";
import { RuntimeUnavailable, type ISandboxRuntime, type RunLimits } from "./runtimes/base.runtime.ts";
import { CapabilityFlags, DEFAULT_LIMITS, type AgamemnonProposalBridge, type ISandboxSupervisor, type MiniSandboxConfig, type PolicyViolation, type ProposalOutcome, type RuntimeKind, type SandboxExecutionResult } from "./types.ts";

/**
 * The master sandbox.
 *
 * Owns every mini-sandbox's lifecycle and is the only thing that can act on
 * its behalf. spawn → attach to a broker task scoped to the tenant; execute →
 * run with limits, every syscall through the IPC broker; a policy violation →
 * record it, kill the run, terminate the sandbox for good.
 *
 * A timeout or crash kills the RUN, not the sandbox — the code was expensive,
 * not malicious. Only a violation (an unauthorised or malformed syscall)
 * terminates it.
 */

export interface SupervisorOptions {
  bridge: AgamemnonProposalBridge;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called on every violation, after it is recorded. */
  onViolation?: (v: PolicyViolation) => void;
  /** Plug in other runtimes (a microVM adapter). Non-isolated runtimes are still refused. */
  runtimeFactory?: (kind: RuntimeKind) => ISandboxRuntime;
}

interface Sandbox extends SandboxRecord {
  runtime: ISandboxRuntime | null;
  limits: RunLimits;
  violation: PolicyViolation | null;
  terminatedReason: string | null;
}

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const FLAGS = new Set<string>(Object.values(CapabilityFlags));
const LIMIT_BOUNDS = { maxMemoryMb: [1, 512], timeoutMs: [1, 60_000], maxSyscalls: [0, 10_000] } as const;

export function createRuntime(kind: RuntimeKind): ISandboxRuntime {
  switch (kind) {
    case "quickjs-wasm":
      return new QuickJSRuntime();
    case "worker-thread":
      return new WorkerThreadRuntime();
    case "microvm-adapter": {
      const opts = microVmFromEnv();
      if (!opts) throw new RuntimeUnavailable(kind, "no vmhost configured — set AGAMEMNON_VMHOST and AGAMEMNON_VMHOST_TOKEN (see packages/sandbox/vmhost/README.md)");
      return new MicroVmRuntime(opts);
    }
    default:
      throw new RuntimeUnavailable(kind, "unknown runtime");
  }
}

export class SandboxSupervisor implements ISandboxSupervisor {
  readonly #sandboxes = new Map<string, Sandbox>();
  readonly #violations: PolicyViolation[] = [];
  readonly #ipc: IpcBroker;
  readonly #opts: SupervisorOptions;
  readonly #now: () => number;

  constructor(opts: SupervisorOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
    this.#ipc = new IpcBroker({
      bridge: opts.bridge,
      fetch: opts.fetch,
      now: this.#now,
      lookup: (id) => this.#sandboxes.get(id),
      onViolation: (sb, syscall, reason) => this.#record(sb as Sandbox, syscall, reason),
    });
  }

  async spawnSandbox(config: MiniSandboxConfig): Promise<string> {
    const limits = validate(config);
    if (this.#sandboxes.has(config.id)) throw new Error(`sandbox id ${config.id} is already in use`);
    const runtime = (this.#opts.runtimeFactory ?? createRuntime)(config.runtime);
    if (!runtime.isolated) {
      runtime.dispose();
      throw new RuntimeUnavailable(config.runtime, "this runtime does not isolate untrusted code");
    }
    const sb: Sandbox = {
      config: structuredClone(config),
      status: "ready",
      inbox: [],
      tainted: false,
      runtime,
      limits,
      violation: null,
      terminatedReason: null,
    };
    try {
      await this.#opts.bridge.attach(config.id, config.tenantId, config.owner);
    } catch (e) {
      runtime.dispose();
      throw e;
    }
    this.#sandboxes.set(config.id, sb);
    return config.id;
  }

  async executeInSandbox(sandboxId: string, code: string, context: Record<string, unknown> = {}): Promise<SandboxExecutionResult> {
    const sb = this.#get(sandboxId);
    if (sb.status === "terminated" || !sb.runtime) throw new Error(`sandbox ${sandboxId} was terminated: ${sb.terminatedReason}`);
    if (sb.status === "running") throw new Error(`sandbox ${sandboxId} is already running`);
    if (typeof code !== "string") throw new Error("code must be a string");

    const proposals: ProposalOutcome[] = [];
    sb.status = "running";
    let out;
    try {
      out = await sb.runtime.run({ code, context, limits: sb.limits, onSyscall: (raw) => this.#ipc.handle(sb, raw, proposals) });
    } finally {
      if (sb.status === "running") sb.status = "ready";
    }
    if (sb.violation) await this.#terminate(sb, `policy violation: ${sb.violation.reason}`);
    return {
      success: out.ok,
      data: out.value,
      proposals,
      logs: out.logs,
      executionTimeMs: out.executionTimeMs,
      error: out.error,
      killed: out.killed,
    };
  }

  async terminateSandbox(sandboxId: string): Promise<void> {
    await this.#terminate(this.#get(sandboxId), "terminated by supervisor");
  }

  /** Every violation recorded, oldest first. */
  violations(): readonly PolicyViolation[] {
    return this.#violations;
  }

  status(sandboxId: string) {
    const sb = this.#get(sandboxId);
    return {
      id: sb.config.id,
      status: sb.status,
      tenantId: sb.config.tenantId,
      owner: sb.config.owner ?? null,
      runtime: sb.config.runtime,
      grants: sb.config.capabilities.grants,
      tainted: sb.tainted,
      pendingMessages: sb.inbox.length,
      terminatedReason: sb.terminatedReason,
    };
  }

  /** Every sandbox this supervisor knows, terminated ones included. */
  list() {
    return [...this.#sandboxes.keys()].map((id) => this.status(id));
  }

  #get(sandboxId: string): Sandbox {
    const sb = this.#sandboxes.get(sandboxId);
    if (!sb) throw new Error(`no such sandbox: ${sandboxId}`);
    return sb;
  }

  #record(sb: Sandbox, syscall: unknown, reason: string) {
    const v: PolicyViolation = { sandboxId: sb.config.id, tenantId: sb.config.tenantId, at: this.#now(), syscall, reason };
    sb.violation ??= v;
    this.#violations.push(v);
    this.#opts.onViolation?.(v);
    void this.#opts.bridge.recordViolation?.(v).catch(() => {});
  }

  async #terminate(sb: Sandbox, reason: string) {
    if (sb.status === "terminated") return;
    sb.status = "terminated";
    sb.terminatedReason = reason;
    sb.inbox.length = 0;
    sb.runtime?.dispose();
    sb.runtime = null;
    await this.#opts.bridge.detach(sb.config.id);
  }
}

/** Check a config the caller handed us and fill in default limits. */
function validate(config: MiniSandboxConfig): RunLimits {
  if (!config || typeof config !== "object") throw new Error("config must be an object");
  if (typeof config.id !== "string" || !ID.test(config.id)) throw new Error("config.id must match /^[A-Za-z0-9._-]{1,64}$/");
  if (typeof config.tenantId !== "string" || config.tenantId.length === 0) throw new Error("config.tenantId is required");
  const caps = config.capabilities;
  if (!caps || !Array.isArray(caps.grants)) throw new Error("config.capabilities.grants must be an array");
  for (const g of caps.grants) if (!FLAGS.has(g)) throw new Error(`unknown capability ${JSON.stringify(g)}`);
  if (config.owner !== undefined && (typeof config.owner !== "string" || !ID.test(config.owner))) throw new Error("config.owner must be a principal name");
  if (caps.allowedDomains !== undefined && (!Array.isArray(caps.allowedDomains) || caps.allowedDomains.some((d) => typeof d !== "string"))) {
    throw new Error("config.capabilities.allowedDomains must be an array of hostnames");
  }
  const limits: RunLimits = {
    maxMemoryMb: caps.maxMemoryMb ?? DEFAULT_LIMITS.maxMemoryMb,
    timeoutMs: caps.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    maxSyscalls: caps.maxSyscalls ?? DEFAULT_LIMITS.maxSyscalls,
  };
  for (const [k, [lo, hi]] of Object.entries(LIMIT_BOUNDS)) {
    const v = limits[k as keyof RunLimits];
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`capabilities.${k} must be between ${lo} and ${hi}`);
  }
  return limits;
}
