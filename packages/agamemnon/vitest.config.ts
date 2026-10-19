// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The policy engine is pure; these run in plain Node with no Convex runtime.
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
