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

import type { TrustLabel } from "@agamemnon/kernel";
import type { AgamemnonProposalBridge, CapabilityFlag, MiniSandboxConfig, PolicyViolation, ProposalOutcome, Scalar, SandboxMutation } from "../types.ts";

/** A bridge that records what it was asked and answers like the broker would. */
export class FakeBridge implements AgamemnonProposalBridge {
  attached = new Map<string, string>();
  detached: string[] = [];
  writes: Array<{ sandboxId: string; mutation: SandboxMutation; provenance?: TrustLabel[] }> = [];
  reads: Array<{ sandboxId: string; table: string; where?: Record<string, Scalar> }> = [];
  violations: PolicyViolation[] = [];
  rows: unknown[] = [];
  /** What the "broker" decides for a write. Default: executed. */
  decide: (m: SandboxMutation) => Pick<ProposalOutcome, "status" | "firedRules"> = () => ({ status: "executed", firedRules: [] });
  readStatus = "executed";
  #n = 0;

  async attach(sandboxId: string, tenantId: string) {
    this.attached.set(sandboxId, tenantId);
  }
  async detach(sandboxId: string) {
    this.detached.push(sandboxId);
  }
  async handleSandboxWriteProposal(sandboxId: string, mutation: SandboxMutation, meta?: { provenance?: TrustLabel[] }): Promise<ProposalOutcome> {
    this.writes.push({ sandboxId, mutation, provenance: meta?.provenance });
    const d = this.decide(mutation);
    return { proposalId: `eff_${++this.#n}`, status: d.status, approved: d.status === "executed", summary: `${mutation.operation} ${mutation.table}`, counts: { rows: 1 }, firedRules: d.firedRules };
  }
  async handleSandboxRead(sandboxId: string, query: { table: string; where?: Record<string, Scalar> }) {
    this.reads.push({ sandboxId, ...query });
    const outcome: ProposalOutcome = { proposalId: `eff_${++this.#n}`, status: this.readStatus, approved: this.readStatus === "executed", summary: `read ${query.table}`, counts: { rows: this.rows.length }, firedRules: [] };
    return { rows: this.rows, outcome };
  }
  async recordViolation(v: PolicyViolation) {
    this.violations.push(v);
  }
}

let seq = 0;
/** A quickjs-wasm sandbox config with tight limits for tests. */
export function sandbox(grants: CapabilityFlag[] = [], over: Partial<MiniSandboxConfig> & { allowedDomains?: string[]; timeoutMs?: number; maxMemoryMb?: number } = {}): MiniSandboxConfig {
  const { allowedDomains, timeoutMs, maxMemoryMb, ...rest } = over;
  return {
    id: `sb-${++seq}`,
    tenantId: "tenant-a",
    runtime: "quickjs-wasm",
    capabilities: { grants, allowedDomains, maxMemoryMb: maxMemoryMb ?? 32, timeoutMs: timeoutMs ?? 2000 },
    ...rest,
  };
}

/** A fetch stand-in: answers from a handler, records every URL. */
export function fakeFetch(handler: (url: URL) => { status?: number; body?: string; headers?: Record<string, string> }) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.href);
    const r = handler(url);
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? { "content-type": "text/plain" } });
  }) as typeof fetch;
  return { impl, calls };
}
