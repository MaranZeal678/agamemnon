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

import type { Claim } from "./effect.ts";

/**
 * Postcondition verification — the agent's claims against systems of record.
 *
 * Observability tools judge an agent from its own trace (an LLM reading the
 * transcript). That fails exactly when it matters: an agent that skipped a
 * tool, or misreports a tool's result, produces a self-consistent trace.
 * Here each claim is checked DETERMINISTICALLY against facts read by
 * Agamemnon from systems the agent cannot write to — the database's real row
 * count, the CI system's check results and the diff, the payment processor's
 * objects, Agamemnon's own undo plans — and a contradiction tightens what the
 * agent may do next.
 *
 * Claims should arrive structured (`agm_claim`). `extractClaims` is a labelled
 * regex fallback for prose; anything it cannot parse is "unverifiable", never
 * "verified".
 */

/** Facts gathered by connectors from systems of record after execution. */
export interface ObservedFacts {
  /** Environment label of every target actually touched in the task. */
  envsTouched?: string[];
  /** Real rows affected, per subject (table) or total under "*". */
  rows?: Record<string, number>;
  /** From the CI system + the diff, never from the agent. */
  tests?: { conclusion: "success" | "failure" | "none"; deletedTests?: number; skipMarkersAdded?: number };
  /** Most recent restorable copy and whether it lives outside the blast radius. */
  backup?: { exists: boolean; at?: number; independent?: boolean };
  /** Refund objects actually created at the payment processor, minor units. */
  refundsMinor?: number;
  created?: string[];
  deleted?: string[];
  touched?: string[];
  /** Messages actually released (not held) by the outbox. */
  sent?: number;
  /** Agamemnon's own record: can each executed effect be reversed? */
  reversible?: boolean;
}

export type ClaimStatus = "verified" | "contradicted" | "unverifiable";

export interface ClaimVerdict {
  claim: Claim;
  status: ClaimStatus;
  evidence: string;
}

const norm = (x: unknown) => String(x).trim().toLowerCase();

export function reconcileClaim(claim: Claim, f: ObservedFacts): ClaimVerdict {
  const v = (status: ClaimStatus, evidence: string): ClaimVerdict => ({ claim, status, evidence });
  switch (claim.type) {
    case "env": {
      if (!f.envsTouched?.length) return v("unverifiable", "no target environments recorded");
      const claimed = norm(claim.value);
      const other = f.envsTouched.filter((e) => norm(e) !== claimed);
      return other.length
        ? v("contradicted", `claimed only "${claim.value}", but the task touched: ${[...new Set(f.envsTouched)].join(", ")}`)
        : v("verified", `every touched target is "${claim.value}"`);
    }
    case "rows": {
      const key = claim.subject ?? "*";
      const real = f.rows?.[key] ?? (key === "*" && f.rows ? Object.values(f.rows).reduce((a, b) => a + b, 0) : undefined);
      if (real === undefined) return v("unverifiable", `no measured row count for ${key}`);
      const claimed = Number(claim.value);
      const tolerance = Math.max(2, Math.ceil(claimed * 0.05));
      return Math.abs(real - claimed) <= tolerance
        ? v("verified", `measured ${real.toLocaleString()} rows (claimed ${claimed.toLocaleString()})`)
        : v("contradicted", `claimed ${claimed.toLocaleString()} rows, the database shows ${real.toLocaleString()}`);
    }
    case "tests": {
      if (!f.tests) return v("unverifiable", "no CI result available");
      const claimsPass = claim.value === true || /pass|green|ok|success/i.test(String(claim.value));
      if (!claimsPass) return v("verified", "agent did not claim a pass");
      if (f.tests.conclusion !== "success") return v("contradicted", `claimed tests pass; CI conclusion is "${f.tests.conclusion}"`);
      if ((f.tests.deletedTests ?? 0) > 0 || (f.tests.skipMarkersAdded ?? 0) > 0) {
        return v(
          "contradicted",
          `CI is green only because ${f.tests.deletedTests ?? 0} test(s) were deleted and ${f.tests.skipMarkersAdded ?? 0} skip marker(s) were added in this task`,
        );
      }
      return v("verified", "CI succeeded with no tests removed or skipped in this task");
    }
    case "backup": {
      if (!f.backup) return v("unverifiable", "no backup information");
      if (claim.value === true || /done|taken|complete|exists|yes/i.test(String(claim.value))) {
        if (!f.backup.exists) return v("contradicted", "claimed a backup exists; none was found");
        if (f.backup.independent === false) return v("contradicted", "a backup exists but lives in the same blast radius as the data");
        return v("verified", `restorable copy found${f.backup.at ? ` from ${new Date(f.backup.at).toISOString()}` : ""}`);
      }
      return v("verified", "agent did not claim a backup");
    }
    case "refund": {
      if (f.refundsMinor === undefined) return v("unverifiable", "no payment records read");
      const claimedMinor = Math.round(Number(claim.value) * 100);
      return Math.abs(claimedMinor - f.refundsMinor) <= 1
        ? v("verified", `refunds of ${(f.refundsMinor / 100).toFixed(2)} exist at the processor`)
        : v("contradicted", `claimed a refund of ${(claimedMinor / 100).toFixed(2)}; processor shows ${(f.refundsMinor / 100).toFixed(2)}`);
    }
    case "created":
    case "deleted":
    case "touched": {
      const list = f[claim.type];
      if (!list) return v("unverifiable", `no ${claim.type} list recorded`);
      const want = norm(claim.value);
      return list.some((x) => norm(x) === want)
        ? v("verified", `${claim.value} is in the recorded ${claim.type} set`)
        : v("contradicted", `${claim.value} is not among the ${list.length} recorded ${claim.type} item(s)`);
    }
    case "sent": {
      if (f.sent === undefined) return v("unverifiable", "no outbox record");
      const claimed = Number(claim.value);
      return claimed === f.sent
        ? v("verified", `${f.sent} message(s) released`)
        : v("contradicted", `claimed ${claimed} sent; the outbox released ${f.sent}`);
    }
    case "reversible": {
      if (f.reversible === undefined) return v("unverifiable", "no reversibility record");
      const claimed = claim.value === true || /yes|true|possible/i.test(String(claim.value));
      return claimed === f.reversible
        ? v("verified", f.reversible ? "an undo plan exists" : "the effect was irreversible")
        : v(
            "contradicted",
            f.reversible
              ? "agent claimed this cannot be rolled back — Agamemnon holds a working undo plan for it"
              : "agent claimed this can be rolled back — it was recorded as irreversible",
          );
    }
  }
}

