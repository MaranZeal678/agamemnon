// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import http from "node:http";

/**
 * Local stand-ins for the SaaS Larkspur depends on — Stripe, GitHub, Datadog
 * and a shipping-rates API. They speak just enough of each real API for the
 * broker's connectors, keep state in memory, and record every call so the
 * dashboard can show what actually reached "the outside world".
 */

export interface MockCall {
  service: string;
  method: string;
  path: string;
  at: number;
}

type Handler = (req: { method: string; path: string; body: any }) => { status?: number; body?: unknown } | undefined;

async function serve(service: string, calls: MockCall[], handler: Handler) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const path = req.url ?? "/";
    calls.push({ service, method: req.method ?? "GET", path, at: Date.now() });
    const r = handler({ method: req.method ?? "GET", path, body }) ?? { status: 404, body: { message: "Not Found" } };
    res.writeHead(r.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(r.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface Mocks {
  stripeUrl: string;
  githubUrl: string;
  datadogUrl: string;
  calls: MockCall[];
  /** Refunds Stripe has actually issued, by payment intent (minor units). */
  refunds: Map<string, number>;
  muted: Set<string>;
  /** fetch() for sandboxes: answers api.shiprates.test, refuses every other host. */
  sandboxFetch: typeof fetch;
  close(): Promise<void>;
}

export const REPO = "larkspur/storefront-api";

export async function startMocks(payments: Map<string, number>): Promise<Mocks> {
  const calls: MockCall[] = [];
  const refunds = new Map<string, number>();
  const muted = new Set<string>();

  const stripe = await serve("stripe", calls, ({ method, path, body }) => {
    const pi = /^\/v1\/payment_intents\/([\w-]+)$/.exec(path);
    if (method === "GET" && pi) {
      const amount = payments.get(pi[1]);
      if (amount === undefined) return undefined;
      return { body: { id: pi[1], amount, amount_received: amount, amount_refunded: refunds.get(pi[1]) ?? 0, currency: "usd", customer: "cus_larkspur" } };
    }
    if (method === "POST" && path === "/v1/refunds") {
      const id = String(body.payment_intent);
      refunds.set(id, (refunds.get(id) ?? 0) + Number(body.amount));
      return { body: { id: `re_${refunds.size}`, amount: Number(body.amount), payment_intent: id } };
    }
    return undefined;
  });

  const files: Record<string, string> = {
    ".github/workflows/ci.yml": "name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n",
  };
  const github = await serve("github", calls, ({ method, path }) => {
    const m = /^\/repos\/larkspur\/storefront-api\/contents\/(.+?)(\?|$)/.exec(path);
    if (method === "GET" && m) {
      const f = files[decodeURIComponent(m[1])];
      return f === undefined ? undefined : { body: { sha: "sha1", content: Buffer.from(f).toString("base64"), encoding: "base64" } };
    }
    if (method === "PUT" && m) return { body: { content: { sha: "sha2" }, commit: { sha: "c0ffee" } } };
    if (method === "GET" && path === `/repos/${REPO}`) return { body: { private: true, default_branch: "main" } };
    return undefined;
  });

  const datadog = await serve("datadog", calls, ({ method, path }) => {
    const m = /^\/api\/v1\/monitor\/(\w+)\/(mute|unmute)/.exec(path);
    if (method !== "POST" || !m) return undefined;
    if (m[2] === "mute") muted.add(m[1]);
    else muted.delete(m[1]);
    return { body: { id: Number(m[1]) } };
  });

  const sandboxFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ service: `sandbox → ${url.hostname}`, method: "GET", path: url.pathname + url.search, at: Date.now() });
    if (url.hostname !== "api.shiprates.test") throw new Error(`network disabled in the demo (${url.hostname})`);
    const zip = url.searchParams.get("zip") ?? "00000";
    const base = 495 + (Number(zip.slice(0, 2)) || 0) * 3;
    return new Response(JSON.stringify({ zip, rates: [{ carrier: "Parcelwise", service: "ground", cents: base }, { carrier: "Parcelwise", service: "express", cents: base * 2 + 300 }] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    stripeUrl: stripe.url,
    githubUrl: github.url,
    datadogUrl: datadog.url,
    calls,
    refunds,
    muted,
    sandboxFetch,
    close: async () => {
      await Promise.all([stripe.close(), github.close(), datadog.close()]);
    },
  };
}
