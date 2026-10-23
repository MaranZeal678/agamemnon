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

import http from "node:http";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { bootWorld, MERCHANTS, HUMANS, AGENTS, BROKER_PORT, type World } from "./world.ts";
import { SCENES, type SceneResult } from "./scenes.ts";

/**
 * The Larkspur operations dashboard — `npm start` (or `make larkspur`).
 *
 * Larkspur's own back office: merchants, orders, the storefront-api repo, its
 * agents and plugin sandboxes. Every agent action in the runbook goes through
 * the real Agamemnon broker embedded here; approvals happen in the dashboard
 * (as Dana or Eli) or in the broker's own console on :7710.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const PORT = Number(process.env.LARKSPUR_PORT ?? process.env.PORT ?? 5180);

let world: World = await bootWorld();
let results = new Map<string, SceneResult & { at: number; error?: string }>();
let busy: Promise<unknown> = Promise.resolve();

/** Run one thing at a time: scenes, decisions and resets never interleave. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = busy.then(fn, fn);
  busy = next.catch(() => {});
  return next;
}

async function company() {
  const q = (sql: string) => world.pool.query(sql).then((r) => r.rows);
  const [orders, loyalty] = await Promise.all([
    q(`SELECT merchant_id, status, count(*)::int AS n, sum(amount_cents)::bigint AS cents, count(note)::int AS notes FROM orders GROUP BY 1, 2`),
    q(`SELECT merchant_id, sum(points)::int AS points FROM loyalty_points GROUP BY 1`),
  ]);
  return MERCHANTS.map((m) => {
    const rows = orders.filter((r) => r.merchant_id === m.id);
    const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return {
      ...m,
      orders: rows.reduce((a, r) => a + r.n, 0),
      revenueCents: rows.filter((r) => r.status === "paid" || r.status === "shipped").reduce((a, r) => a + Number(r.cents), 0),
      abandoned: count("abandoned"),
      refunded: count("refunded"),
      notes: rows.reduce((a, r) => a + r.notes, 0),
      loyaltyPoints: loyalty.find((r) => r.merchant_id === m.id)?.points ?? 0,
    };
  });
}

function platform() {
  const tests = existsSync(join(world.workspace, "tests")) ? readdirSync(join(world.workspace, "tests")) : [];
  const sent = existsSync(world.outbox) ? readFileSync(world.outbox, "utf8").split("\n").filter(Boolean).length : 0;
  const refunds = [...world.mocks.refunds.entries()].map(([pi, cents]) => ({ pi, cents }));
  return {
    tests,
    emailsSent: sent,
    refunds,
    mutedMonitors: [...world.mocks.muted],
    outside: world.mocks.calls.slice(-40).reverse(),
  };
}

function agamemnon() {
  const { store, engine } = world.broker;
  const effects = store.recentEffects(80).map((e) => {
    const v = engine.view(e.id);
    return {
      ...v,
      agent: e.agent,
      operation: e.operation,
      system: e.system,
      createdAt: e.createdAt,
      env: e.effect?.request?.target?.env ?? null,
      tenant: e.effect?.request?.target?.tenant ?? null,
      approvals: store.approvals(e.id).map((a) => ({ approver: a.approver, decision: a.decision, at: a.at })),
    };
  });
  const tally: Record<string, number> = {};
  for (const e of effects) tally[e.status] = (tally[e.status] ?? 0) + 1;
  return {
    mode: engine.mode,
    consoleUrl: world.consoleUrl,
    effects,
    tally,
    violations: world.supervisor.violations().slice().reverse(),
    audit: store.auditTail(40),
    chain: store.verifyAudit(),
  };
}

async function state() {
  return {
    epoch: world.epoch,
    company: await company(),
    platform: platform(),
    agamemnon: agamemnon(),
    scenes: SCENES.map((s) => ({ id: s.id, group: s.group, title: s.title, actor: s.actor, intent: s.intent, risk: s.risk, code: s.code ?? null, expect: s.expect, last: results.get(s.id) ?? null })),
    people: HUMANS.map((h) => ({ ...h, token: world.tokens[h.name] })),
    agents: AGENTS,
  };
}

async function decide(effectId: string, action: string, as: string, force: boolean) {
  const { engine, store } = world.broker;
  const who = store.principal(as);
  if (!who || who.kind !== "human") throw new Error(`unknown operator ${as}`);
  switch (action) {
    case "approve":
    case "deny":
      return engine.decide(who, effectId, action);
    case "undo":
      return engine.undoEffect(who, effectId, { force });
    case "cancel":
      return engine.cancelHold(who, effectId);
    default:
      throw new Error(`unknown action ${action}`);
  }
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname.startsWith("/api/")) {
      let body: any = {};
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      }
      if (req.method === "GET" && url.pathname === "/api/state") return send(200, await state());
      const run = /^\/api\/scenes\/([\w-]+)\/run$/.exec(url.pathname);
      if (req.method === "POST" && run) {
        const scene = SCENES.find((s) => s.id === run[1]);
        if (!scene) return send(404, { error: "no such scene" });
        const r = await serial(async () => {
          try {
            const out = { ...(await scene.run(world)), at: Date.now() };
            results.set(scene.id, out);
            return out;
          } catch (e: any) {
            const out = { headline: "The scene failed to run.", effects: [], outcomes: [], at: Date.now(), error: e?.message ?? String(e) };
            results.set(scene.id, out);
            return out;
          }
        });
        return send(200, r);
      }
      const act = /^\/api\/effects\/([\w-]+)\/(approve|deny|undo|cancel)$/.exec(url.pathname);
      if (req.method === "POST" && act) {
        try {
          return send(200, await serial(() => decide(act[1], act[2], String(body.as ?? "dana"), !!body.force)));
        } catch (e: any) {
          return send(409, { error: e?.message ?? String(e), rule: e?.rule ?? null });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        await serial(async () => {
          await world.close();
          world = await bootWorld();
          results = new Map();
        });
        return send(200, { ok: true, epoch: world.epoch });
      }
      return send(404, { error: "not found" });
    }
    const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch (e: any) {
    send(500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Larkspur operations   http://127.0.0.1:${PORT}`);
  console.log(`Agamemnon console     http://127.0.0.1:${BROKER_PORT}/console   (operator tokens are on the dashboard's Operators page)`);
});
const stop = async () => {
  await world.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
