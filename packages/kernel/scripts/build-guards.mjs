// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

/**
 * Bundle the kernel into a CommonJS file inside each desktop guard, so the
 * Electron apps (which package only their own folder) run the SAME policy
 * engine as Convex and the broker. Re-run after any kernel change:
 *   npm run build:guards -w @agamemnon/kernel
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const banner = `/* GENERATED from packages/kernel by scripts/build-guards.mjs — do not edit.
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Elamaran Elangovan */`;

for (const target of ["packages/agamemnon-guard/guard/kernel.cjs", "packages/halcyon/guard/kernel.cjs"]) {
  await build({
    entryPoints: [resolve(here, "../src/index.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    outfile: resolve(root, target),
    banner: { js: banner },
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`wrote ${target}`);
}
