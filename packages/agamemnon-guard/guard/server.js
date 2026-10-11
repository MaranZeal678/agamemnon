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

/*
 * The guard server. The bank app talks ONLY to this; it holds no data itself.
 * Bound to 127.0.0.1. Hardened (Gen-2):
 *  - CORS is no longer "*": only the local Electron apps (Origin "null" from
 *    file://) and localhost pages may call it, so a website open in a browser
 *    cannot drive the guard through the user's machine;
 *  - the operator controls (/reset, /enforcement) require the admin token that
 *    the guard app generates on first launch and hands only to its own window.
 */
"use strict";
const http = require("http");
const crypto = require("crypto");

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl, Node, same-process callers
  if (origin === "null") return true; // file:// pages in the local Electron apps
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sendJson(res, code, body, origin) {
  const json = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Agamemnon-Admin",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  res.writeHead(code, headers);
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function createGuardServer(store, port, opts = {}) {
  const started = Date.now();
  const adminToken = opts.adminToken || null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const origin = req.headers.origin;
    const reply = (code, body) => sendJson(res, code, body, origin);
    if (!isAllowedOrigin(origin)) return reply(403, { error: "origin not allowed" });
    if (req.method === "OPTIONS") return reply(204, {});
    const isAdmin = () => !!adminToken && safeEqual(req.headers["x-agamemnon-admin"], adminToken);
    const send = (_res, code, body) => reply(code, body); // keep the handlers below unchanged
    try {
      if (p === "/health") return send(res, 200, { ok: true, service: "agamemnon-guard", records: store.counts().total, enforcement: store.settings().enforcement, uptimeMs: Date.now() - started });
      if (p === "/counts") return send(res, 200, store.counts());
      if (p === "/stats") return send(res, 200, store.stats());
      if (p === "/records") {
        const q = u.searchParams;
        const out = store.list({ status: q.get("status"), region: q.get("region"), q: q.get("q"), limit: Number(q.get("limit") || 25), offset: Number(q.get("offset") || 0) });
        return send(res, 200, { ...out, counts: store.counts() });
      }
      if (p === "/feed") return send(res, 200, { feed: store.feed(Number(u.searchParams.get("limit") || 12)) });
      if (p === "/pending") return send(res, 200, { pending: store.pending() });
      if (p === "/audit") return send(res, 200, { audit: store.auditTail(Number(u.searchParams.get("limit") || 60)) });
      if (p === "/settings") return send(res, 200, store.settings());

      if (req.method === "POST") {
        const body = await readBody(req);
        if (p === "/guard/propose") return send(res, 200, store.propose({ selector: body.selector || {}, actor: body.actor }));
        if (p === "/approve") return send(res, 200, store.approve(body.actionId, body.note));
        if (p === "/deny") return send(res, 200, store.deny(body.actionId, body.note));
        if (p === "/undo") return send(res, 200, store.undo(body.actionId));
        if (p === "/enforcement" || p === "/reset") {
          if (!isAdmin()) return send(res, 401, { error: "operator control requires the guard admin token (X-Agamemnon-Admin)" });
          if (p === "/enforcement") { store.setEnforcement(body.on); return send(res, 200, store.settings()); }
          store.resetDemo(); return send(res, 200, { ok: true });
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      reply(400, { error: e && e.message ? e.message : String(e) });
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

module.exports = { createGuardServer, isAllowedOrigin };
