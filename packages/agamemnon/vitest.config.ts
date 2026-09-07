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

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The policy engine is pure; these run in plain Node with no Convex runtime.
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
