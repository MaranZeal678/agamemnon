"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import type { ClassifierVerdict } from "./policy";

/**
 * Blast-radius classifier.
 *
 * The model ADVISES; it can never stall or decide the write path:
 *  - temperature 0, strict-JSON prompt
 *  - hard 800ms timeout via AbortController
 *  - any failure (disabled, no key, timeout, bad JSON) → deterministic heuristic
 *
 * Everything below the `classify` action is pure and unit-testable.
 */

// ── Pure heuristic fallback ─────────────────────────────────────────────────
export function heuristicVerdict(input: {
  matchingRows: number;
  totalRows: number;
  destructive: boolean;
  target: string;
}): ClassifierVerdict {
  const { matchingRows, totalRows, destructive, target } = input;
  const fraction = totalRows > 0 ? matchingRows / totalRows : matchingRows > 0 ? 1 : 0;
  const blast_radius = Math.max(0, Math.min(1, fraction));
  const pct = (blast_radius * 100).toFixed(2);

  let cls: string;
  if (!destructive) cls = "benign";
  else if (blast_radius >= 0.9) cls = "catastrophic";
  else if (blast_radius >= 0.2 || matchingRows > 1000) cls = "elevated";
  else cls = "benign";

  return {
    class: cls,
    blast_radius,
    rationale: `matches ${matchingRows.toLocaleString()} of ${totalRows.toLocaleString()} rows in ${target} (${pct}% of the table)`,
    source: "heuristic",
  };
}

// ── Nebius call (Phase 5 wiring; flag-gated) ────────────────────────────────
const SYSTEM_PROMPT = `You are a database blast-radius classifier for a freight operations system.
Given a proposed destructive SQL action, classify how catastrophic it is.
Respond with STRICT JSON only, no prose, in exactly this shape:
{"class": "benign" | "elevated" | "catastrophic", "blast_radius": <number 0..1>, "rationale": "<one short sentence>"}
- benign: a small, bounded change (well under 1% of the table).
- elevated: a large but plausibly-intended change.
- catastrophic: matches most or all of the table, or is clearly unbounded.
blast_radius is your estimate of the fraction of the target table affected.`;

export function buildUserPrompt(a: {
  target: string;
  predicateSql: string;
  matchingRows: number;
  totalRows: number;
  agentMedian: number;
}): string {
  return `Target table: ${a.target}
Total rows in table: ${a.totalRows}
Rows this action would delete (measured): ${a.matchingRows}
This agent's 30-day median rows/action: ${a.agentMedian}
Proposed statement:
${a.predicateSql}

Classify it.`;
}

export function parseVerdict(raw: string): { class: string; blast_radius: number; rationale: string } {
  // Tolerate models that wrap JSON in prose or code fences.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("no JSON object in model output");
  const obj = JSON.parse(match[0]);
  if (typeof obj.class !== "string" || typeof obj.blast_radius !== "number") {
    throw new Error("verdict missing required fields");
  }
  return {
    class: obj.class,
    blast_radius: Math.max(0, Math.min(1, obj.blast_radius)),
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
  };
}

export const classify = internalAction({
  args: {
    target: v.string(),
    predicateSql: v.string(),
    matchingRows: v.number(),
    totalRows: v.number(),
    destructive: v.boolean(),
    agentMedian: v.number(),
  },
  handler: async (_ctx, args): Promise<ClassifierVerdict> => {
    const heuristic = heuristicVerdict(args);

    const enabled = process.env.CLASSIFIER_ENABLED !== "false";
    const key = process.env.NEBIUS_API_KEY;
    if (!enabled || !key) return heuristic; // feature flag / no key → heuristic

    const base = process.env.NEBIUS_BASE_URL ?? "https://api.studio.nebius.com/v1/";
    const model = process.env.NEBIUS_CLASSIFIER_MODEL ?? "Qwen/Qwen3-30B-A3B-Instruct-2507";
    const timeoutMs = Number(process.env.CLASSIFIER_TIMEOUT_MS ?? 800);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); // hard cap
    const started = Date.now();
    try {
      const res = await fetch(new URL("chat/completions", base), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 200,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(args) },
          ],
        }),
      });
      if (!res.ok) return heuristic;
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? "";
      const parsed = parseVerdict(content);
      return { ...parsed, source: "model", latencyMs: Date.now() - started };
    } catch {
      return heuristic; // timeout or any error → deterministic fallback
    } finally {
      clearTimeout(timer);
    }
  },
});
