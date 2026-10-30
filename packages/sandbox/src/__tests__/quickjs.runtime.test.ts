// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { describe, it, expect } from "vitest";
import { QuickJSRuntime } from "../runtimes/quickjs.runtime.ts";
import { WorkerThreadRuntime } from "../runtimes/worker.runtime.ts";
import { RuntimeUnavailable, SandboxKill, type RunLimits, type SyscallHandler } from "../runtimes/base.runtime.ts";

const LIMITS: RunLimits = { maxMemoryMb: 32, timeoutMs: 1000, maxSyscalls: 50 };
const refuse: SyscallHandler = async () => {
  throw new Error("no syscalls in this test");
};

function run(code: string, opts: { onSyscall?: SyscallHandler; limits?: Partial<RunLimits>; context?: Record<string, unknown>; rt?: QuickJSRuntime } = {}) {
  const rt = opts.rt ?? new QuickJSRuntime();
  return rt.run({ code, context: opts.context ?? {}, limits: { ...LIMITS, ...opts.limits }, onSyscall: opts.onSyscall ?? refuse });
}

describe("quickjs-wasm enclave — compute", () => {
  it("returns the guest's value, captures logs and exposes a frozen context", async () => {
    const r = await run(
      `console.log("hello", { n: 1 }); console.warn("careful");
       context.user.name = "mallory"; // sloppy mode: a silent no-op on a frozen object
       return { sum: [1, 2, 3].reduce((a, b) => a + b), who: context.user.name, frozen: Object.isFrozen(context.user) };`,
      { context: { user: { name: "alice" } } },
    );
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ sum: 6, who: "alice", frozen: true });
    expect(r.logs).toEqual(['hello {"n":1}', "[warn] careful"]);
  });

  it("reports syntax errors, thrown errors and non-JSON results as failures", async () => {
    expect((await run("return (")).error).toMatch(/SyntaxError/);
    expect((await run("throw new Error('boom')")).error).toMatch(/boom/);
    expect((await run("return 10n")).error).toMatch(/not JSON-serialisable/);
  });
});

describe("quickjs-wasm enclave — no ambient authority", () => {
  it("has no Node, network, timers, module loader or host functions in scope", async () => {
    const r = await run(`return {
      require: typeof require, process: typeof process, fetch: typeof fetch, setTimeout: typeof setTimeout,
      sys: typeof sys, log: typeof log, finish: typeof finish, Buffer: typeof Buffer, WebAssembly: typeof WebAssembly,
    };`);
    expect(r.value).toEqual({ require: "undefined", process: "undefined", fetch: "undefined", setTimeout: "undefined", sys: "undefined", log: "undefined", finish: "undefined", Buffer: "undefined", WebAssembly: "undefined" });
    const imp = await run(`await import("fs"); return "escaped";`);
    expect(imp.ok).toBe(false);
  });

  it("replacing the db/api surface gains the guest nothing — authority lives in the host closure", async () => {
    // QuickJS lets a non-configurable global be redefined (a spec deviation on
    // the global object), so the surface is NOT tamper-proof. It does not need
    // to be: the only path out is the prelude's captured `sys`.
    const seen: unknown[] = [];
    const r = await run(
      `Object.defineProperty(globalThis, "db", { value: { insert: async () => ({ status: "executed", forged: true }) } });
       return await db.insert("orders", { amount: 1 });`,
      {
        onSyscall: async (req) => {
          seen.push(req);
          return null;
        },
      },
    );
    expect(r.value).toEqual({ status: "executed", forged: true }); // the guest only fooled itself
    expect(seen).toEqual([]);
    expect(r.syscalls).toBe(0);
  });

  it("nothing a run leaves on globals survives into the next run", async () => {
    const rt = new QuickJSRuntime();
    await run(`globalThis.stash = "tenant-a-secret"; Object.prototype.polluted = 1; return null;`, { rt });
    const r = await run(`return { stash: typeof stash, polluted: ({}).polluted ?? null };`, { rt });
    expect(r.value).toEqual({ stash: "undefined", polluted: null });
  });
});

