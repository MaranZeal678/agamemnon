// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import {
  admit,
  bindEffect,
  checkBinding,
  effectHash,
  classifyOversight,
  reconcileAll,
  reconcileClaim,
  extractClaims,
  trustLevel,
  checkBudgets,
  acquireLease,
  checkReadVersion,
  absorbTaint,
  CLEAN_TAINT,
  lethalTrifecta,
  priorDenial,
  fidelityScore,
  connectorFidelity,
  planRevert,
  dependents,
  artifactsToRevoke,
  staleArtifacts,
  buildReceipt,
  signReceipt,
  verifyReceipts,
  requestFingerprint,
  type Effect,
  type LedgerEntry,
  type ReceiptSigner,
} from "../src/index.ts";

const NOW = 1_800_000_000_000;

function effect(over: Partial<Effect> = {}, req: Partial<Effect["request"]> = {}): Effect {
  return {
    request: {
      id: "e1",
      taskId: "t1",
      operation: "postgres.delete",
      target: { system: "postgres", resource: "loads", env: "prod" },
      params: { predicate: "status = $1" },
      requester: { kind: "agent", id: "cleanup-bot" },
      delegation: { rootOwner: "maran", chain: [{ kind: "human", id: "maran" }, { kind: "agent", id: "cleanup-bot" }] },
      createdAt: NOW,
      ...req,
    },
    reversibility: "undo",
    preview: { summary: "delete 40 rows", counts: { rows: 40 }, fidelity: "exact" },
    precondition: "rowset:abc",
    oversight: [],
    creates: [],
    egress: false,
    reads: ["postgres:loads"],
    writes: ["postgres:loads"],
    ...over,
  };
}

describe("effect binding — approve exactly what was measured", () => {
  it("passes when nothing changed", () => {
    const e = effect();
    const b = bindEffect(e, NOW);
    expect(checkBinding(b, effect(), NOW + 1000)).toEqual({ ok: true });
  });
  it("refuses when the target drifted (precondition)", () => {
    const b = bindEffect(effect(), NOW);
    const r = checkBinding(b, effect({ precondition: "rowset:changed" }), NOW + 1000);
    expect(r.ok).toBe(false);
  });
  it("refuses when the effect grew (approved 3 rows, would delete 3 million)", () => {
    const b = bindEffect(effect({ preview: { summary: "", counts: { rows: 3 }, fidelity: "exact" } }), NOW);
    const r = checkBinding(b, effect({ preview: { summary: "", counts: { rows: 3_000_000 }, fidelity: "exact" } }), NOW + 1);
    expect(r).toMatchObject({ ok: false });
  });
  it("refuses after expiry and when tampered", () => {
    const b = bindEffect(effect(), NOW, 1000);
    expect(checkBinding(b, effect(), NOW + 5000).ok).toBe(false);
    expect(checkBinding({ ...b, expiresAt: b.expiresAt + 10_000_000 }, effect(), NOW + 5000).ok).toBe(false);
  });
  it("hash ignores presentation-only fields like the sample", () => {
    expect(effectHash(effect())).toBe(effectHash(effect({ preview: { summary: "other words", counts: { rows: 40 }, fidelity: "exact", sample: [1] } })));
  });
});

describe("admission by reversibility", () => {
  it("allows a small undoable effect", () => {
    const r = admit(effect(), { now: NOW });
    expect(r.decision).toBe("allow");
    expect(r.tier).toBe("T1");
  });
  it("escalates an irreversible effect to TWO approvers", () => {
    const r = admit(effect({ reversibility: "irreversible" }), { now: NOW });
    expect(r.decision).toBe("approval");
    expect(r.requiredApprovals).toBe(2);
  });
  it("converts an irreversible effect into a hold when the connector can defer", () => {
    const r = admit(effect({ reversibility: "irreversible", egress: true, writes: [] }), { now: NOW, canDefer: true });
    expect(r.convertToHold).toBe(true);
    expect(r.reversibility).toBe("hold");
    expect(r.decision).toBe("allow");
  });
  it("blocks anything that would destroy the data and its backups", () => {
    const r = admit(effect({ destroysBackups: true }), { now: NOW });
    expect(r.decision).toBe("block");
    expect(r.firedRules.map((f) => f.name)).toContain("destroys-data-and-backups");
  });
  it("requires approval for estimated previews on writes that cannot be undone", () => {
    const r = admit(effect({ reversibility: "compensate", preview: { summary: "", counts: { records: 10 }, fidelity: "estimated" } }), { now: NOW });
    expect(r.firedRules.map((f) => f.name)).toContain("estimated-preview");
  });
  it("treats a connector with poor rolling fidelity as estimated", () => {
    const r = admit(effect({ reversibility: "compensate" }), { now: NOW, connectorFidelityTrusted: false });
    expect(r.decision).toBe("approval");
  });
  it("shadow mode enforces nothing but records what would happen", () => {
    const r = admit(effect({ destroysBackups: true }), { now: NOW, mode: "shadow" });
    expect(r.decision).toBe("allow");
    expect(r.wouldDecision).toBe("block");
  });
});

