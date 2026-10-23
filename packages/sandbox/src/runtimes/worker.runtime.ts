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

import { RuntimeUnavailable, type ISandboxRuntime, type RunOutcome } from "./base.runtime.ts";

/**
 * Node worker_threads are NOT an isolation boundary: a worker gets the full
 * Node API (fs, net, child_process, process.binding) and `resourceLimits`
 * only caps its heap. Running untrusted code in one would make every
 * "zero access" claim false, so this runtime exists in the type and refuses
 * to run. Use quickjs-wasm.
 */
export class WorkerThreadRuntime implements ISandboxRuntime {
  readonly kind = "worker-thread" as const;
  readonly isolated = false;

  async run(): Promise<RunOutcome> {
    throw new RuntimeUnavailable(this.kind, "worker threads share the host's ambient authority (fs, net, child_process); refusing to run untrusted code — use quickjs-wasm");
  }

  kill(): void {}

  dispose(): void {}
}