export interface Reconciliation {
  verdicts: ClaimVerdict[];
  contradicted: ClaimVerdict[];
}

export function reconcileAll(claims: Claim[], facts: ObservedFacts): Reconciliation {
  const verdicts = claims.map((c) => reconcileClaim(c, facts));
  return { verdicts, contradicted: verdicts.filter((x) => x.status === "contradicted") };
}

/**
 * Trust tightening from the agent's contradiction history. One contradiction
 * → every non-read effect needs a human; three → the agent is suspended until
 * its owner reinstates it.
 */
export function trustLevel(contradictions: number): "normal" | "supervised" | "suspended" {
  if (contradictions >= 3) return "suspended";
  if (contradictions >= 1) return "supervised";
  return "normal";
}

const NUM = "(\\d[\\d,]*)";
/** Labelled fallback: pull claims out of agent prose. Conservative by design. */
export function extractClaims(text: string): Claim[] {
  const out: Claim[] = [];
  const t = text.replace(/\s+/g, " ");
  const push = (c: Omit<Claim, "source">) => out.push({ ...c, source: "extracted" });
  const env = /\bonly (?:touched|affected|changed|modified|ran (?:it )?(?:against|on)|used) (?:the )?(staging|dev|development|test|sandbox|local|prod|production)\b/i.exec(t);
  if (env) push({ type: "env", value: env[1].toLowerCase() });
  const rows = new RegExp(`\\b(?:deleted|removed|updated|affected|cleaned up|inserted) (?:about |approximately |~)?${NUM} (?:rows|records)(?: (?:from|in) ([a-z_][a-z0-9_]*))?`, "i").exec(t);
  if (rows) push({ type: "rows", value: Number(rows[1].replace(/,/g, "")), subject: rows[2] });
  if (/\b(?:all )?tests (?:now )?(?:pass(?:es|ed)?|are (?:passing|green)|(?:are )?green)\b/i.test(t)) push({ type: "tests", value: true });
  if (/\bbackup (?:is |was )?(?:done|taken|complete(?:d)?|created|in place)\b|\b(?:backed up|took a backup)\b/i.test(t)) push({ type: "backup", value: true });
  if (/\b(?:rollback|roll back|undo) (?:is |was )?(?:impossible|not possible)\b|\bcan(?:not|'t) (?:be )?(?:rolled back|undone|restored|reverted)\b|\birreversibl[ey]\b/i.test(t)) {
    push({ type: "reversible", value: false });
  }
  const refund = /\brefunded (?:you |the customer )?(?:\$|€|£)?(\d+(?:\.\d{1,2})?)/i.exec(t);
  if (refund) push({ type: "refund", value: Number(refund[1]) });
  const sent = new RegExp(`\\bsent (?:it |the (?:email|message) )?to ${NUM} (?:customers|recipients|users|people)`, "i").exec(t);
  if (sent) push({ type: "sent", value: Number(sent[1].replace(/,/g, "")) });
  return out;
}