describe("declared intent — the 1,200 vs 412,000 case", () => {
  it("blocks when the measured effect dwarfs what the agent expected", () => {
    const e = effect({ preview: { summary: "", counts: { rows: 412000 }, fidelity: "exact" } }, { declared: { expectedCount: 1200 } });
    const r = admit(e, { now: NOW });
    expect(r.decision).toBe("block");
    expect(r.firedRules.find((f) => f.name === "intent-mismatch")?.detail).toMatch(/343\.3×/);
  });
  it("blocks when the declared environment differs from the target's registered one", () => {
    const r = admit(effect({}, { declared: { env: "staging" } }), { now: NOW });
    expect(r.firedRules.map((f) => f.name)).toContain("environment-mismatch");
    expect(r.decision).toBe("block");
  });
});

describe("oversight-integrity class", () => {
  const rules = (d: Parameters<typeof classifyOversight>[0]) => classifyOversight(d).map((f) => f.rule);
  it("flags deleting a test file", () => {
    expect(rules({ system: "fs", operation: "delete", resource: "src/billing/__tests__/refund.test.ts" })).toContain("test-deleted");
    expect(rules({ system: "fs", operation: "delete", resource: "pkg/pay/pay_test.go" })).toContain("test-deleted");
  });
  it("flags skip markers and removed test cases", () => {
    const r = rules({ system: "fs", operation: "write", resource: "tests/test_refunds.py", diff: "+@pytest.mark.skip(reason='flaky')\n-def test_refund_limit():\n-    assert x" });
    expect(r).toContain("test-skipped");
    expect(r).toContain("tests-removed");
    expect(rules({ system: "fs", operation: "write", resource: "a.spec.ts", before: "it('x', ()=>{})", after: "it.skip('x', ()=>{})" })).toContain("test-skipped");
  });
  it("flags CI failure masking", () => {
    const r = rules({ system: "fs", operation: "write", resource: ".github/workflows/ci.yml", diff: "+        continue-on-error: true\n+      - run: npm test || true" });
    expect(r).toEqual(expect.arrayContaining(["ci-continue-on-error", "ci-failure-masked", "ci-pipeline-changed"]));
  });
  it("flags an agent granting itself auto-approval (CVE-2025-53773)", () => {
    const r = rules({ system: "fs", operation: "write", resource: ".vscode/settings.json", diff: '+  "chat.tools.autoApprove": true' });
    expect(r).toEqual(expect.arrayContaining(["agent-config-changed", "agent-self-escalation"]));
    expect(rules({ system: "fs", operation: "write", resource: ".claude/settings.json", diff: '+ "defaultMode": "bypassPermissions"' })).toContain("agent-self-escalation");
  });
  it("flags cloud audit / detection being switched off", () => {
    expect(rules({ system: "aws", operation: "api", resource: "cloudtrail:StopLogging" })).toContain("audit-trail-weakened");
    expect(rules({ system: "terraform", operation: "apply", params: { resourceType: "aws_guardduty_detector", actions: ["update"], after: { enable: false } } })).toContain("threat-detection-disabled");
    expect(rules({ system: "terraform", operation: "apply", params: { resourceType: "aws_cloudwatch_log_group", actions: ["update"], before: { retention_in_days: 365 }, after: { retention_in_days: 1 } } })).toContain("logs-reduced");
  });
  it("flags database guardrails and audit tables", () => {
    expect(rules({ system: "postgres", operation: "sql", statement: "ALTER TABLE invoices DISABLE ROW LEVEL SECURITY" })).toContain("db-guardrail-disabled");
    expect(rules({ system: "postgres", operation: "sql", statement: "DELETE FROM audit_events WHERE at < now()" })).toContain("audit-data-modified");
  });
  it("flags muted alerts and branch protection removal", () => {
    expect(rules({ system: "monitoring", operation: "api", params: { provider: "datadog", call: "mute monitor 123" } })).toContain("alerts-muted");
    expect(rules({ system: "github", operation: "api", params: { call: "DELETE branch_protection main" } })).toContain("branch-protection-removed");
  });
  it("does not flag ordinary edits", () => {
    expect(rules({ system: "fs", operation: "write", resource: "src/app.ts", diff: "+const x = 1;" })).toEqual([]);
  });
  it("forces two human approvers, and a learned allow rule cannot relax it", () => {
    const e = effect({ oversight: [{ rule: "test-deleted", detail: "x" }], preview: { summary: "", counts: { files: 1 }, fidelity: "exact" } });
    const r = admit(e, { now: NOW, learnedAllow: true });
    expect(r.decision).toBe("approval");
    expect(r.requiredApprovals).toBe(2);
    expect(r.firedRules.map((f) => f.name)).not.toContain("learned-allow");
  });
});

