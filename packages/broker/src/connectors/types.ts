// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import type { ArtifactRef, Effect, EffectRequest, FiredRule, ObservedFacts, TrustLabel, WriteRecord } from "@agamemnon/kernel";
import type { Store, EffectRow } from "../store.ts";
import type { Vault } from "../vault.ts";

/**
 * The Consequence Adapter contract every connector implements.
 *
 *   prepare  → measure the real effect, label its fidelity honestly, type its
 *              reversibility, and produce a precondition token
 *   execute  → re-check the precondition ATOMICALLY and refuse on drift; run;
 *              capture before-images / created artifacts
 *   verify   → (in execute's result) what the system of record shows now
 *   compensate / release / cancel / revokeArtifact → the reversal side
 *
 * A connector that can neither undo, compensate nor defer an operation must
 * type it "irreversible" — the kernel then requires two humans.
 */

export interface ConnectorContext {
  store: Store;
  vault: Vault;
  now: () => number;
}

export interface Prepared {
  effect: Effect;
  /** Rules the connector evaluated (row policy, value collapse, unsupported shape …). */
  connectorRules?: FiredRule[];
  readVersion?: { ok: boolean; detail: string };
  /** The connector can turn this into a cancellable hold. */
  canDefer?: boolean;
  /** Connector-private data needed at execution (normalised SQL, plan path …). Persisted. */
  internal?: Record<string, unknown>;
  /** For reads: the rows/result to return to the agent (already masked). */
  readResult?: unknown;
  /** Trust labels of data this effect READ (for task taint). */
  readLabels?: { labels: TrustLabel[]; private: boolean; source: string };
}

export interface Executed {
  outcome: "executed" | "held";
  observedCounts: Record<string, number>;
  writes?: Array<Omit<WriteRecord, "taskId" | "effectId" | "at"> & { target: string }>;
  artifacts?: Array<ArtifactRef & { revoke?: unknown }>;
  facts?: Partial<ObservedFacts>;
  holdUntil?: number;
  detail?: string;
  /** Connector data for a later compensate() (snapshot pointer, refund id …). */
  undo?: Record<string, unknown>;
  result?: unknown;
}

export interface Compensated {
  detail: string;
  restored?: number;
  skipped?: Array<{ key: string; reason: string }>;
}

export interface Connector {
  readonly system: string;
  readonly operations: string[];
  prepare(req: EffectRequest, ctx: ConnectorContext): Promise<Prepared>;
  execute(req: EffectRequest, prepared: Prepared, ctx: ConnectorContext): Promise<Executed>;
  /** Reverse one executed effect (undo / compensating action). */
  compensate?(row: EffectRow, ctx: ConnectorContext): Promise<Compensated>;
  /** Selectively revert all of a task lineage's writes in this system, preserving later edits. */
  revertWrites?(writes: Array<WriteRecord & { target: string }>, taskIds: string[], ctx: ConnectorContext): Promise<Compensated>;
  /** Perform a held effect once its window has passed. */
  release?(row: EffectRow, ctx: ConnectorContext): Promise<Executed>;
  /** Cancel a held effect inside its window. */
  cancel?(row: EffectRow, ctx: ConnectorContext): Promise<Compensated>;
  revokeArtifact?(artifact: { id: string; kind: string; revoke: any }, ctx: ConnectorContext): Promise<void>;
  /** Read systems of record for claim verification (CI conclusion, backups …). */
  facts?(taskId: string, ctx: ConnectorContext): Promise<Partial<ObservedFacts>>;
}

export class ConnectorError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.rule = rule;
  }
}
