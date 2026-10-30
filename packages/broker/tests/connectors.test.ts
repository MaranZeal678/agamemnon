// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBroker, mockServer, P, sleep } from "./helpers.ts";
import { createServer, hashToken } from "../src/server.ts";

describe("fs connector — coding-agent file effects", () => {
  it("deleting a test file is oversight-reducing and needs two humans", async () => {
    const b = makeBroker();
    writeFileSync(join(b.dir, "workspace/tests/refund.test.ts"), "it('caps refunds', () => {})\n");
    const t = b.engine.startTask(P(b, "coder"), { goal: "make CI green" });
    const v = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "fs.delete", params: { path: "tests/refund.test.ts" } });
    expect(v.status).toBe("awaiting_approval");
    expect(v.requiredApprovals).toBe(2);
    expect(v.firedRules.map((r) => r.name)).toContain("oversight:test-deleted");
  });

  it("an agent granting itself auto-approval (CVE-2025-53773 class) is caught", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "coder"), {});
    const v = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "fs.write", params: { path: ".vscode/settings.json", content: '{\n  "chat.tools.autoApprove": true\n}\n' } });
    expect(v.firedRules.map((r) => r.name)).toEqual(expect.arrayContaining(["oversight:agent-config-changed", "oversight:agent-self-escalation"]));
  });

  it("ordinary edits run; revert restores the task's files and keeps a later human edit", async () => {
    const b = makeBroker();
    const ws = join(b.dir, "workspace");
    writeFileSync(join(ws, "a.txt"), "original A\n");
    writeFileSync(join(ws, "b.txt"), "original B\n");
    const t = b.engine.startTask(P(b, "coder"), {});
    for (const [path, content] of [["a.txt", "agent A\n"], ["b.txt", "agent B\n"], ["c.txt", "new file\n"]]) {
      const v = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "fs.write", params: { path, content } });
      expect(v.status).toBe("executed");
    }
    writeFileSync(join(ws, "b.txt"), "human fixed B\n"); // a person edits after the agent
    const r = await b.engine.revertTask(P(b, "alice"), t.id);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("original A\n");
    expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("human fixed B\n");
    expect(existsSync(join(ws, "c.txt"))).toBe(false);
    expect(r.summary[0].skipped).toBe(1);
  });

  it("refuses paths outside the workspace", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "coder"), {});
    const v = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "fs.write", params: { path: "../../etc/hosts", content: "x" } });
    expect(v.status).toBe("blocked");
    expect(v.firedRules[0].name).toBe("path-outside-workspace");
  });
});

describe("email outbox — irreversible becomes a cancellable hold; promises are checked", () => {
  it("holds, can be unsent inside the window, and releases after it", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "support-bot"), {});
    const send = (subject: string) => b.engine.propose(P(b, "support-bot"), { taskId: t.id, operation: "email.send", params: { to: ["jane@customer.example"], subject, body: "Your order shipped." } });
    const a = await send("first");
    expect(a.status).toBe("held");
    expect(a.reversibility).toBe("hold");
    await b.engine.cancelHold(P(b, "alice"), a.id);
    const out = join(b.dir, "outbox.jsonl");
    expect(existsSync(out)).toBe(false);
    const c = await send("second");
    expect(c.status).toBe("held");
    await sleep(400);
    expect(await b.engine.releaseDueHolds()).toBe(1);
    expect(b.engine.view(c.id).status).toBe("executed");
    expect(readFileSync(out, "utf8")).toContain("second");
  });

  it("a refund promise above the agent's authority and a policy statement both need a human", async () => {
    const b = makeBroker();
    const t = b.engine.startTask(P(b, "support-bot"), {});
    const v = await b.engine.propose(P(b, "support-bot"), {
      taskId: t.id,
      operation: "email.send",
      params: { to: ["jane@customer.example"], subject: "Sorry", body: "I've refunded you $150. Our policy allows only one device per subscription." },
    });
    expect(v.status).toBe("awaiting_approval");
    expect(v.firedRules.map((r) => r.name)).toEqual(expect.arrayContaining(["promise-exceeds-authority", "policy-promise"]));
  });
});