describe("claim reconciliation against systems of record", () => {
  it("'tests pass' is contradicted when the task deleted tests", () => {
    const v = reconcileClaim({ type: "tests", value: true }, { tests: { conclusion: "success", deletedTests: 12 } });
    expect(v.status).toBe("contradicted");
    expect(v.evidence).toMatch(/12 test/);
  });
  it("'only touched staging' is contradicted by a prod target", () => {
    expect(reconcileClaim({ type: "env", value: "staging" }, { envsTouched: ["staging", "prod"] }).status).toBe("contradicted");
    expect(reconcileClaim({ type: "env", value: "staging" }, { envsTouched: ["staging"] }).status).toBe("verified");
  });
  it("'rollback is impossible' is contradicted by Agamemnon's own undo plan (the Replit case)", () => {
    const v = reconcileClaim({ type: "reversible", value: false }, { reversible: true });
    expect(v.status).toBe("contradicted");
  });
  it("rows, refunds, sends and missing evidence", () => {
    expect(reconcileClaim({ type: "rows", value: 1200, subject: "loads" }, { rows: { loads: 412000 } }).status).toBe("contradicted");
    expect(reconcileClaim({ type: "refund", value: 50 }, { refundsMinor: 5000 }).status).toBe("verified");
    expect(reconcileClaim({ type: "sent", value: 10 }, { sent: 4000 }).status).toBe("contradicted");
    expect(reconcileClaim({ type: "backup", value: true }, {}).status).toBe("unverifiable");
  });
  it("extracts claims from prose (labelled as extracted)", () => {
    const c = extractClaims("Done! I only touched staging, deleted 1,200 rows from loads, all tests pass. Rollback is impossible though.");
    expect(c.map((x) => x.type).sort()).toEqual(["env", "reversible", "rows", "tests"]);
    expect(c.every((x) => x.source === "extracted")).toBe(true);
    const r = reconcileAll(c, { envsTouched: ["prod"], rows: { loads: 412000 }, tests: { conclusion: "success", skipMarkersAdded: 3 }, reversible: true });
    expect(r.contradicted).toHaveLength(4);
  });
  it("contradictions tighten trust", () => {
    expect(trustLevel(0)).toBe("normal");
    expect(trustLevel(1)).toBe("supervised");
    expect(trustLevel(3)).toBe("suspended");
    expect(admit(effect(), { now: NOW, trust: "supervised" }).decision).toBe("approval");
    expect(admit(effect(), { now: NOW, trust: "suspended" }).decision).toBe("block");
  });
});

