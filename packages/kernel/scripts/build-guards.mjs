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
 * Agamemnon — Copyright (c) 2026 Elamaran Elangovan. All rights reserved. ref: AGMN-BOZW-F6BTKX-X3LAO */`;

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