describe("GitHub connector (mock API)", () => {
  it("CI failure masking is oversight; a deploy key becomes a task-scoped artifact revoked at task end", async () => {
    const files: Record<string, { sha: string; content: string }> = {
      ".github/workflows/ci.yml": { sha: "sha1", content: Buffer.from("jobs:\n  test:\n    steps:\n      - run: npm test\n").toString("base64") },
    };
    const gh = await mockServer(({ method, path }) => {
      const m = /^\/repos\/acme\/app\/contents\/(.+?)(\?|$)/.exec(path);
      if (method === "GET" && m) return files[decodeURIComponent(m[1])] ? { body: { ...files[decodeURIComponent(m[1])], encoding: "base64" } } : undefined;
      if (method === "PUT" && m) return { body: { content: { sha: "sha2" }, commit: { sha: "c0ffee" } } };
      if (method === "POST" && path === "/repos/acme/app/keys") return { status: 201, body: { id: 77 } };
      if (method === "DELETE" && path === "/repos/acme/app/keys/77") return { status: 204, body: {} };
      if (method === "GET" && path === "/repos/acme/app") return { body: { private: true, default_branch: "main" } };
      return undefined;
    });
    try {
      const b = makeBroker();
      b.vault.put("github/token", "ghp_test_token_not_real");
      b.store.upsertTarget({ system: "github", resource: "account:default", env: "prod", config: { apiBase: gh.url, secret: "github/token", repos: ["acme/app"] } });
      const t = b.engine.startTask(P(b, "coder"), {});
      const ci = await b.engine.propose(P(b, "coder"), {
        taskId: t.id,
        operation: "github.contents.write",
        params: { repo: "acme/app", branch: "main", path: ".github/workflows/ci.yml", content: "jobs:\n  test:\n    steps:\n      - run: npm test || true\n        continue-on-error: true\n" },
      });
      expect(ci.status).toBe("awaiting_approval");
      expect(ci.requiredApprovals).toBe(2);
      expect(ci.firedRules.map((r) => r.name)).toEqual(expect.arrayContaining(["oversight:ci-continue-on-error", "oversight:ci-failure-masked"]));

      const key = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "github.deploy_key.create", params: { repo: "acme/app", title: "ci", key: "ssh-ed25519 AAAA test", read_only: true } });
      expect(key.status).toBe("awaiting_approval"); // creates durable access
      const done = await b.engine.decide(P(b, "alice"), key.id, "approve");
      expect(done.status).toBe("executed");
      expect(b.store.artifacts()[0]).toMatchObject({ kind: "deploy_key", durableAccess: true });
      const end = await b.engine.endTask(P(b, "coder"), t.id);
      expect(end.revoked).toBe(1);
      expect(gh.calls.some((c) => c.method === "DELETE" && c.path === "/repos/acme/app/keys/77")).toBe(true);
    } finally {
      await gh.close();
    }
  });
});

describe("Stripe connector (mock API) — money an agent issues", () => {
  it("a refund is held, released after the window, and the 'I refunded you' claim verifies", async () => {
    let refunded = 0;
    const stripe = await mockServer(({ method, path, body }) => {
      if (method === "GET" && path === "/v1/payment_intents/pi_123") return { body: { id: "pi_123", amount: 5000, amount_received: 5000, amount_refunded: refunded, currency: "usd", customer: "cus_1" } };
      if (method === "POST" && path === "/v1/refunds") {
        refunded += Number(body.amount);
        return { body: { id: "re_1", amount: Number(body.amount) } };
      }
      return undefined;
    });
    try {
      const b = makeBroker();
      b.vault.put("stripe/key", "sk_test_not_real");
      b.store.upsertTarget({ system: "stripe", resource: "account:default", env: "prod", config: { apiBase: stripe.url, secret: "stripe/key", maxRefundMinor: 10000 } });
      const t = b.engine.startTask(P(b, "support-bot"), {});
      const v = await b.engine.propose(P(b, "support-bot"), { taskId: t.id, operation: "stripe.refund.create", params: { payment_intent: "pi_123", amount: 2500 } });
      expect(v.status).toBe("held");
      await sleep(400);
      await b.engine.releaseDueHolds();
      expect(b.engine.view(v.id).status).toBe("executed");
      expect(refunded).toBe(2500);
      const rec = await b.engine.claim(P(b, "support-bot"), t.id, [], "I've refunded you $25.00 — sorry for the trouble.");
      expect(rec.verdicts[0].status).toBe("verified");
      const lie = await b.engine.claim(P(b, "support-bot"), t.id, [{ type: "refund", value: 50 }]);
      expect(lie.contradicted).toHaveLength(1);
    } finally {
      await stripe.close();
    }
  });

  it("refunding more than was charged is blocked", async () => {
    const stripe = await mockServer(({ path }) => (path === "/v1/payment_intents/pi_9" ? { body: { id: "pi_9", amount_received: 1000, amount_refunded: 0 } } : undefined));
    try {
      const b = makeBroker();
      b.vault.put("stripe/key", "sk_test_not_real");
      b.store.upsertTarget({ system: "stripe", resource: "account:default", env: "prod", config: { apiBase: stripe.url, secret: "stripe/key" } });
      const t = b.engine.startTask(P(b, "support-bot"), {});
      const v = await b.engine.propose(P(b, "support-bot"), { taskId: t.id, operation: "stripe.refund.create", params: { payment_intent: "pi_9", amount: 5000 } });
      expect(v.status).toBe("blocked");
    } finally {
      await stripe.close();
    }
  });
});

