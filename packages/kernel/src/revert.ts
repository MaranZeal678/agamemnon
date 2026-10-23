// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * Selective revert — undo one task's writes without clobbering anyone else's.
 *
 * Lineage: Retro (OSDI'10), Warp (SOSP'11) and Aire (SOSP'13) showed how to
 * repair a compromised application by undoing only the attacker's actions and
 * re-checking everything that depended on them. This applies the same idea to
 * agent writes: every write Agamemnon executes is tagged with its task and
 * keeps a before-image plus a hash of the row it left behind. Reverting a task
 * restores only rows that are still exactly as the task left them; rows a
 * human (or another task) changed since are skipped and reported, never
 * overwritten.
 */

export interface WriteRecord {
  effectId: string;
  taskId: string;
  at: number;
  /** "table:pk" style key. */
  key: string;
  /** Row before the write; null if the write inserted it. */
  before: Record<string, unknown> | null;
  /** Hash of the row after the write; null if the write deleted it. */
  afterHash: string | null;
}

export interface RevertPlan {
  restore: Array<{ key: string; before: Record<string, unknown> | null; action: "reinsert" | "overwrite" | "delete" }>;
  skip: Array<{ key: string; reason: string }>;
}

/**
 * `current(key)` returns the hash of the row as it is NOW (null if absent).
 * Only the earliest before-image per key within the task is restored — that
 * is the state before the task touched the row at all.
 */
export function planRevert(writes: WriteRecord[], taskId: string, current: (key: string) => string | null): RevertPlan {
  const mine = writes.filter((w) => w.taskId === taskId).sort((a, b) => a.at - b.at);
  const firstBefore = new Map<string, WriteRecord>();
  const lastAfter = new Map<string, WriteRecord>();
  for (const w of mine) {
    if (!firstBefore.has(w.key)) firstBefore.set(w.key, w);
    lastAfter.set(w.key, w);
  }
  const plan: RevertPlan = { restore: [], skip: [] };
  for (const [key, first] of firstBefore) {
    const last = lastAfter.get(key)!;
    const now = current(key);
    if (now !== last.afterHash) {
      plan.skip.push({
        key,
        reason: last.afterHash === null ? "the key was re-used after this task deleted it" : "the row was changed after this task (later edit preserved)",
      });
      continue;
    }
    if (first.before === null) plan.restore.push({ key, before: null, action: "delete" });
    else if (last.afterHash === null) plan.restore.push({ key, before: first.before, action: "reinsert" });
    else plan.restore.push({ key, before: first.before, action: "overwrite" });
  }
  return plan;
}

export interface EffectNode {
  id: string;
  at: number;
  reads: string[];
  writes: string[];
}

const touches = (a: string, b: string) => a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);

/** Effects that (transitively) read something `rootId` wrote, after it ran. */
export function dependents(nodes: EffectNode[], rootId: string): EffectNode[] {
  const byTime = [...nodes].sort((a, b) => a.at - b.at);
  const root = byTime.find((n) => n.id === rootId);
  if (!root) return [];
  const tainted = new Set<string>(root.writes);
  const out: EffectNode[] = [];
  for (const n of byTime) {
    if (n.at <= root.at || n.id === rootId) continue;
    if (n.reads.some((r) => [...tainted].some((t) => touches(r, t)))) {
      out.push(n);
      n.writes.forEach((w) => tainted.add(w));
    }
  }
  return out;
}
