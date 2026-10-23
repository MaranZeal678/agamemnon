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

import net from "node:net";
import { SandboxKill, type ISandboxRuntime, type RunOutcome, type RunRequest } from "./base.runtime.ts";

/**
 * The microVM tier: each run is a fresh Firecracker microVM on a KVM host,
 * driven by vmhost (packages/sandbox/vmhost). The guest runs Python; it has
 * no network device, and its only channel is vsock → vmhost → this runtime →
 * the supervisor's syscall handler (capabilities, broker proposals).
 *
 * Compared with quickjs-wasm, the isolation boundary is hardware
 * virtualisation, the language is Python, and the deadline is enforced by
 * destroying the VM — so it cannot be overrun by a long native call.
 *
 * vmhost is reached over TCP with a shared token (Lima forwards it to
 * 127.0.0.1 on the Mac). This runtime refuses a vmhost that reports
 * isolated=false (the local test driver) unless `allowInsecureLocalDriver`.
 */

const MAX_LOG_LINES = 500;
const MAX_FRAME = 1 << 20;
const BOOT_BUDGET_MS = 25_000;

export interface MicroVmOptions {
  /** vmhost address, e.g. "127.0.0.1:7801". */
  address: string;
  token: string;
  /** Tests only: accept vmhost's local-insecure driver (no VM). */
  allowInsecureLocalDriver?: boolean;
}

/** Resolve options from AGAMEMNON_VMHOST (host:port) and AGAMEMNON_VMHOST_TOKEN. */
export function microVmFromEnv(env = process.env): MicroVmOptions | null {
  if (!env.AGAMEMNON_VMHOST || !env.AGAMEMNON_VMHOST_TOKEN) return null;
  return { address: env.AGAMEMNON_VMHOST, token: env.AGAMEMNON_VMHOST_TOKEN };
}

export class MicroVmRuntime implements ISandboxRuntime {
  readonly kind = "microvm-adapter" as const;
  readonly isolated = true;
  readonly language = "python" as const;
  readonly #opts: MicroVmOptions;
  #socket: net.Socket | null = null;
  #kill: ((reason: string) => void) | null = null;
  #disposed = false;
  /** Boot time of the last run's VM, for display. */
  lastBootMs: number | null = null;

  constructor(opts: MicroVmOptions) {
    this.#opts = opts;
  }

  kill(reason: string): void {
    this.#kill?.(reason);
  }

  dispose(): void {
    this.kill("sandbox terminated");
    this.#disposed = true;
  }

  run(req: RunRequest): Promise<RunOutcome> {
    if (this.#disposed) return Promise.reject(new Error("microvm-adapter: sandbox has been disposed"));
    if (this.#socket) return Promise.reject(new Error("microvm-adapter: sandbox is already running"));
    const { limits, onSyscall } = req;
    const t0 = performance.now();
    const logs: string[] = [];
    let syscalls = 0;
    let buf = "";

    return new Promise<RunOutcome>((resolve, reject) => {
      const [host, port] = splitAddress(this.#opts.address);
      const sock = net.connect({ host, port });
      this.#socket = sock;
      let settled = false;
      let codeStart = 0;

      const finish = (o: Omit<RunOutcome, "logs" | "executionTimeMs" | "syscalls">) => {
        if (settled) return;
        settled = true;
        clearTimeout(wall);
        this.#socket = null;
        this.#kill = null;
        sock.destroy(); // vmhost destroys the VM when we hang up
        resolve({ ...o, logs, syscalls, executionTimeMs: Math.round(performance.now() - (codeStart || t0)) });
      };
      const send = (f: unknown) => {
        if (!sock.destroyed) sock.write(JSON.stringify(f) + "\n");
      };
      this.#kill = (reason) => {
        send({ t: "kill", reason });
        finish({ ok: false, killed: reason, error: `killed: ${reason}` });
      };
      // Belt and braces: vmhost enforces the deadline; this catches a vmhost that doesn't.
      const wall = setTimeout(() => this.kill(`timeout: exceeded ${limits.timeoutMs}ms`), limits.timeoutMs + BOOT_BUDGET_MS);

      sock.setEncoding("utf8");
      sock.on("connect", () => send({ t: "start", token: this.#opts.token, limits: { memMb: limits.maxMemoryMb, timeoutMs: limits.timeoutMs }, code: req.code, context: req.context ?? {} }));
      sock.on("error", (e) => {
        if (settled) return;
        if (!codeStart) {
          settled = true;
          clearTimeout(wall);
          this.#socket = null;
          return reject(new Error(`microvm-adapter: cannot reach vmhost at ${this.#opts.address} (${e.message})`));
        }
        finish({ ok: false, error: `vmhost connection lost: ${e.message}` });
      });
      sock.on("close", () => finish({ ok: false, error: "vmhost closed the connection" }));
      sock.on("data", (chunk: string) => {
        buf += chunk;
        if (buf.length > MAX_FRAME * 2) return this.kill("vmhost sent an oversized frame");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let f: any;
          try {
            f = JSON.parse(line);
          } catch {
            return this.kill("malformed frame from vmhost");
          }
          void handle(f);
        }
      });

      // Guest syscalls are blocking on the guest side, so they arrive one at a time.
      const handle = async (f: any) => {
        if (settled || !f || typeof f !== "object") return;
        switch (f.t) {
          case "error":
            return finish({ ok: false, error: `vmhost: ${f.error}` });
          case "booted":
            this.lastBootMs = typeof f.bootMs === "number" ? f.bootMs : null;
            if (f.isolated !== true && !this.#opts.allowInsecureLocalDriver) return this.kill("vmhost is not running VMs (isolated=false); refusing to run untrusted code");
            codeStart = performance.now();
            return;
          case "log":
            if (logs.length < MAX_LOG_LINES) logs.push(f.level && f.level !== "log" ? `[${f.level}] ${String(f.msg ?? "")}` : String(f.msg ?? ""));
            else if (logs.length === MAX_LOG_LINES) logs.push("[agamemnon] log limit reached; further output dropped");
            return;
          case "sys": {
            const id = f.id;
            try {
              if (++syscalls > limits.maxSyscalls) throw new SandboxKill(`syscall budget exceeded (${limits.maxSyscalls})`);
              const value = await onSyscall(f.req);
              send({ t: "rep", id, ok: true, value: value ?? null });
            } catch (e: any) {
              if (e instanceof SandboxKill) return this.kill(e.reason);
              send({ t: "rep", id, ok: false, error: e instanceof Error ? e.message : String(e) });
            }
            return;
          }
          case "done":
            if (f.killed) return finish({ ok: false, killed: String(f.killed), error: `killed: ${f.killed}` });
            return finish(f.ok ? { ok: true, value: f.value ?? null } : { ok: false, error: String(f.error ?? "the sandbox failed") });
        }
      };
    });
  }
}

function splitAddress(a: string): [string, number] {
  const i = a.lastIndexOf(":");
  if (i < 0) throw new Error(`vmhost address must be host:port, got ${a}`);
  return [a.slice(0, i), Number(a.slice(i + 1))];
}
