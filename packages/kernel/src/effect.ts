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

import { hashOf } from "./hash.ts";
import type { Principal } from "./approvals.ts";

/**
 * The effect model — the noun the whole Gen-2 kernel reasons about.
 *
 * A REQUEST is what an agent asks for ("delete these rows", "apply this plan",
 * "send this email"). An EFFECT is what the connector measured that request
 * would actually do, typed by how (and whether) it can be reversed BEFORE it
 * runs. Approval is bound to the effect, never to the request text.
 */

/** How an effect can be reversed — decided before execution, not after. */
export type Reversibility =
  | "undo" // a true inverse exists (before-images, versioning, reflog)
  | "compensate" // reversible by a compensating action (refund, re-apply)
  | "hold" // converted to a delayed/held action that can be cancelled in a window
  | "irreversible"; // nothing can take it back (SMS, delivered email, provider hard delete)

/** How faithful the preview is. An estimate must never be presented as exact. */
export type Fidelity = "exact" | "estimated" | "rendered";

/** Trust level of the inputs that shaped a request (for cross-session taint). */
export type TrustLabel = "user" | "internal" | "untrusted";

export interface Delegation {
  /** The human ultimately responsible (who launched the agent). */
  rootOwner: string;
  /** user → agent → sub-agent, outermost first. Permissions only narrow per hop. */
  chain: Principal[];
}

export interface TargetRef {
  system: string; // "postgres" | "github" | "terraform" | "aws" | "stripe" | "email" | "monitoring" | "fs"
  resource: string; // table, repo, workspace, customer, mailbox, monitor id, path …
  env?: string; // declared environment of the target ("prod", "staging", …)
  tenant?: string;
}

/** A structured claim an agent makes about the world, checked after execution. */
export interface Claim {
  type: "env" | "rows" | "tests" | "backup" | "refund" | "created" | "deleted" | "touched" | "sent" | "reversible";
  value: string | number | boolean;
  /** What the claim is about (a table, a repo, a customer, a run). */
  subject?: string;
  /** How the claim reached us. "declared" = structured; "extracted" = parsed from prose. */
  source?: "declared" | "extracted";
}

export interface EffectRequest {
  id: string;
  taskId: string;
  /** Connector-specific operation, e.g. "postgres.delete", "terraform.apply". */
  operation: string;
  target: TargetRef;
  params: Record<string, unknown>;
  requester: Principal;
  delegation: Delegation;
  /** What the agent says it expects — compared against the measured effect. */
  declared?: { expectedCount?: number; env?: string; goal?: string };
  /** Trust labels of inputs that shaped this request (ticket text, web page …). */
  provenance?: TrustLabel[];
  claims?: Claim[];
  createdAt: number;
}

/** A durable artifact an effect creates (API key, webhook, workflow, IAM user …). */
export interface ArtifactRef {
  kind: string;
  id: string;
  system: string;
  /** Grants access that would outlive the task if not revoked. */
  durableAccess: boolean;
}

export interface OversightFinding {
  rule: string;
  detail: string;
}

export interface Preview {
  summary: string;
  /** Measured counts, e.g. { rows: 900 }, { destroy: 2, replace: 1 }, { recipients: 4000 }. */
  counts: Record<string, number>;
  fidelity: Fidelity;
  /** A few concrete examples the approver can eyeball (rows, resources, recipients). */
  sample?: unknown[];
  /** Connector-specific structured detail (diff, plan JSON excerpt …). */
  details?: Record<string, unknown>;
  /** Money moved, in minor units, if any. */
  amountMinor?: number;
}

export interface Effect {
  request: EffectRequest;
  reversibility: Reversibility;
  /** For "hold": how long the cancel window lasts (ms). */
  windowMs?: number;
  preview: Preview;
  /**
   * Opaque state token the connector re-checks at execution time (row-set
   * hash, ETag, k8s resourceVersion, saved-plan hash, object version). If the
   * world drifted from it, execution is refused.
   */
  precondition: string;
  /** Oversight-reducing aspects (tests deleted, alerts muted, audit disabled …). */
  oversight: OversightFinding[];
  /** Durable artifacts this effect would create. */
  creates: ArtifactRef[];
  /** Can this effect move data outside the boundary (email, public PR, webhook, export)? */
  egress: boolean;
  /** Did producing it read private data? (feeds the lethal-trifecta rule) */
  readsPrivate?: boolean;
  /** Resource keys this effect reads and writes (for leases and dependency tracking). */
  reads: string[];
  writes: string[];
  /** Is the target's backup in the same blast radius as the data? */
  destroysBackups?: boolean;
}

/** Canonical hash of the measured effect — what approval is bound to. */
export function effectHash(e: Effect): string {
  return hashOf({
    operation: e.request.operation,
    target: e.request.target,
    params: e.request.params,
    reversibility: e.reversibility,
    windowMs: e.windowMs ?? null,
    counts: e.preview.counts,
    amountMinor: e.preview.amountMinor ?? null,
    precondition: e.precondition,
    creates: e.creates,
    egress: e.egress,
  });
}

export interface Binding {
  effectHash: string;
  precondition: string;
  issuedAt: number;
  expiresAt: number;
  /** Hash over the fields above — what a receipt and the executor check. */
  bindingHash: string;
}

/** Bind an approval to exactly this measured effect, for a limited time. */
export function bindEffect(e: Effect, now: number, ttlMs = 15 * 60 * 1000): Binding {
  const effectH = effectHash(e);
  const issuedAt = now;
  const expiresAt = now + ttlMs;
  return {
    effectHash: effectH,
    precondition: e.precondition,
    issuedAt,
    expiresAt,
    bindingHash: hashOf({ effectH, precondition: e.precondition, issuedAt, expiresAt }),
  };
}

export type BindingCheck = { ok: true } | { ok: false; reason: string };

/**
 * At execution: the connector re-measures the effect and the precondition.
 * Anything different from what was approved — more rows, a different plan, a
 * changed ETag, an expired approval — refuses to run.
 */
export function checkBinding(b: Binding, remeasured: Effect, now: number): BindingCheck {
  if (now > b.expiresAt) return { ok: false, reason: "approval expired before execution" };
  const recomputed = hashOf({ effectH: b.effectHash, precondition: b.precondition, issuedAt: b.issuedAt, expiresAt: b.expiresAt });
  if (recomputed !== b.bindingHash) return { ok: false, reason: "binding was tampered with" };
  if (remeasured.precondition !== b.precondition) {
    return { ok: false, reason: "the target changed since approval (precondition drift) — re-measure and re-approve" };
  }
  if (effectHash(remeasured) !== b.effectHash) {
    return { ok: false, reason: "the effect differs from the one approved — re-measure and re-approve" };
  }
  return { ok: true };
}

/** Stable fingerprint of a request's SHAPE (for denial memory and auto-approve suggestions). */
export function requestFingerprint(r: Pick<EffectRequest, "operation" | "target" | "params">, shape?: string): string {
  return hashOf({ op: r.operation, system: r.target.system, resource: r.target.resource, shape: shape ?? Object.keys(r.params).sort() });
}
