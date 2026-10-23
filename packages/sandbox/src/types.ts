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

import type { FiredRule, TrustLabel } from "@agamemnon/kernel";

/**
 * Mini-sandboxes — the vocabulary.
 *
 * A mini-sandbox is an enclave that runs untrusted code (agent-generated
 * scripts, third-party plugins, swarm members) with NO ambient authority: no
 * filesystem, no network, no database, no host memory. The only way out is a
 * SYSCALL — a JSON request the enclave hands to the supervisor (the master
 * sandbox). The supervisor checks it against the sandbox's capabilities, and
 * anything that would change the world becomes an ordinary Agamemnon effect
 * proposal: measured, admitted by reversibility, receipted, revertible.
 *
 * The enclave never decides anything. It only asks.
 */

// --- 1. Capabilities -------------------------------------------------------

/**
 * What a sandbox may ask for. Granted explicitly per sandbox; nothing is
 * implied. (A const object, not an enum — packages run on Node's native TS
 * stripping, which rejects enums.)
 */
export const CapabilityFlags = {
  /** db.select — reads through the broker (masked, taint-labelled). */
  READ_ONLY: "READ_ONLY",
  /** db.insert / db.update / db.delete — proposals only, never direct writes. */
  MUTATE_STATE: "MUTATE_STATE",
  /** api.fetch — HTTPS GET to `allowedDomains` only. */
  EXTERNAL_HTTP: "EXTERNAL_HTTP",
  /** agents.send / agents.recv — swarm messages, brokered by the supervisor. */
  AGENT_IPC: "AGENT_IPC",
} as const;
export type CapabilityFlag = (typeof CapabilityFlags)[keyof typeof CapabilityFlags];

export interface SandboxCapabilities {
  /** Granted capabilities. Empty = pure compute: the code can only return a value. */
  grants: CapabilityFlag[];
  /** Exact hostnames api.fetch may reach (only with EXTERNAL_HTTP). Default: none. */
  allowedDomains?: string[];
  /** QuickJS heap cap for one run. */
  maxMemoryMb: number;
  /** Wall-clock cap for one run, including time spent waiting on syscalls. */
  timeoutMs: number;
  /** Syscalls one run may make before it is killed. Default 256. */
  maxSyscalls?: number;
}

export type RuntimeKind = "quickjs-wasm" | "worker-thread" | "microvm-adapter";

export interface MiniSandboxConfig {
  id: string;
  /** Every proposal this sandbox makes is scoped to this tenant by the broker task. */
  tenantId: string;
  capabilities: SandboxCapabilities;
  runtime: RuntimeKind;
  /** Optional swarm role ("research", "coder", "audit") — a label, not a permission. */
  role?: string;
}

/** Defaults the supervisor applies when a config leaves a limit out. */
export const DEFAULT_LIMITS = { maxMemoryMb: 64, timeoutMs: 5000, maxSyscalls: 256 } as const;

// --- 2. Syscalls (enclave → supervisor) ------------------------------------

/** A JSON scalar — the only thing a WHERE clause may compare against. */
export type Scalar = string | number | boolean | null;

export interface SandboxMutation {
  table: string;
  operation: "insert" | "update" | "delete";
  /** Column values for insert/update. Ignored for delete. */
  data: Record<string, unknown>;
  /** Equality filter for update/delete. Omitted = the whole table (the broker will measure that). */
  where?: Record<string, Scalar>;
}

/**
 * Everything an enclave can ask for. The runtime delivers these UNVALIDATED
 * (as `unknown`) — the supervisor must parse them before trusting a field.
 */
export type Syscall =
  | { op: "db.select"; table: string; where?: Record<string, Scalar> }
  | { op: "db.mutate"; mutation: SandboxMutation }
  | { op: "http.fetch"; url: string }
  | { op: "ipc.send"; to: string; message: unknown }
  | { op: "ipc.recv" };

/** An inter-agent message as the recipient sees it — always labelled untrusted. */
export interface AgentMessage {
  from: string;
  message: unknown;
  labels: TrustLabel[];
  at: number;
}

// --- 3. Results ------------------------------------------------------------

/** What the broker decided about one sandbox proposal. */
export interface ProposalOutcome {
  proposalId: string;
  /** The broker's effect status: executed | awaiting_approval | held | blocked | denied … */
  status: string;
  /** True only when the effect actually ran (status "executed"). */
  approved: boolean;
  summary: string;
  /** Measured blast radius (rows, recipients …) — not the agent's estimate. */
  counts: Record<string, number>;
  firedRules: FiredRule[];
}

/** A capability breach that killed a sandbox. */
export interface PolicyViolation {
  sandboxId: string;
  tenantId: string;
  at: number;
  /** The offending request, as far as it could be read. */
  syscall: unknown;
  reason: string;
}

export interface SandboxExecutionResult<T = unknown> {
  success: boolean;
  data?: T;
  proposals: ProposalOutcome[];
  logs: string[];
  executionTimeMs: number;
  error?: string;
  /** Set when the supervisor killed the sandbox (violation, timeout, budget). */
  killed?: string;
}

// --- 4. Supervisor & bridge ------------------------------------------------

export interface ISandboxSupervisor {
  spawnSandbox(config: MiniSandboxConfig): Promise<string>;
  executeInSandbox(sandboxId: string, code: string, context: Record<string, unknown>): Promise<SandboxExecutionResult>;
  terminateSandbox(sandboxId: string): Promise<void>;
}

/** Turns sandbox requests into Agamemnon effects. The only path to the world. */
export interface AgamemnonProposalBridge {
  /** Bind a sandbox to a broker task scoped to its tenant (called on spawn). */
  attach(sandboxId: string, tenantId: string): Promise<void>;
  /** End the sandbox's broker task (called on terminate). */
  detach(sandboxId: string): Promise<void>;
  handleSandboxWriteProposal(sandboxId: string, mutation: SandboxMutation, meta?: { provenance?: TrustLabel[] }): Promise<ProposalOutcome>;
  handleSandboxRead(sandboxId: string, query: { table: string; where?: Record<string, Scalar> }): Promise<{ rows: unknown[]; outcome: ProposalOutcome }>;
  /** Persist a violation where operators look (the broker's audit log). */
  recordViolation?(violation: PolicyViolation): Promise<void>;
}
