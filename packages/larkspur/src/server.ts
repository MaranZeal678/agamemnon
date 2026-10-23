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

/** Shorten big arrays and strings so the dashboard can show what an agent sent without shipping it all. */
function trim(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 1500 ? `${v.slice(0, 1500)}…` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, 5).map((x) => trim(x, depth + 1));
    return v.length > 5 ? [...head, `… ${v.length - 5} more`] : head;
  }
  if (v && typeof v === "object" && depth < 6) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}

/** Larkspur's own back-office queries (its admin reads its own database directly). */
async function orders(u: URL) {
  const merchant = u.searchParams.get("merchant") ?? "";
  const status = u.searchParams.get("status") ?? "";
  const q = (u.searchParams.get("q") ?? "").trim();
  const page = Math.max(0, Number(u.searchParams.get("page") ?? 0) || 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (merchant) where.push(`o.merchant_id = $${args.push(merchant)}`);
  if (status) where.push(`o.status = $${args.push(status)}`);
  if (q) where.push(`(o.id::text = $${args.push(q.replace(/^#/, ""))} OR c.email ILIKE $${args.push(`%${q}%`)} OR c.name ILIKE $${args.length} OR o.payment_intent = $${args.push(q)})`);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await Promise.all([
    world.pool.query(
      `SELECT o.id, o.merchant_id, m.name AS merchant, c.name AS customer, c.email, o.status, o.amount_cents, o.payment_intent, o.note, o.created_at
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN merchants m ON m.id = o.merchant_id ${w}
       ORDER BY o.created_at DESC LIMIT 50 OFFSET ${page * 50}`,
      args,
    ),
    world.pool.query(`SELECT count(*)::int AS n FROM orders o JOIN customers c ON c.id = o.customer_id ${w}`, args),
  ]);
  return { rows: rows.rows, total: total.rows[0].n, page };
}

async function customers(u: URL) {
  const merchant = u.searchParams.get("merchant") ?? "";
  const q = (u.searchParams.get("q") ?? "").trim();
  const args: unknown[] = [];
  const where: string[] = [];
  if (merchant) where.push(`c.merchant_id = $${args.push(merchant)}`);
  if (q) where.push(`(c.email ILIKE $${args.push(`%${q}%`)} OR c.name ILIKE $${args.length})`);
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await world.pool.query(
    `SELECT c.id, c.name, c.email, m.name AS merchant, count(o.id)::int AS orders, coalesce(sum(o.amount_cents) FILTER (WHERE o.status IN ('paid','shipped')), 0)::bigint AS spent_cents,
       max(o.created_at) AS last_order, coalesce((SELECT sum(points) FROM loyalty_points l WHERE l.customer_id = c.id), 0)::int AS points
     FROM customers c JOIN merchants m ON m.id = c.merchant_id LEFT JOIN orders o ON o.customer_id = c.id ${w}
     GROUP BY c.id, m.name ORDER BY spent_cents DESC LIMIT 50`,
    args,
  );
  const total = await world.pool.query(`SELECT count(*)::int AS n FROM customers c ${w}`, args);
  return { rows: r.rows, total: total.rows[0].n };
}

async function recentOrders() {
  return (
    await world.pool.query(
      `SELECT o.id, m.name AS merchant, c.name AS customer, o.status, o.amount_cents, o.created_at FROM orders o
       JOIN customers c ON c.id = o.customer_id JOIN merchants m ON m.id = o.merchant_id ORDER BY o.created_at DESC LIMIT 8`,
    )
  ).rows;
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
      taskId: e.taskId,
      params: trim(e.effect?.request?.params ?? null),
      sample: trim(e.effect?.preview?.sample ?? null),
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
    recentOrders: await recentOrders(),
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
      if (req.method === "GET" && url.pathname === "/api/orders") return send(200, await orders(url));
      if (req.method === "GET" && url.pathname === "/api/customers") return send(200, await customers(url));
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
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
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
