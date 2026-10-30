// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect, afterEach } from "vitest";
import type http from "node:http";
import { createSandboxServer, type Caller } from "../server.ts";
import { SandboxClient, SandboxApiError } from "../client.ts";
import { SandboxSupervisor } from "../supervisor.ts";
import { FakeBridge } from "./fakes.ts";

const PEOPLE: Record<string, Caller> = {
  "tok-coder": { name: "coder", kind: "agent" },
  "tok-other": { name: "other-bot", kind: "agent" },
  "tok-dana": { name: "dana", kind: "human", role: "approver" },
  "tok-audrey": { name: "audrey", kind: "human", role: "auditor" },
};

let server: http.Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(opts: { allowTenant?: (c: Caller, t: string) => boolean; maxPerOwner?: number } = {}) {
  const bridge = new FakeBridge();
  const supervisor = new SandboxSupervisor({ bridge });
  server = createSandboxServer({ supervisor, authenticate: (t) => PEOPLE[t] ?? null, ...opts });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server!.address() as any).port}`;
  const as = (token: string) => new SandboxClient({ url, token });
  return { bridge, supervisor, url, as };
}

const spec = { tenantId: "bloom-botanicals", grants: ["READ_ONLY" as const], maxMemoryMb: 32, timeoutMs: 2000 };

describe("sandbox REST server — the only way to a sandbox", () => {
  it("refuses requests without a valid token", async () => {
    const { url, as } = await start();
    expect((await fetch(`${url}/v1/sandboxes`)).status).toBe(401);
    await expect(as("nope").list()).rejects.toMatchObject({ status: 401 });
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
  });

  it("an agent creates a sandbox that acts as itself; the owner cannot be spoofed", async () => {
    const { url, bridge } = await start();
    const r = await fetch(`${url}/v1/sandboxes`, { method: "POST", headers: { authorization: "Bearer tok-coder", "content-type": "application/json" }, body: JSON.stringify({ ...spec, owner: "dana", capabilities: { grants: [], maxMemoryMb: 32, timeoutMs: 2000 } }) });
    expect(r.status).toBe(201);
    const info = await r.json();
    expect(info.owner).toBe("coder");
    expect(bridge.attached.get(info.id)).toBe("bloom-botanicals");
  });

  it("runs code for the owner, through capabilities and the broker", async () => {
    const { as, bridge } = await start();
    bridge.rows = [{ id: 1 }, { id: 2 }];
    const sbx = await as("tok-coder").create(spec);
    const r = await sbx.run(`const rows = await db.select("orders"); return rows.length;`);
    expect(r).toMatchObject({ success: true, data: 2 });
    const bad = await sbx.run(`await db.insert("orders", { x: 1 });`);
    expect(bad.killed).toMatch(/MUTATE_STATE not granted/);
    expect((await sbx.refresh()).status).toBe("terminated");
  });

  it("other agents cannot see or touch a sandbox; operators can inspect and stop it but never run code", async () => {
    const { as } = await start();
    const sbx = await as("tok-coder").create(spec);
    await expect(as("tok-other").get(sbx.id)).rejects.toMatchObject({ status: 404 });
    await expect(as("tok-other").execute(sbx.id, "return 1")).rejects.toMatchObject({ status: 404 });
    expect(await as("tok-other").list()).toEqual([]);
    expect((await as("tok-dana").list()).map((s) => s.id)).toEqual([sbx.id]);
    await expect(as("tok-dana").execute(sbx.id, "return 1")).rejects.toMatchObject({ status: 403 });
    await expect(as("tok-dana").create(spec)).rejects.toMatchObject({ status: 403 });
    expect((await as("tok-dana").destroy(sbx.id)).status).toBe("terminated");
  });

  it("violations are visible to operators only", async () => {
    const { url, as } = await start();
    const sbx = await as("tok-coder").create(spec);
    await sbx.run(`await api.fetch("https://evil.example/")`);
    const read = (tok: string) => fetch(`${url}/v1/violations`, { headers: { authorization: `Bearer ${tok}` } });
    expect((await read("tok-coder")).status).toBe(403);
    expect((await read("tok-audrey")).status).toBe(403);
    const v = await (await read("tok-dana")).json();
    expect(v.violations[0]).toMatchObject({ sandboxId: sbx.id, reason: expect.stringMatching(/EXTERNAL_HTTP/) });
  });

  it("enforces tenant policy, per-owner limits, and refuses runtimes that are not available", async () => {
    const { as } = await start({ allowTenant: (c, t) => t === "bloom-botanicals", maxPerOwner: 1 });
    await expect(as("tok-coder").create({ ...spec, tenantId: "northpeak-outfitters" })).rejects.toMatchObject({ status: 403 });
    await as("tok-coder").create(spec);
    await expect(as("tok-coder").create(spec)).rejects.toMatchObject({ status: 429 });
    const err = await as("tok-other").create({ ...spec, runtime: "worker-thread" }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect(err.status).toBe(422);
  });
});