describe("quickjs-wasm enclave — syscalls", () => {
  it("carries a request out, unvalidated, and the reply back in", async () => {
    const seen: unknown[] = [];
    const r = await run(`const res = await db.insert("orders", { amount: 5 }); return res;`, {
      onSyscall: async (req) => {
        seen.push(req);
        return { proposalId: "eff_1", status: "executed" };
      },
    });
    expect(seen).toEqual([{ op: "db.mutate", mutation: { table: "orders", operation: "insert", data: { amount: 5 } } }]);
    expect(r.value).toEqual({ proposalId: "eff_1", status: "executed" });
    expect(r.syscalls).toBe(1);
  });

  it("a handler Error is a rejected promise the guest can catch", async () => {
    const r = await run(`try { await api.fetch("https://x.test"); } catch (e) { return "caught: " + e.message; }`, {
      onSyscall: async () => {
        throw new Error("EXTERNAL_HTTP not granted");
      },
    });
    expect(r.value).toBe("caught: EXTERNAL_HTTP not granted");
  });

  it("SandboxKill aborts the run — nothing after the offending call executes", async () => {
    const seen: unknown[] = [];
    const r = await run(`console.log("before"); await db.delete("orders"); await db.insert("audit", {}); console.log("after"); return "survived";`, {
      onSyscall: async (req) => {
        seen.push(req);
        throw new SandboxKill("MUTATE_STATE not granted");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.killed).toBe("MUTATE_STATE not granted");
    expect(seen).toHaveLength(1);
    expect(r.logs).toEqual(["before"]);
  });

  it("guest tampering with JSON or Promise cannot change what crosses the boundary", async () => {
    const seen: unknown[] = [];
    const r = await run(
      `JSON.stringify = () => '{"op":"forged"}';
       Promise.prototype.then = function () { return "hijacked"; };
       const v = await db.select("orders", { id: 1 });
       return v;`,
      {
        onSyscall: async (req) => {
          seen.push(req);
          return [{ id: 1 }];
        },
      },
    );
    expect(seen).toEqual([{ op: "db.select", table: "orders", where: { id: 1 } }]);
    expect(r.ok).toBe(true);
  });

  it("kills a run that exceeds its syscall budget", async () => {
    const r = await run(`for (let i = 0; i < 100; i++) await db.select("t"); return "done";`, { onSyscall: async () => [], limits: { maxSyscalls: 10 } });
    expect(r.killed).toMatch(/syscall budget exceeded/);
    expect(r.syscalls).toBe(11);
  });
});

describe("quickjs-wasm enclave — resource limits", () => {
  it("kills a synchronous infinite loop at the deadline", async () => {
    const r = await run(`while (true) {}`, { limits: { timeoutMs: 200 } });
    expect(r.killed).toMatch(/timeout/);
    expect(r.executionTimeMs).toBeLessThan(1500);
  });

  it("kills a microtask spin that never yields to the host", async () => {
    const r = await run(`for (;;) await null;`, { limits: { timeoutMs: 200 } });
    expect(r.killed).toMatch(/timeout/);
  });

  it("kills catastrophic regex backtracking (ReDoS) at the deadline", async () => {
    const r = await run(`return /^(a+)+$/.test("a".repeat(30) + "b");`, { limits: { timeoutMs: 200 } });
    expect(r.killed).toMatch(/timeout/);
  });

  it("kills a run stuck waiting on a syscall that never answers", async () => {
    const r = await run(`await db.select("t"); return "unreachable";`, { onSyscall: () => new Promise(() => {}), limits: { timeoutMs: 200 } });
    expect(r.killed).toMatch(/timeout/);
  });

  it("enforces the memory cap", async () => {
    const r = await run(`const a = []; while (true) a.push(new Array(1e5).fill(7));`, { limits: { maxMemoryMb: 16 } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of memory/);
  });

  it("survives unbounded recursion", async () => {
    const r = await run(`const f = (n) => f(n + 1) + 1; return f(0);`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stack overflow|too much recursion/i);
  });

  it("a guest that exhausts the HOST stack kills the run, and the next run gets a fresh module", async () => {
    const rt = new QuickJSRuntime();
    const r = await run(`const a = []; let o = a; for (let i = 0; i < 1e5; i++) { o.push([]); o = o[0]; } return JSON.stringify(a).length;`, { rt });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stack overflow|enclave crashed/);
    expect((await run(`return "still standing";`, { rt })).value).toBe("still standing");
  });

  it("stays usable after a kill, and refuses to run once disposed", async () => {
    const rt = new QuickJSRuntime();
    expect((await run(`while (true) {}`, { rt, limits: { timeoutMs: 100 } })).killed).toBeTruthy();
    expect((await run(`return 42;`, { rt })).value).toBe(42);
    expect(rt.lastTeardownError).toBeNull();
    rt.dispose();
    await expect(run(`return 1;`, { rt })).rejects.toThrow(/disposed/);
  });
});

describe("worker-thread runtime", () => {
  it("refuses to run untrusted code", async () => {
    const w = new WorkerThreadRuntime();
    expect(w.isolated).toBe(false);
    await expect(w.run()).rejects.toBeInstanceOf(RuntimeUnavailable);
  });
});
