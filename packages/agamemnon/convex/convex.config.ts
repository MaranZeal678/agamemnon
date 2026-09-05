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