describe("Terraform connector — plan JSON", () => {
  const plan = (changes: any[]) => ({ format_version: "1.2", resource_changes: changes });
  const rc = (type: string, name: string, actions: string[], before: any = {}, after: any = {}) => ({ address: `${type}.${name}`, mode: "managed", type, name, change: { actions, before, after } });

  it("refuses destroying a database together with its backups (PocketOS / DataTalks class)", async () => {
    const b = makeBroker();
    b.store.upsertTarget({ system: "terraform", resource: "workspace:prod", env: "prod", config: { lineage: "lin-prod-1" } });
    const t = b.engine.startTask(P(b, "coder"), {});
    const v = await b.engine.propose(P(b, "coder"), {
      taskId: t.id,
      operation: "terraform.apply",
      params: { workspace: "prod", stateLineage: "lin-prod-1", planJson: plan([rc("aws_db_instance", "main", ["delete"], { skip_final_snapshot: true }), rc("aws_db_snapshot", "nightly", ["delete"])]) },
    });
    expect(v.status).toBe("blocked");
    expect(v.firedRules.map((r) => r.name)).toContain("destroys-data-and-backups");
    expect(v.reversibility).toBe("irreversible");
  });

  it("refuses a plan made against a different state lineage (stale / wrong state file)", async () => {
    const b = makeBroker();
    b.store.upsertTarget({ system: "terraform", resource: "workspace:prod", env: "prod", config: { lineage: "lin-prod-1" } });
    const t = b.engine.startTask(P(b, "coder"), {});
    const v = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "terraform.apply", params: { workspace: "prod", stateLineage: "lin-OLD", planJson: plan([rc("aws_instance", "web", ["update"])]) } });
    expect(v.status).toBe("blocked");
    expect(v.firedRules.map((r) => r.name)).toContain("target-fingerprint-mismatch");
  });

  it("disabling GuardDuty in a plan is oversight-reducing", async () => {
    const b = makeBroker();
    b.store.upsertTarget({ system: "terraform", resource: "workspace:prod", env: "prod", config: { lineage: "lin-prod-1" } });
    const t = b.engine.startTask(P(b, "coder"), {});
    const v = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "terraform.apply", params: { workspace: "prod", stateLineage: "lin-prod-1", planJson: plan([rc("aws_guardduty_detector", "main", ["update"], { enable: true }, { enable: false })]) } });
    expect(v.requiredApprovals).toBe(2);
    expect(v.firedRules.map((r) => r.name)).toContain("oversight:threat-detection-disabled");
  });
});

describe("monitoring connector (mock Datadog)", () => {
  it("muting a monitor is oversight; reversal unmutes it", async () => {
    const dd = await mockServer(({ method, path }) => (method === "POST" && /\/api\/v1\/monitor\/42\/(mute|unmute)/.test(path) ? { body: { id: 42 } } : undefined));
    try {
      const b = makeBroker();
      b.vault.put("datadog/keys", "api:app");
      b.store.upsertTarget({ system: "monitoring", resource: "account:datadog", env: "prod", config: { provider: "datadog", apiBase: dd.url, secret: "datadog/keys" } });
      const t = b.engine.startTask(P(b, "coder"), {});
      const v = await b.engine.propose(P(b, "coder"), { taskId: t.id, operation: "monitoring.datadog.mute", params: { monitorId: "42" } });
      expect(v.firedRules.map((r) => r.name)).toEqual(expect.arrayContaining(["oversight:alerts-muted", "indefinite-silence"]));
      await b.engine.decide(P(b, "alice"), v.id, "approve");
      const done = await b.engine.decide(P(b, "bob"), v.id, "approve");
      expect(done.status).toBe("executed");
      await b.engine.undoEffect(P(b, "alice"), v.id);
      expect(dd.calls.some((c) => c.path.endsWith("/unmute"))).toBe(true);
    } finally {
      await dd.close();
    }
  });
});

describe("HTTP API — principals and separation of roles", () => {
  it("agents propose, operators approve, nobody crosses over; hooks report intent", async () => {
    const b = makeBroker();
    b.store.upsertPrincipal({ name: "coder", kind: "agent", owner: "maran", tokenHash: hashToken("agent-tok") });
    b.store.upsertPrincipal({ name: "alice", kind: "human", role: "approver", tokenHash: hashToken("alice-tok") });
    const server = createServer(b.engine, {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const call = (path: string, token: string, body?: unknown) =>
      fetch(base + path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
    try {
      expect((await call("/v1/whoami", "")).status).toBe(401);
      const task = await call("/v1/tasks", "agent-tok", { goal: "x" });
      expect(task.status).toBe(200);
      expect((await call("/v1/tasks", "alice-tok", { goal: "x" })).status).toBe(403);
      writeFileSync(join(b.dir, "workspace/tests/x.test.ts"), "it('x', () => {})\n");
      const eff = await call("/v1/effects", "agent-tok", { taskId: task.body.taskId, operation: "fs.delete", params: { path: "tests/x.test.ts" } });
      expect(eff.body.status).toBe("awaiting_approval");
      expect((await call(`/v1/effects/${eff.body.id}/approve`, "agent-tok", {})).status).toBe(403);
      expect((await call(`/v1/effects/${eff.body.id}/approve`, "alice-tok", {})).body.approvalState).toBe("pending"); // needs two
      const hook = await call("/v1/hooks/intent", "agent-tok", { tool: "Bash", command: "terraform destroy -auto-approve" });
      expect(hook.body.verdict).toBe("deny");
      const state = await call("/v1/console/state", "alice-tok");
      expect(state.body.chain.ok).toBe(true);
      expect((await call("/v1/console/state", "agent-tok")).status).toBe(403);
      expect((await fetch(base + "/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
