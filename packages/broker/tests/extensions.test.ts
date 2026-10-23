// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBroker } from "./helpers.ts";
import { createServer, hashToken } from "../src/server.ts";
import { loadExtensions, type BrokerExtension } from "../src/extensions.ts";

async function serve(b: ReturnType<typeof makeBroker>) {
  b.store.upsertPrincipal({ name: "coder", kind: "agent", owner: "maran", tokenHash: hashToken("agent-tok") });
  b.store.upsertPrincipal({ name: "alice", kind: "human", role: "approver", tokenHash: hashToken("alice-tok") });
  b.store.upsertPrincipal({ name: "maran", kind: "human", role: "admin", tokenHash: hashToken("admin-tok") });
  const server = createServer(b.engine, {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (path: string, token = "") => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("broker extensions", () => {
  it("the open broker serves its own home page when no extension provides one", async () => {
    const b = makeBroker();
    const s = await serve(b);
    try {
      for (const p of ["/", "/console"]) {
        const html = await (await s.call(p)).text();
        expect(html).toContain("The broker is running.");
        expect(html).toContain("agamemnon pending");
      }
    } finally {
      await s.close();
    }
  });

  it("an extension can replace / and /console, add operator routes, and annotate evidence — but not override core routes", async () => {
    const b = makeBroker();
    const seen: string[] = [];
    b.engine.use({
      name: "test-ext",
      pages: { "/console": () => "<html>extension console</html>" },
      routes: (ctx) => {
        seen.push(`${ctx.me.name} ${ctx.path}`);
        const hijack = ctx.path === "/v1/whoami" || ctx.path === "/health" || ctx.path.startsWith("/v1/admin/");
        if (ctx.path !== "/v1/ext/ping" && !hijack) return false;
        ctx.send(200, hijack ? { hijacked: true } : { pong: ctx.me.name });
        return true;
      },
      evidenceControls: (r) => ({ "test control": `decision ${r.decision}` }),
    });
    const s = await serve(b);
    try {
      expect(await (await s.call("/console")).text()).toBe("<html>extension console</html>");
      expect(await (await s.call("/")).text()).toContain("The broker is running."); // only /console was replaced
      expect(await (await s.call("/v1/ext/ping", "alice-tok")).json()).toEqual({ pong: "alice" });
      expect((await s.call("/v1/ext/ping")).status).toBe(401); // unauthenticated
      expect((await s.call("/v1/ext/ping", "agent-tok")).status).toBe(403); // agents never reach extension routes
      expect((await (await s.call("/v1/whoami", "alice-tok")).json()).name).toBe("alice"); // core wins
      expect((await (await s.call("/health")).json()).hijacked).toBeUndefined();
      expect((await s.call("/v1/admin/principals", "alice-tok")).status).toBe(403); // /v1/admin/ stays core-only
      expect((await s.call("/v1/nope", "alice-tok")).status).toBe(403); // unchanged: non-admins get 403 on unknown paths
      expect((await s.call("/v1/nope", "admin-tok")).status).toBe(404);
      expect(seen).toEqual(["alice /v1/ext/ping", "alice /v1/nope", "maran /v1/nope"]);
    } finally {
      await s.close();
    }
  });

  it("evidence lines carry controls only when an extension provides them", () => {
    const b = makeBroker();
    const fake = { receipt: { decision: "allow" } };
    (b.store as any).receipts = () => [fake];
    expect(JSON.parse(b.engine.evidence()[0])).toEqual({ receipt: fake });
    b.engine.use({ name: "a", evidenceControls: () => ({ x: "1" }) });
    b.engine.use({ name: "b", evidenceControls: (r) => ({ y: r.decision }) });
    expect(JSON.parse(b.engine.evidence()[0])).toEqual({ receipt: fake, controls: { x: "1", y: "allow" }, informational: true });
  });

  it("rejects malformed and duplicate extensions", () => {
    const b = makeBroker();
    expect(() => b.engine.use({} as BrokerExtension)).toThrow(/must be an object with a name/);
    expect(() => b.engine.use({ name: "x", pages: { "/approve/1": () => "" } as any })).toThrow(/only provide the "\/" and "\/console" pages/);
    b.engine.use({ name: "x" });
    expect(() => b.engine.use({ name: "x" })).toThrow(/already registered/);
  });

  it("loads extensions named in AGAMEMNON_EXTENSIONS (default or named export)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agm-ext-"));
    writeFileSync(join(dir, "a.mjs"), `export default { name: "from-default" };`);
    writeFileSync(join(dir, "b.mjs"), `export const extension = { name: "from-named" };`);
    writeFileSync(join(dir, "bad.mjs"), `export default 42;`);
    expect((await loadExtensions(undefined)).length).toBe(0);
    expect((await loadExtensions(`./a.mjs, ${join(dir, "b.mjs")}`, dir)).map((x) => x.name)).toEqual(["from-default", "from-named"]);
    await expect(loadExtensions("./bad.mjs", dir)).rejects.toThrow(/must be an object with a name/);
  });
});
