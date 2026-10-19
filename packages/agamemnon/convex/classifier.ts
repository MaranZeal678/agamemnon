"use node";
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { heuristicVerdict as kernelHeuristic, type ClassifierVerdict } from "./policy";

/**
 * Blast-radius classifier.
 *
 * The model ADVISES; it can never stall or decide the write path:
 *  - temperature 0, strict-JSON prompt
 *  - hard 800ms timeout via AbortController
 *  - any failure (disabled, no key, timeout, bad JSON) → deterministic heuristic
 *
 *
 * DATA MINIMISATION: the model sees structured facts only — table name, row
 * counts, the agent's median, and the predicate's SHAPE with every literal
 * replaced by $n. Literal values (emails, names, IDs) and the agent's own
 * prose never leave the boundary. Enable Nebius Zero Data Retention for the
 * org as well (see SETUP.md) — Token Factory retains prompts by default.
 *
 * Everything below the `classify` action is pure and unit-testable.
 */

// ── Pure heuristic fallback (the kernel's, re-exported for existing callers) ──
export const heuristicVerdict = kernelHeuristic;

// ── Nebius call (flag-gated) ─────────────────────────────────────────────────
function systemPrompt(domain: string) {
  return `You are a database blast-radius classifier for ${domain}.
Given a proposed destructive SQL action, classify how catastrophic it is.
Respond with STRICT JSON only, no prose, in exactly this shape:
{"class": "benign" | "elevated" | "catastrophic", "blast_radius": <number 0..1>, "rationale": "<one short sentence>"}
- benign: a small, bounded change (well under 1% of the table).
- elevated: a large but plausibly-intended change.
- catastrophic: matches most or all of the table, or is clearly unbounded.
blast_radius is your estimate of the fraction of the target table affected.
Literal values in the statement are redacted as $1, $2, …; judge the structure.`;
}

export function buildUserPrompt(a: {
  target: string;
  predicateShape: string;
  matchingRows: number;
  totalRows: number;
  agentMedian: number;
}): string {
  return `Target table: ${a.target}
Total rows in table: ${a.totalRows}
Rows this action would delete (measured): ${a.matchingRows}
This agent's 30-day median rows/action: ${a.agentMedian}
Proposed statement (literals redacted):
DELETE FROM ${a.target} WHERE ${a.predicateShape}

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
    actionId: v.id("actions"),
    target: v.string(),
    matchingRows: v.number(),
    totalRows: v.number(),
    destructive: v.boolean(),
    agentMedian: v.number(),
  },
  handler: async (ctx, args): Promise<ClassifierVerdict> => {
    const heuristic = heuristicVerdict(args);

    const enabled = process.env.CLASSIFIER_ENABLED !== "false";
    const key = process.env.NEBIUS_API_KEY;
    if (!enabled || !key) return heuristic; // feature flag / no key → heuristic

    const base = process.env.NEBIUS_BASE_URL ?? "https://api.studio.nebius.com/v1/";
    const model = process.env.NEBIUS_CLASSIFIER_MODEL ?? "Qwen/Qwen3-30B-A3B-Instruct-2507";
    const timeoutMs = Number(process.env.CLASSIFIER_TIMEOUT_MS ?? 800);

    const exec = await ctx.runQuery(internal.core.actionShape, { actionId: args.actionId });
    if (!exec?.predicateShape) return heuristic; // no redacted shape → never send raw SQL
    const policy = await ctx.runQuery(internal.core.policyQuery, {});

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
            { role: "system", content: systemPrompt(policy.classifierDomain) },
            {
              role: "user",
              content: buildUserPrompt({ ...args, predicateShape: exec.predicateShape }),
            },
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
