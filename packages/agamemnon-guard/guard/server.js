/*
 * The guard server. The bank app talks ONLY to this; it holds no data itself.
 * localhost-only, permissive CORS (both apps are local Electron clients).
 */
"use strict";
const http = require("http");

function send(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function createGuardServer(store, port) {
  const started = Date.now();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (req.method === "OPTIONS") return send(res, 204, {});
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
        if (p === "/enforcement") { store.setEnforcement(body.on); return send(res, 200, store.settings()); }
        if (p === "/reset") { store.resetDemo(); return send(res, 200, { ok: true }); }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 400, { error: e && e.message ? e.message : String(e) });
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

module.exports = { createGuardServer };
