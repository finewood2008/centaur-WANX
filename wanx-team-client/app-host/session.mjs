import http from "node:http";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer } from "ws";

const fail = (code, status = 401) => Object.assign(new Error(code), { code, status });
const MAX_WS_PAYLOAD = 32 * 1024 * 1024;
const TERMINAL = new Set(["NETWORK_CHANGED", "SESSION_CLOSED", "GATEWAY_CLOSED", "PLATFORM_SESSION_EXPIRED", "HOST_SESSION_EXPIRED"]);
const REQUEST_HEADERS = new Set(["accept", "accept-language", "content-type", "x-octop-agent-id", "x-content-sha256", "range", "if-none-match", "if-modified-since"]);

// Own the launch's credentials and local resources, but borrow its fixed box connection.
export async function createApplicationSession({
  hostApplicationId, applicationId, installPath, createConnection, authorizeRelease, signal, studioControl,
} = {}) {
  signal?.throwIfAborted();
  const launchId = randomUUID(), token = randomUUID() + randomUUID();
  const connection = await createConnection();
  signal?.throwIfAborted();
  let url, invalid = false, closing, unsubscribe, heartbeat;
  let releasePermit, releaseExpiry, releaseRenewal, releaseAbort;
  const releaseController = new AbortController();
  const operations = new Set(), events = new Set(), sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, perMessageDeflate: false,
    handleProtocols: (_protocols, req) => req.selectedProtocol || false });
  function state() {
    if (invalid) throw fail("HOST_SESSION_EXPIRED");
    try { releasePermit?.assertLive(); return connection.context(); }
    catch { invalidate(); throw fail("HOST_SESSION_EXPIRED"); }
  }
  function clearRelease() {
    clearTimeout(releaseExpiry); clearTimeout(releaseRenewal);
    releasePermit?.signal?.removeEventListener("abort", releaseAbort);
  }
  function watchRelease(permit) {
    if (!permit || typeof permit.assertLive !== "function" || !Number.isFinite(permit.expiresAt))
      throw fail("MARKET_RELEASE_ACCESS_INVALID", 403);
    permit.assertLive();
    clearRelease(); releasePermit = permit;
    releaseAbort = () => invalidate();
    permit.signal?.addEventListener("abort", releaseAbort, { once: true });
    const remaining = Math.min(60_000, permit.expiresAt - Date.now());
    if (remaining <= 0 || permit.signal?.aborted) throw fail("MARKET_RELEASE_ACCESS_EXPIRED", 403);
    // This deadline is independent of the renewal request. A hung Admin request
    // cannot keep existing HTTP, SSE or WebSocket traffic alive after expiry.
    releaseExpiry = setTimeout(() => invalidate(), remaining);
    releaseExpiry.unref();
    releaseRenewal = setTimeout(async () => {
      try {
        const next = await authorizeRelease({ signal: releaseController.signal });
        if (!invalid) watchRelease(next);
      } catch { invalidate(); }
    }, Math.max(1, Math.floor(remaining / 2)));
    releaseRenewal.unref();
  }
  function invalidate() {
    if (invalid) return;
    invalid = true;
    clearRelease(); releaseController.abort();
    unsubscribeConnection();
    for (const res of events) res.end('data: {"type":"invalidated","code":"HOST_SESSION_EXPIRED"}\n\n');
    events.clear();
    for (const abort of operations) abort();
    for (const ws of sockets) ws.terminate();
  }
  function unsubscribeConnection() {
    const stop = unsubscribe;
    unsubscribe = undefined;
    stop?.();
  }
  function authorize(req) {
    if (req.headers.host !== new URL(url).host || req.headers.origin ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none")) throw fail("HOST_ORIGIN_DENIED", 403);
    if (req.headers.authorization !== `Bearer ${token}`) throw fail("HOST_UNAUTHORIZED");
    const current = state();
    return current;
  }
  function apiPath(raw, websocket = false, method = "GET") {
    let decoded;
    try { decoded = decodeURIComponent(raw.split("?")[0]); } catch { throw fail("APPLICATION_PATH_NOT_ALLOWED", 400); }
    if (!decoded.startsWith("/api/") || /[\\\x00-\x1f#]/.test(decoded) || decoded.includes("//") || decoded.split(/[/?]/).some(p => p === "." || p === "..")) throw fail("APPLICATION_PATH_NOT_ALLOWED", 400);
    const endpoint = new URL(raw, url);
    if ((decoded === "/api/auth" || decoded.startsWith("/api/auth/")) &&
        !["GET /api/auth/me", "PATCH /api/auth/me", "POST /api/auth/me/avatar", "DELETE /api/auth/me/avatar"].includes(`${method} ${decoded}`)) throw fail("HOST_AUTH_MANAGED", 403);
    // Credentials are supplied by the Host, never by an application URL.
    if (["token", "access_token"].some(key => endpoint.searchParams.has(key))) throw fail("APPLICATION_PATH_NOT_ALLOWED", 400);
    if (websocket && decoded !== "/api/browser-stream/ws" && !/^\/api\/agents\/[A-Za-z0-9_-]{1,128}\/chat\/ws$/.test(decoded)) throw fail("APPLICATION_PATH_NOT_ALLOWED", 400);
    return raw;
  }
  const headersFor = req => Object.fromEntries(Object.entries(req.headers).filter(([name]) => REQUEST_HEADERS.has(name) || (name === "x-xingtu-key" && /^\/api\/semantica\/open\/v1\//.test(req.url.split("?")[0]))));
  function errorResponse(res, error) {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    const code = error.status ? error.code : error.code === "NETWORK_NOT_READY" ? "NETWORK_NOT_READY" : "HOST_UPSTREAM_UNAVAILABLE";
    res.writeHead(error.status || 503, { "content-type": "application/json", "cache-control": "no-store", "x-wanx-error": code });
    res.end(JSON.stringify({ code }));
  }
  function checkReady() {
    if (state().connection !== "ready") throw fail("NETWORK_NOT_READY", 503);
  }
  // Large uploads must not hit Node's total request-duration deadline.
  const server = http.createServer({ requestTimeout: 0 }, async (req, res) => {
    let abort, controller;
    try {
      const control = ["/__wanx/context", "/__wanx/events"].includes(req.url);
      const current = authorize(req);
      if (control) {
        if (req.method !== "GET") throw fail("HOST_METHOD_NOT_ALLOWED", 405);
        if (req.url === "/__wanx/context") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          return res.end(JSON.stringify(current));
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.write(`data: ${JSON.stringify({ type: "connection", connection: current.connection })}\n\n`);
        events.add(res);
        res.once("close", () => events.delete(res));
        return;
      }
      if (req.url.startsWith("/__wanx/studio/")) {
        checkReady();
        if (applicationId !== "ai.wanx.studio" || typeof studioControl !== "function" || req.method !== "POST") throw fail("STUDIO_CONTROL_DENIED", 403);
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8192) throw fail("STUDIO_REQUEST_TOO_LARGE", 413); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const operation = req.url.slice("/__wanx/studio/".length);
        const result = await studioControl({ operation, body, connection, assertLive: state });
        state(); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(result)); return;
      }
      const path = apiPath(req.url, false, req.method);
      checkReady();
      controller = new AbortController();
      abort = () => {
        controller.abort();
        // Destroying an unread incoming socket after sending a rejection can
        // reset it before the client receives the business response.
        if (res.writableFinished) req.resume();
        else { req.destroy(); res.destroy(); }
      };
      operations.add(abort);
      res.once("close", abort);
      req.once("aborted", abort);
      const result = await connection.request({ path, method: req.method, headers: headersFor(req),
        body: req, stream: true, signal: controller.signal });
      if (invalid || controller.signal.aborted) { result.body?.destroy?.(); return; }
      if (result.status === 401) {
        result.body?.destroy?.(); operations.delete(abort); res.removeListener("close", abort);
        invalidate(); throw fail("HOST_SESSION_EXPIRED");
      }
      if (!req.complete && result.status >= 400) req.resume();
      const headers = { ...result.headers };
      for (const key of Object.keys(headers)) if (["set-cookie", "x-octop-access-token", "location", "x-wanx-error"].includes(key.toLowerCase())) delete headers[key];
      res.writeHead(result.status, headers);
      if (result.body?.pipe) await pipeline(result.body, res);
      else res.end(result.body);
    } catch (error) {
      if (TERMINAL.has(error.code || error.message)) {
        operations.delete(abort);
        if (abort) res.removeListener("close", abort);
        invalidate();
        error = fail("HOST_SESSION_EXPIRED");
      }
      errorResponse(res, error);
    } finally {
      if (abort) { operations.delete(abort); res.removeListener("close", abort); req.removeListener("aborted", abort); }
    }
  });
  function track(ws) {
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    ws.on("error", () => {});
  }
  function bridge(source, target) {
    source.on("message", (data, binary) => {
      if (invalid || target.readyState !== WebSocket.OPEN) return source.terminate();
      source.pause();
      target.send(data, { binary }, error => {
        if (error) { source.terminate(); target.terminate(); }
        else if (source.readyState === WebSocket.OPEN) source.resume();
      });
    });
    source.on("error", () => target.terminate());
    source.on("close", (code, reason) => {
      if (target.readyState === WebSocket.OPEN && ![1005, 1006, 1015].includes(code)) target.close(code, reason);
      else target.terminate();
    });
  }
  server.on("upgrade", async (req, socket, head) => {
    let upstream;
    const abort = () => { upstream?.terminate(); socket.destroy(); };
    socket.on("error", () => {});
    socket.once("close", abort);
    try {
      authorize(req);
      const path = apiPath(req.url, true);
      checkReady(); operations.add(abort);
      const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map(x => x.trim()).filter(Boolean);
      upstream = await connection.openStream({ path, headers: headersFor(req), protocols });
      track(upstream);
      if (invalid || socket.destroyed) return upstream.terminate();
      checkReady();
      req.selectedProtocol = upstream.protocol;
      wss.handleUpgrade(req, socket, head, client => {
        track(client); socket.removeListener("close", abort);
        bridge(client, upstream); bridge(upstream, client);
      });
    } catch (error) {
      upstream?.terminate();
      if (TERMINAL.has(error.code || error.message)) { invalidate(); error = fail("HOST_SESSION_EXPIRED"); }
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${error.status || 503} Rejected\r\nConnection: close\r\nContent-Length: 0\r\nX-Wanx-Error: ${error.status ? error.code : "HOST_UPSTREAM_UNAVAILABLE"}\r\n\r\n`);
    } finally { operations.delete(abort); }
  });
  function close() {
    if (closing) return closing;
    // Revoke before returning, so the launcher can terminate the child independently.
    invalidate(); unsubscribeConnection(); clearInterval(heartbeat);
    closing = Promise.all([
      new Promise(resolve => server.close(resolve)),
      new Promise(resolve => wss.close(resolve)),
    ]).then(() => {});
    server.closeAllConnections();
    return closing;
  }
  try {
    if (authorizeRelease) watchRelease(await authorizeRelease({ signal: releaseController.signal }));
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    url = `http://127.0.0.1:${server.address().port}`;
    unsubscribe = connection.subscribe?.(() => {
      try {
        const current = state();
        for (const res of events) res.write(`data: ${JSON.stringify({ type: "connection", connection: current.connection })}\n\n`);
      } catch { /* state() already revoked the lease. */ }
    });
    signal?.throwIfAborted();
    state();
    heartbeat = setInterval(() => { for (const res of events) res.write(": alive\n\n"); }, 10_000);
    heartbeat.unref();
    return Object.freeze({
      launchId,
      environment: Object.freeze({
        WANX_HOST_TOKEN: token,
        WANX_HOST_APPLICATION_ID: hostApplicationId,
        WANX_HOST_CLIENT_APPLICATION_ID: applicationId,
        WANX_HOST_LAUNCH_ID: launchId,
        WANX_HOST_PROTOCOL_VERSION: "1",
        WANX_HOST_INSTALL_ROOT: installPath,
        WANX_HOST_TRANSPORT: "http-v1",
        WANX_HOST_BASE_URL: url,
      }),
      assertLive: state,
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
