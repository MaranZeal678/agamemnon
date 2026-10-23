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

import { newQuickJSWASMModule, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten";
import { SandboxKill, type ISandboxRuntime, type RunOutcome, type RunRequest } from "./base.runtime.ts";

/**
 * The QuickJS-Wasm enclave.
 *
 * Isolation comes from what the guest is NOT given: QuickJS compiled to Wasm
 * has no filesystem, network, timers, modules or host objects. The guest gets
 * exactly three host functions — sys (syscalls out), log, finish — passed in
 * a closure, never placed on globalThis. Everything else it sees (db, api,
 * agents, console, context) is guest-side JS built from those three.
 *
 *   one enclave  = one Wasm module (its own linear memory — tenants never share a heap)
 *   one run      = a fresh QuickJS runtime + context (nothing survives between runs)
 *   memory cap   = runtime.setMemoryLimit
 *   CPU cap      = interrupt handler on a deadline, plus a wall-clock timer for syscall waits.
 *                  Checked between bytecodes and inside the regex engine, so loops, ReDoS and
 *                  comparator sorts stop on time — but one bulk native call (Array.fill on a
 *                  huge array, GC thrash at the memory cap) can overrun it by seconds. Hard
 *                  preemption needs the module hosted in a worker we can terminate().
 *   kill         = refuse further execution, then dispose everything on the host's next tick
 *   crash        = a host exception escaping the VM (V8 stack exhaustion) kills the run and
 *                  discards the Wasm module — its C state may be inconsistent after unwinding
 *
 * Host policy never runs on the VM's call stack: a syscall is answered after
 * an await, so a SyscallHandler can kill and tear down the enclave safely.
 */

const MAX_SYSCALL_BYTES = 1 << 20;
const MAX_RESULT_BYTES = 1 << 20;
const MAX_IN_FLIGHT = 16;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE = 2000;
/**
 * QuickJS's own stack check. Kept small because Wasm frames also consume the
 * HOST's V8 stack, and deep C recursion (JSON.stringify of a deeply nested
 * array) can exhaust that first. 64 KiB allows ~370 levels of JS recursion.
 * The real guarantee is `enter()` below: a host exception escaping the VM
 * kills the run and discards the Wasm module.
 */
const STACK_BYTES = 64 * 1024;
/**
 * Pending jobs run in slices, yielding the host event loop between them, so
 * one tenant's `for (;;) await null` cannot starve every other sandbox (or the
 * supervisor's own terminate). A synchronous `while (true) {}` still holds
 * the event loop until its deadline — only a worker-hosted enclave fixes that.
 */
const JOBS_PER_SLICE = 1000;

/**
 * Runs before any guest code. Captures the intrinsics it relies on first, so a
 * guest that later replaces JSON.stringify or Promise.prototype.then cannot
 * change what crosses the boundary.
 *
 * The globals it defines are frozen against accidental clobbering only —
 * QuickJS lets a non-configurable global be redefined. That is fine: no
 * authority lives in `db`/`api`/`agents`; it lives in the captured `sys`, and
 * every request is validated by the supervisor anyway.
 */
const PRELUDE = `(function install(sys, log, finish, contextJson) {
  "use strict";
  const stringify = JSON.stringify, parse = JSON.parse, apply = Reflect.apply;
  const then = Promise.prototype.then, freezeObj = Object.freeze, keys = Object.keys, defineProp = Object.defineProperty;
  const ask = (req) => apply(then, sys(stringify(req)), [(raw) => {
    const r = parse(raw);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }]);
  const freeze = (o) => {
    if (o !== null && typeof o === "object" && !Object.isFrozen(o)) { freezeObj(o); for (const k of keys(o)) freeze(o[k]); }
    return o;
  };
  const define = (name, value) => defineProp(globalThis, name, { value: freeze(value), writable: false, configurable: false, enumerable: false });
  const fmt = (args) => args.map((a) => {
    if (typeof a === "string") return a;
    try { return stringify(a); } catch (e) { return String(a); }
  }).join(" ");

  define("context", parse(contextJson));
  define("db", {
    select: (table, where) => ask({ op: "db.select", table, where }),
    insert: (table, data) => ask({ op: "db.mutate", mutation: { table, operation: "insert", data } }),
    update: (table, data, where) => ask({ op: "db.mutate", mutation: { table, operation: "update", data, where } }),
    delete: (table, where) => ask({ op: "db.mutate", mutation: { table, operation: "delete", data: {}, where } }),
  });
  define("api", { fetch: (url) => ask({ op: "http.fetch", url: String(url) }) });
  define("agents", {
    send: (to, message) => ask({ op: "ipc.send", to, message }),
    recv: () => ask({ op: "ipc.recv" }),
  });
  define("console", {
    log: (...a) => log("log", fmt(a)),
    info: (...a) => log("info", fmt(a)),
    warn: (...a) => log("warn", fmt(a)),
    error: (...a) => log("error", fmt(a)),
  });

  return (promise) => apply(then, promise, [
    (v) => {
      let s;
      try { s = stringify(v === undefined ? null : v); } catch (e) { return finish(false, "result is not JSON-serialisable: " + String(e)); }
      finish(true, s);
    },
    (e) => finish(false, String(e)),
  ]);
})`;

interface ActiveRun {
  live: boolean;
  killed: string | null;
  settle: (o: { ok: boolean; value?: unknown; error?: string }) => void;
}

export class QuickJSRuntime implements ISandboxRuntime {
  readonly kind = "quickjs-wasm" as const;
  readonly isolated = true;
  #module: Promise<QuickJSWASMModule> | null = null;
  #run: ActiveRun | null = null;
  #disposed = false;
  /** Set if a run crashed the enclave or teardown failed (a leaked handle). The Wasm module is replaced before the next run. */
  lastTeardownError: string | null = null;

  kill(reason: string): void {
    const run = this.#run;
    if (!run || run.killed !== null) return;
    run.killed = reason;
    run.settle({ ok: false });
  }

  dispose(): void {
    this.kill("sandbox terminated");
    this.#disposed = true;
    this.#module = null;
  }

  async run(req: RunRequest): Promise<RunOutcome> {
    if (this.#disposed) throw new Error("quickjs-wasm: enclave has been disposed");
    if (this.#run) throw new Error("quickjs-wasm: enclave is already running");
    const { limits, onSyscall } = req;
    const t0 = performance.now();
    const logs: string[] = [];
    let syscalls = 0;
    let inFlight = 0;

    let contextJson: string;
    try {
      contextJson = JSON.stringify(req.context ?? {});
    } catch (e: any) {
      return { ok: false, error: `context is not JSON-serialisable: ${e?.message ?? e}`, logs, executionTimeMs: 0, syscalls: 0 };
    }

    this.#module ??= newQuickJSWASMModule();
    const module = await this.#module;
    const rt = module.newRuntime();
    rt.setMemoryLimit(limits.maxMemoryMb * 1024 * 1024);
    rt.setMaxStackSize(STACK_BYTES);
    const vm = rt.newContext();

    let settled: { ok: boolean; value?: unknown; error?: string } | null = null;
    let wake!: () => void;
    const done = new Promise<void>((r) => (wake = r));
    const run: ActiveRun = {
      live: true,
      killed: null,
      settle: (o) => {
        if (settled) return; // first outcome wins
        settled = o;
        wake();
      },
    };
    this.#run = run;

    const deadline = Date.now() + limits.timeoutMs;
    const timer = setTimeout(() => this.kill(`timeout: exceeded ${limits.timeoutMs}ms`), limits.timeoutMs);
    rt.setInterruptHandler(() => {
      if (run.killed !== null) return true;
      if (Date.now() > deadline) {
        this.kill(`timeout: exceeded ${limits.timeoutMs}ms`);
        return true;
      }
      return false;
    });

    const pending = new Set<QuickJSDeferredPromise>();
    const handles: QuickJSHandle[] = [];
    let crashed = false;
    /** Every entry into the VM goes through here. */
    const enter = (fn: () => void) => {
      try {
        fn();
      } catch (e: any) {
        crashed = true;
        this.kill(`enclave crashed: ${e?.message ?? e}`);
      }
    };
    let pumpScheduled = false;
    const pump = () =>
      enter(() => {
        if (!run.live || run.killed !== null) return;
        const r = rt.executePendingJobs(JOBS_PER_SLICE);
        if (r.error) {
          const msg = describe(vm, r.error);
          r.error.dispose();
          run.settle({ ok: false, error: msg });
          return;
        }
        if (rt.hasPendingJob() && !pumpScheduled) {
          pumpScheduled = true;
          setImmediate(() => {
            pumpScheduled = false;
            pump();
          });
        }
      });

    const answer = async (raw: string | null, d: QuickJSDeferredPromise) => {
      await null; // leave the VM's call stack before any policy runs
      let reply: { ok: true; value: unknown } | { ok: false; error: string };
      try {
        if (raw === null) throw new SandboxKill("malformed syscall: request was not a string");
        if (raw.length > MAX_SYSCALL_BYTES) throw new SandboxKill(`syscall larger than ${MAX_SYSCALL_BYTES} bytes`);
        if (++syscalls > limits.maxSyscalls) throw new SandboxKill(`syscall budget exceeded (${limits.maxSyscalls})`);
        let request: unknown;
        try {
          request = JSON.parse(raw);
        } catch {
          throw new SandboxKill("malformed syscall: not JSON");
        }
        if (inFlight >= MAX_IN_FLIGHT) {
          reply = { ok: false, error: `more than ${MAX_IN_FLIGHT} syscalls in flight` };
        } else {
          inFlight++;
          try {
            reply = { ok: true, value: (await onSyscall(request)) ?? null };
          } finally {
            inFlight--;
          }
        }
      } catch (e: any) {
        if (e instanceof SandboxKill) return this.kill(e.reason);
        reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (!run.live || run.killed !== null || !d.alive) return;
      let json: string;
      try {
        json = JSON.stringify(reply);
      } catch {
        json = JSON.stringify({ ok: false, error: "syscall reply was not JSON-serialisable" });
      }
      enter(() => {
        const h = vm.newString(json);
        d.resolve(h);
        h.dispose();
      });
    };

    const sysFn = vm.newFunction("sys", (reqH) => {
      const d = vm.newPromise();
      pending.add(d);
      void d.settled.then(() => {
        pending.delete(d);
        pump();
      });
      void answer(vm.typeof(reqH) === "string" ? vm.getString(reqH) : null, d);
      return d.handle;
    });
    const logFn = vm.newFunction("log", (levelH, msgH) => {
      if (logs.length > MAX_LOG_LINES) return;
      if (logs.length === MAX_LOG_LINES) {
        logs.push("[agamemnon] log limit reached; further output dropped");
        return;
      }
      const level = vm.typeof(levelH) === "string" ? vm.getString(levelH) : "log";
      const msg = vm.typeof(msgH) === "string" ? vm.getString(msgH).slice(0, MAX_LOG_LINE) : "";
      logs.push(level === "log" ? msg : `[${level}] ${msg}`);
    });
    const finishFn = vm.newFunction("finish", (okH, payloadH) => {
      const ok = vm.typeof(okH) === "boolean" && vm.dump(okH) === true;
      const payload = vm.typeof(payloadH) === "string" ? vm.getString(payloadH) : null;
      if (payload !== null && payload.length > MAX_RESULT_BYTES) {
        run.settle({ ok: false, error: `result larger than ${MAX_RESULT_BYTES} bytes` });
      } else if (ok) {
        run.settle({ ok: true, value: payload === null ? null : JSON.parse(payload) });
      } else {
        run.settle({ ok: false, error: payload ?? "guest code failed" });
      }
    });
    handles.push(sysFn, logFn, finishFn);

    enter(() => {
      const install = vm.unwrapResult(vm.evalCode(PRELUDE, "agamemnon-prelude.js"));
      handles.push(install);
      const ctxH = vm.newString(contextJson);
      handles.push(ctxH);
      const settle = vm.unwrapResult(vm.callFunction(install, vm.undefined, sysFn, logFn, finishFn, ctxH));
      handles.push(settle);

      const evaluated = vm.evalCode(`(async () => {\n${req.code}\n})()`, "sandbox.js");
      if (evaluated.error) {
        run.settle({ ok: false, error: describe(vm, evaluated.error) });
        evaluated.error.dispose();
      } else {
        const r = vm.callFunction(settle, vm.undefined, evaluated.value);
        evaluated.value.dispose();
        if (r.error) {
          run.settle({ ok: false, error: describe(vm, r.error) });
          r.error.dispose();
        } else {
          r.value.dispose();
          pump();
        }
      }
    });

    try {
      await done;
      const outcome = settled as unknown as { ok: boolean; value?: unknown; error?: string };
      const killed = run.killed ?? undefined;
      return {
        ok: outcome.ok && !killed,
        value: outcome.ok && !killed ? outcome.value : undefined,
        error: killed ? `killed: ${killed}` : outcome.error,
        killed,
        logs,
        executionTimeMs: Math.round(performance.now() - t0),
        syscalls,
      };
    } finally {
      clearTimeout(timer);
      run.live = false;
      this.#run = null;
      try {
        for (const d of pending) if (d.alive) d.dispose();
        for (const h of handles) if (h.alive) h.dispose();
        vm.dispose();
        rt.dispose();
        if (crashed) throw new Error(this.lastTeardownError ?? "enclave crashed");
      } catch (e: any) {
        // A leaked handle aborts the Wasm module. Never reuse it.
        this.lastTeardownError = e?.message ?? String(e);
        this.#module = null;
      }
    }
  }
}

/** Render a guest error handle as text, without trusting it to be well-formed. */
function describe(vm: QuickJSContext, h: QuickJSHandle): string {
  try {
    const e = vm.dump(h) as any;
    if (e && typeof e === "object" && typeof e.message === "string") return `${e.name ?? "Error"}: ${e.message}`;
    return String(e);
  } catch {
    return "unknown guest error";
  }
}
