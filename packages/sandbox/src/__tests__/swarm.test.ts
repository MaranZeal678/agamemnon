// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect } from "vitest";
import { SandboxSupervisor } from "../supervisor.ts";
import { FakeBridge, sandbox } from "./fakes.ts";

/**
 * Use case 4 — multi-agent swarms. Agents never share memory or context; the
 * only channel is the supervisor's IPC broker, which copies messages, labels
 * them untrusted, keeps them inside one tenant, and taints the recipient so
 * its later proposals carry that label into Agamemnon.
 */
describe("use case: zero-trust inter-agent IPC", () => {
  async function swarm() {
    const bridge = new FakeBridge();
    const sup = new SandboxSupervisor({ bridge });
    const research = await sup.spawnSandbox(sandbox(["AGENT_IPC"], { id: "research", tenantId: "acme" }));
    const coder = await sup.spawnSandbox(sandbox(["AGENT_IPC", "MUTATE_STATE"], { id: "coder", tenantId: "acme" }));
    return { bridge, sup, research, coder };
  }

  it("messages arrive as copies labelled untrusted, and the recipient's proposals carry the taint", async () => {
    const { bridge, sup, research, coder } = await swarm();
    await sup.executeInSandbox(research, `const finding = { file: "app.ts", fix: "bump timeout" }; await agents.send("coder", finding); finding.fix = "rm -rf"; return "sent";`, {});
    const r = await sup.executeInSandbox(
      coder,
      `const [m] = await agents.recv();
       await db.update("settings", { timeout: 30 }, { key: m.message.file });
       return m;`,
      {},
    );
    expect(r.data).toMatchObject({ from: "research", message: { file: "app.ts", fix: "bump timeout" }, labels: ["untrusted"] });
    expect(sup.status(coder).tainted).toBe(true);
    expect(bridge.writes[0].provenance).toEqual(["untrusted"]);
  });

  it("an agent cannot read another agent's memory or context", async () => {
    const { sup, research, coder } = await swarm();
    await sup.executeInSandbox(research, `globalThis.notes = "private chain of thought"; return null;`, { prompt: "research system prompt" });
    const r = await sup.executeInSandbox(coder, `return { notes: typeof notes, context };`, {});
    expect(r.data).toEqual({ notes: "undefined", context: {} });
    expect(sup.status(research).pendingMessages).toBe(0);
  });

  it("messages never cross tenants — another tenant's agent is indistinguishable from none", async () => {
    const { sup, research } = await swarm();
    await sup.spawnSandbox(sandbox(["AGENT_IPC"], { id: "globex-agent", tenantId: "globex" }));
    const r = await sup.executeInSandbox(
      research,
      `const out = [];
       for (const to of ["globex-agent", "does-not-exist"]) { try { await agents.send(to, "hi"); out.push("sent"); } catch (e) { out.push(e.message); } }
       return out;`,
      {},
    );
    expect(r.data).toEqual(["no such agent: globex-agent", "no such agent: does-not-exist"]);
    expect(sup.status("globex-agent").pendingMessages).toBe(0);
  });

  it("an untainted agent's proposals carry no untrusted label", async () => {
    const { bridge, sup, coder } = await swarm();
    await sup.executeInSandbox(coder, `await db.insert("notes", { body: "own idea" }); return null;`, {});
    expect(bridge.writes[0].provenance).toBeUndefined();
    expect(sup.status(coder).tainted).toBe(false);
  });
});
