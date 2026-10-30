// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import type { RuntimeKind } from "../types.ts";

/**
 * The contract between the supervisor and an execution enclave.
 *
 * A runtime knows how to run code with limits and how to carry syscalls out
 * of the enclave. It knows NOTHING about capabilities, tenants or the broker —
 * that is the supervisor's job. Keeping policy out of the runtime means a new
 * runtime (isolated-vm, a microVM) cannot weaken it by accident.
 */

export interface RunLimits {
  maxMemoryMb: number;
  timeoutMs: number;
  maxSyscalls: number;
}

/**
 * Called for every syscall. `request` is whatever the enclave sent, already
 * JSON-decoded but NOT validated. Return a JSON-serialisable reply (handed
 * back to the guest), throw an Error (the guest sees a rejected promise), or
 * throw SandboxKill (the run is aborted and the enclave torn down).
 */
export type SyscallHandler = (request: unknown) => Promise<unknown>;

export interface RunRequest {
  code: string;
  /** Exposed to the guest as a deep-frozen global `context`. */
  context: Record<string, unknown>;
  limits: RunLimits;
  onSyscall: SyscallHandler;
}

export interface RunOutcome {
  ok: boolean;
  /** The guest's return value, JSON round-tripped. */
  value?: unknown;
  error?: string;
  /** Why the run was killed, if it was. */
  killed?: string;
  logs: string[];
  executionTimeMs: number;
  syscalls: number;
}

export interface ISandboxRuntime {
  readonly kind: RuntimeKind;
  /** Does this runtime actually confine untrusted code? Supervisors must refuse `false`. */
  readonly isolated: boolean;
  run(req: RunRequest): Promise<RunOutcome>;
  /** Abort the current run, if any. Safe to call at any time. */
  kill(reason: string): void;
  /** Release the enclave. Further runs are refused. */
  dispose(): void;
}

/** Thrown by a SyscallHandler to kill the enclave rather than fail one call. */
export class SandboxKill extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** A runtime that exists in the type but cannot (or must not) run here. */
export class RuntimeUnavailable extends Error {
  readonly kind: RuntimeKind;
  constructor(kind: RuntimeKind, why: string) {
    super(`${kind}: ${why}`);
    this.kind = kind;
  }
}
