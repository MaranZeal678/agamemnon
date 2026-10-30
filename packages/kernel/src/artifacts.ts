// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * Agent-created artifact lifecycle.
 *
 * Identity tools manage the agent's own credentials. What they miss is what an
 * agent CREATES while working — an API key, a webhook, a deploy key, a GitHub
 * workflow, an IAM user, a cron job — durable access that outlives the task
 * (the Shai-Hulud worm persisted exactly this way). The broker records every
 * artifact against the task that created it; when the task ends, every
 * durable artifact is revoked unless a human promoted it.
 */

export interface Artifact {
  id: string;
  kind: string; // "api_key" | "webhook" | "deploy_key" | "workflow" | "iam_user" | "cron" | …
  system: string;
  taskId: string;
  createdAt: number;
  durableAccess: boolean;
  promotedBy?: string;
  revokedAt?: number;
}

/** Durable artifacts from this task that must be revoked now. */
export function artifactsToRevoke(artifacts: Artifact[], taskId: string): Artifact[] {
  return artifacts.filter((a) => a.taskId === taskId && a.durableAccess && !a.promotedBy && !a.revokedAt);
}

/** Safety net for tasks that never "end": durable artifacts older than maxAgeMs. */
export function staleArtifacts(artifacts: Artifact[], now: number, maxAgeMs = 24 * 3600 * 1000): Artifact[] {
  return artifacts.filter((a) => a.durableAccess && !a.promotedBy && !a.revokedAt && now - a.createdAt > maxAgeMs);
}
