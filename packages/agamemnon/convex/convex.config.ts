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

import { defineApp } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

/**
 * Component wiring.
 * - workflow: the durable classify → decide → wait → snapshot → execute pipeline
 *   (Phase 3+). Unrelated branches keep running while one action waits.
 * - rateLimiter: caps proposal ingest so a runaway agent can't flood the queue.
 */
const app = defineApp();
app.use(workflow);
app.use(rateLimiter);

export default app;