describe("fleet controls", () => {
  const entry = (agent: string, rows: number, at = NOW - 1000): LedgerEntry => ({
    at, rootOwner: "maran", agent, taskId: `task-${agent}`, object: "postgres:loads", rows, resources: 0, amountMinor: 0,
  });
  it("owner budget trips across three agents that each look harmless", () => {
    const ledger = [entry("a", 7000), entry("b", 7000)];
    const f = checkBudgets(ledger, { rootOwner: "maran", agent: "c", taskId: "t3", object: "postgres:loads", rows: 7000, resources: 0, amountMinor: 0 }, NOW);
    expect(f.map((x) => x.rule)).toContain("owner-row-budget");
    expect(f[0].detail).toMatch(/3 agent/);
    const r = admit(effect({ preview: { summary: "", counts: { rows: 7000 }, fidelity: "exact" } }, { requester: { kind: "agent", id: "c" } }), { now: NOW, ledger, budgets: { windowMs: 3600_000, ownerRows: 20000, ownerResources: 25, ownerAmountMinor: 50000, objectRows: 50000, ownerEffectsPerMinute: 60 } });
    expect(r.decision).toBe("block");
  });
  it("runaway-loop breaker", () => {
    const ledger = Array.from({ length: 60 }, (_, i) => entry("loop", 1, NOW - i * 500));
    const f = checkBudgets(ledger, { rootOwner: "maran", agent: "loop", taskId: "t", object: "postgres:loads", rows: 1, resources: 0, amountMinor: 0 }, NOW);
    expect(f.map((x) => x.rule)).toContain("runaway-loop");
  });
  it("leases serialise concurrent writers; stale reads are rejected", () => {
    const a = acquireLease([], "postgres:loads", "task-A", NOW);
    expect(a.ok).toBe(true);
    const held = a.ok ? [a.lease] : [];
    expect(acquireLease(held, "postgres:loads:pk=5", "task-B", NOW).ok).toBe(false);
    expect(acquireLease(held, "postgres:bookings", "task-B", NOW).ok).toBe(true);
    expect(acquireLease(held, "postgres:loads", "task-B", NOW + 10 * 60 * 1000).ok).toBe(true); // expired
    const r = admit(effect({}, { taskId: "task-B" }), { now: NOW, leases: held });
    expect(r.firedRules.map((f) => f.name)).toContain("resource-leased");
    expect(checkReadVersion("v1", "v2").ok).toBe(false);
    expect(admit(effect(), { now: NOW, readVersion: checkReadVersion("v1", "v2") }).decision).toBe("block");
  });
  it("lethal trifecta escalates an outbound effect after an untrusted read", () => {
    let t = absorbTaint(CLEAN_TAINT, { labels: ["untrusted"], source: "support-ticket#4711" });
    expect(lethalTrifecta(t, true).fires).toBe(false); // no private data yet
    t = absorbTaint(t, { private: true });
    expect(lethalTrifecta(t, true).fires).toBe(true);
    const r = admit(effect({ egress: true, reversibility: "hold", writes: [] }), { now: NOW, taint: t });
    expect(r.decision).toBe("approval");
    expect(r.firedRules.find((f) => f.name === "lethal-trifecta")?.detail).toMatch(/support-ticket#4711/);
  });
  it("a denial carries over to a sub-agent in the same task", () => {
    const fp = requestFingerprint({ operation: "postgres.delete", target: { system: "postgres", resource: "loads" }, params: { predicate: "x" } }, "status = $1");
    const denials = [{ fingerprint: fp, taskId: "t1", rootOwner: "maran", at: NOW - 1000, reason: "too broad" }];
    expect(priorDenial(denials, fp, "t1", "maran", NOW)).toBeDefined();
    const r = admit(effect({}, { requester: { kind: "agent", id: "sub-agent-7" } }), { now: NOW, denials, fingerprint: fp });
    expect(r.decision).toBe("block");
  });
  it("durable access is approved once and revoked at task end", () => {
    const r = admit(effect({ creates: [{ kind: "api_key", id: "key_1", system: "stripe", durableAccess: true }] }), { now: NOW });
    expect(r.firedRules.map((f) => f.name)).toContain("creates-durable-access");
    const arts = [
      { id: "key_1", kind: "api_key", system: "stripe", taskId: "t1", createdAt: NOW, durableAccess: true },
      { id: "wh_2", kind: "webhook", system: "github", taskId: "t1", createdAt: NOW, durableAccess: true, promotedBy: "alice" },
      { id: "br_3", kind: "branch", system: "github", taskId: "t1", createdAt: NOW, durableAccess: false },
    ];
    expect(artifactsToRevoke(arts, "t1").map((a) => a.id)).toEqual(["key_1"]);
    expect(staleArtifacts(arts, NOW + 2 * 24 * 3600 * 1000).map((a) => a.id)).toEqual(["key_1"]);
  });
  it("preview fidelity", () => {
    expect(fidelityScore({ rows: 900 }, { rows: 900 })).toBe(1);
    expect(fidelityScore({ rows: 100 }, { rows: 200 })).toBeCloseTo(0.5);
    expect(connectorFidelity([1, 1, 0.5]).trusted).toBe(false);
  });
});

describe("selective revert (Aire lineage) — later human edits survive", () => {
  const writes = [
    { effectId: "e1", taskId: "t1", at: 1, key: "loads:1", before: { id: 1, v: "a" }, afterHash: null }, // deleted
    { effectId: "e1", taskId: "t1", at: 1, key: "loads:2", before: { id: 2, v: "b" }, afterHash: "h2" }, // updated
    { effectId: "e2", taskId: "t1", at: 2, key: "loads:3", before: { id: 3, v: "c" }, afterHash: "h3" }, // updated, then a human edits
    { effectId: "e2", taskId: "t1", at: 2, key: "loads:9", before: null, afterHash: "h9" }, // inserted
    { effectId: "e9", taskId: "t2", at: 3, key: "loads:4", before: { id: 4 }, afterHash: "h4" }, // another task
  ];
  const current: Record<string, string | null> = { "loads:1": null, "loads:2": "h2", "loads:3": "h3-human-edit", "loads:9": "h9", "loads:4": "h4" };
  it("restores only rows still exactly as the task left them", () => {
    const plan = planRevert(writes, "t1", (k) => current[k] ?? null);
    expect(plan.restore.map((r) => [r.key, r.action])).toEqual([
      ["loads:1", "reinsert"],
      ["loads:2", "overwrite"],
      ["loads:9", "delete"],
    ]);
    expect(plan.skip).toEqual([{ key: "loads:3", reason: expect.stringMatching(/later edit preserved/) }]);
  });
  it("finds effects that depended on a write", () => {
    const deps = dependents(
      [
        { id: "A", at: 1, reads: [], writes: ["postgres:loads"] },
        { id: "B", at: 2, reads: ["postgres:loads:pk=3"], writes: ["email:outbox"] },
        { id: "C", at: 3, reads: ["email:outbox"], writes: [] },
        { id: "D", at: 4, reads: ["postgres:bookings"], writes: [] },
      ],
      "A",
    );
    expect(deps.map((d) => d.id)).toEqual(["B", "C"]);
  });
});

describe("signed receipts", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const signer: ReceiptSigner = { alg: "ed25519", publicKey: pub, sign: (p) => sign(null, Buffer.from(p), privateKey).toString("base64") };
  const v = (p: string, s: string, k: string) =>
    verify(null, Buffer.from(p), createPublicKey({ key: Buffer.from(k, "base64"), format: "der", type: "spki" }), Buffer.from(s, "base64"));
  const base = {
    receiptId: "r1", effectId: "e1", taskId: "t1", operation: "postgres.delete", target: { system: "postgres", resource: "loads" },
    delegation: { rootOwner: "maran", chain: [] }, decision: "approval" as const, firedRules: ["destructive-over-100"],
    approvedEffectHash: "abc", bindingHash: "def", approvers: [{ id: "alice", at: NOW }], reversibility: "undo",
    observed: { counts: { rows: 900 }, outcome: "executed" as const }, verification: { fidelity: 1, claims: [] }, issuedAt: NOW,
  };
  it("signs, chains and verifies; detects tampering", () => {
    const r1 = signReceipt(buildReceipt(base), signer);
    const r2 = signReceipt(buildReceipt({ ...base, receiptId: "r2" }, r1.hash), signer);
    expect(verifyReceipts([r1, r2], v).ok).toBe(true);
    const forged = { ...r2, receipt: { ...r2.receipt, approvers: [{ id: "mallory", at: NOW }] } };
    expect(verifyReceipts([r1, forged], v).ok).toBe(false);
    expect(verifyReceipts([r2], v).ok).toBe(false); // missing predecessor
  });
});

describe("rule levels apply to connector-evaluated rules too", () => {
  it("monitor softens a connector rule to a recorded no-op", () => {
    const e = effect();
    const r = admit(e, { now: NOW, connectorRules: [{ name: "destructive-over-100", severity: "approval", detail: "x" }], levels: { "destructive-over-100": "monitor" } });
    expect(r.decision).toBe("allow");
    expect(r.firedRules[0].level).toBe("monitor");
  });
});
