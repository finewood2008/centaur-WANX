import http from "node:http";
import { dashboardRoutes } from "./dashboard-routes.mjs";
import { serveMaintenanceAsset } from "./maintenance-assets.mjs";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { validAssetManifest } from "./static-cache.mjs";
import { WebSocket, WebSocketServer } from "ws";

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_SOCKET_BYTES = 16 * 1024 * 1024;
const TOKEN_QUERY_FIELDS = ["token", "access_token"];
const PROFILE_ROUTES = new Set([
  "GET /api/auth/me",
  "PATCH /api/auth/me",
  "POST /api/auth/me/avatar",
  "DELETE /api/auth/me/avatar",
]);

function headersWithoutHop(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(headers.connection ?? "").split(",")) {
    blocked.add(name.trim().toLowerCase());
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !blocked.has(name)),
  );
}

function reject(response, status, message) {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(message);
}

/**
 * One selected box, one temporary loopback origin. Callers validate target trust
 * and give each box an isolated browser session (cookies ignore TCP ports).
 * Platform mode holds a box-session provider in main and gives the renderer only
 * an opaque per-gateway marker; direct mode forwards existing box credentials.
 */
export async function createDashboardGateway({
  targetURL,
  agent,
  session,
  staticCache,
  cacheScope,
}) {
  const target = new URL(targetURL);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error("INVALID_TARGET_URL");
  }
  const applicationExchangePath = session?.applicationExchangePath === "/api/auth/application/exchange"
    ? "/api/auth/application/exchange" : "/api/auth/platform/application";
  const marker = session ? randomBytes(32).toString("hex") : null;
  const bootstrapPath = session
    ? `/__wanx_session/${randomBytes(32).toString("hex")}`
    : null;
  let bootstrapped = false;
  if (session && !session.getToken())
    throw new Error("PLATFORM_SESSION_EXPIRED");
  const transport = target.protocol === "https:" ? https : http;
  const connections = new Set();
  const requests = new Set();
  const sockets = new Set();
  let closed = false;
  let localURL;
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_SOCKET_BYTES,
    perMessageDeflate: false,
    handleProtocols: (_protocols, request) => request.selectedProtocol || false,
  });

  function allowed(request) {
    if (closed || request.headers.host !== localURL.host) return false;
    if (request.headers.origin && request.headers.origin !== localURL.origin)
      return false;
    if (["cross-site", "same-site"].includes(request.headers["sec-fetch-site"]))
      return false;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers.origin !== localURL.origin
    )
      return false;
    // Always origin-form: never let a request choose a different upstream.
    return /^\/(?!\/)/.test(request.url) && !request.url.includes("\\");
  }

  function upstreamHeaders(request) {
    const headers = headersWithoutHop(request.headers);
    headers.host = target.host;
    delete headers.forwarded;
    for (const name of Object.keys(headers)) {
      if (name.startsWith("x-forwarded-") || name.startsWith("sec-websocket-"))
        delete headers[name];
    }
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer?.startsWith(`${localURL.origin}/`)) {
      headers.referer =
        target.origin + headers.referer.slice(localURL.origin.length);
    }
    return headers;
  }

  function authorize(request, websocket = false, applicationExchange = false) {
    if (!session)
      return { path: request.url, headers: upstreamHeaders(request) };
    const endpoint = new URL(request.url, localURL);
    let pathname;
    try {
      pathname = decodeURIComponent(endpoint.pathname);
    } catch {
      return null;
    }
    // Reject alternate encodings and slash spellings before the backend router.
    if (pathname.includes("\\") || pathname.includes("//")) return null;
    if (
      (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) &&
      (websocket || (!PROFILE_ROUTES.has(`${request.method} ${pathname}`) &&
        !(applicationExchange && request.method === "POST" && pathname === applicationExchangePath)))
    )
      return null;
    const headerToken = request.headers.authorization;
    const queryTokens = TOKEN_QUERY_FIELDS.flatMap((field) =>
      endpoint.searchParams.getAll(field),
    );
    if (
      (headerToken && headerToken !== `Bearer ${marker}`) ||
      queryTokens.some((value) => value !== marker)
    )
      return null;
    const needsToken =
      websocket || (pathname.startsWith("/api/") && pathname !== "/api/health");
    if (needsToken && (!bootstrapped || (!headerToken && !queryTokens.length)))
      return null;
    const token = session.getToken();
    if (!token) return null;
    const headers = upstreamHeaders(request);
    // Cookie auth belongs to direct mode; platform mode uses only its current lease.
    delete headers.cookie;
    if (headerToken || queryTokens.length)
      headers.authorization = `Bearer ${token}`;
    for (const field of TOKEN_QUERY_FIELDS) {
      if (endpoint.searchParams.has(field))
        endpoint.searchParams.set(field, token);
    }
    return { path: endpoint.pathname + endpoint.search, headers, token };
  }

  let assetManifest = null;
  // Metadata travels through the same trusted box tunnel and requires a live
  // platform session. Old boxes simply continue through the streaming proxy.
  if (staticCache && session && cacheScope?.accountId && cacheScope?.boxId) {
    const manifestRequest = transport.request(target, {
      method: "GET",
      path: "/api/platform/assets/manifest",
      agent: agent ?? false,
      headers: {
        authorization: `Bearer ${session.getToken()}`,
        "accept-encoding": "identity",
      },
    });
    requests.add(manifestRequest);
    const timeout = setTimeout(() => manifestRequest.destroy(), 1500);
    timeout.unref();
    manifestRequest.once("close", () => {
      clearTimeout(timeout);
      requests.delete(manifestRequest);
    });
    manifestRequest.on("error", () => {});
    manifestRequest.on("response", (incoming) => {
      if (incoming.statusCode !== 200) return incoming.resume();
      let length = 0;
      const chunks = [];
      incoming.on("error", () => {});
      incoming.on("data", (chunk) => {
        length += chunk.length;
        if (length > 512 * 1024) return incoming.destroy();
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!closed && session.getToken() && validAssetManifest(parsed))
            assetManifest = parsed;
        } catch {
          /* unsupported or invalid catalog: no cache */
        }
      });
    });
    manifestRequest.end();
  }

  const server = http.createServer(async (request, response) => {
    if (!allowed(request))
      return reject(response, 403, "Gateway request rejected");
    if (session && request.url.startsWith("/__wanx_session/")) {
      if (
        request.url !== bootstrapPath ||
        request.method !== "GET" ||
        !session.getToken()
      )
        return reject(response, 404, "Not found");
      const nonce = randomBytes(24).toString("base64");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
        "x-content-type-options": "nosniff",
      });
      bootstrapped = true;
      response.end(
        `<!doctype html><meta charset="utf-8"><script nonce="${nonce}">localStorage.removeItem("auth_token");sessionStorage.setItem("auth_token",${JSON.stringify(
          marker,
        )});const destination=location.hash.slice(1);location.replace(${JSON.stringify(Object.values(dashboardRoutes))}.includes(destination)?destination:"/");</script>`,
      );
      return;
    }
    if (new URL(request.url, localURL).pathname.startsWith("/__wanx_tools/")) {
      if (session && !bootstrapped) return reject(response, 401, "Platform session required");
      await serveMaintenanceAsset(request, response, localURL.origin);
      return;
    }
    const authorized = authorize(request);
    if (!authorized) return reject(response, 401, "Platform session required");
    const cachePath = request.url;
    const cacheable =
      staticCache &&
      session &&
      assetManifest &&
      bootstrapped &&
      ["GET", "HEAD"].includes(request.method) &&
      !request.headers.range &&
      !request.headers["service-worker"] &&
      assetManifest.assets[cachePath];
    // Cached bytes are stored decoded. Respect a caller that forbids identity.
    const encodings = String(
      request.headers["accept-encoding"] || "",
    ).toLowerCase();
    const identityForbidden =
      /(?:^|,)\s*identity\s*;\s*q=0(?:\.0*)?\s*(?:,|$)/.test(encodings) ||
      (!/(?:^|,)\s*identity(?:\s*;|\s*,|$)/.test(encodings) &&
        /(?:^|,)\s*\*\s*;\s*q=0(?:\.0*)?\s*(?:,|$)/.test(encodings));
    if (cacheable && !identityForbidden) {
      const hit = await staticCache
        .get(cacheScope, assetManifest, cachePath)
        .catch(() => null);
      if (closed || response.destroyed) return;
      if (!session.getToken())
        return reject(response, 401, "Platform session required");
      if (hit) {
        const headers = {
          "content-type": hit.contentType,
          etag: hit.etag,
          "cache-control": "private, no-cache",
          vary: "Accept-Encoding",
          "x-content-type-options": "nosniff",
        };
        const validators = String(request.headers["if-none-match"] || "")
          .split(",")
          .map((value) => value.trim().replace(/^W\//, ""));
        if (validators.includes(hit.etag) || validators.includes("*")) {
          response.writeHead(304, headers);
          return response.end();
        }
        response.writeHead(200, {
          ...headers,
          "content-length": hit.data.length,
        });
        return response.end(request.method === "HEAD" ? undefined : hit.data);
      }
    }
    const upstream = transport.request(target, {
      method: request.method,
      path: authorized.path,
      headers: authorized.headers,
      agent: agent ?? false,
    });
    requests.add(upstream);
    upstream.once("close", () => requests.delete(upstream));
    // Bound connection establishment, not upload/download or idle SSE duration.
    const connectTimer = setTimeout(
      () => upstream.destroy(new Error("CONNECT_TIMEOUT")),
      10_000,
    );
    connectTimer.unref();
    upstream.on("socket", (socket) => {
      const connected = () => clearTimeout(connectTimer);
      if (!socket.connecting) connected();
      else
        socket.once(
          target.protocol === "https:" ? "secureConnect" : "connect",
          connected,
        );
    });
    upstream.once("close", () => clearTimeout(connectTimer));
    upstream.on("error", () =>
      reject(response, 502, "Box connection unavailable"),
    );
    request.on("aborted", () => upstream.destroy());
    request.on("error", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    upstream.on("response", (incoming) => {
      const headers = headersWithoutHop(incoming.headers);
      if (session) {
        // Backend sliding JWT renewal must never overwrite the opaque renderer marker.
        delete headers["x-octop-access-token"];
        delete headers["set-cookie"];
      }
      if (headers.location) {
        let location;
        try {
          location = new URL(headers.location, new URL(request.url, target));
        } catch {
          /* reject below */
        }
        if (
          !location ||
          location.origin !== target.origin ||
          location.username ||
          location.password
        ) {
          incoming.destroy();
          return reject(
            response,
            502,
            "External box redirect is not supported",
          );
        }
        if (session) {
          const token = session.getToken();
          for (const field of TOKEN_QUERY_FIELDS) {
            if (location.searchParams.has(field))
              location.searchParams.set(field, marker);
          }
          if (token && location.href.includes(token)) {
            incoming.destroy();
            return reject(response, 502, "Invalid box redirect");
          }
        }
        headers.location =
          localURL.origin + location.pathname + location.search + location.hash;
      }
      if (headers["set-cookie"]) {
        headers["set-cookie"] = headers["set-cookie"].map((cookie) =>
          cookie.replace(/;\s*Domain=[^;]*/gi, ""),
        );
      }
      // A box cannot install a worker that outlives its connection in the client.
      if (request.headers["service-worker"] === "script") {
        incoming.destroy();
        return reject(
          response,
          403,
          "Service workers are disabled in the client",
        );
      }
      if (
        staticCache &&
        session &&
        bootstrapped &&
        assetManifest &&
        request.method === "GET" &&
        !request.headers.range &&
        session.getToken()
      ) {
        staticCache.capture(cacheScope, assetManifest, request.url, incoming);
      }
      response.writeHead(incoming.statusCode, headers);
      response.flushHeaders();
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    request.pipe(upstream);
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  function track(socket) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  }

  function bridge(source, destination, rewriteToken) {
    source.on("message", (data, binary) => {
      if (rewriteToken && !binary) {
        try {
          const message = JSON.parse(data.toString());
          if (message?.type === "start" && Object.hasOwn(message, "token")) {
            if (message.token !== marker)
              throw new Error("INVALID_FRAME_TOKEN");
            message.token = rewriteToken;
            data = Buffer.from(JSON.stringify(message));
          }
        } catch (error) {
          if (error.message === "INVALID_FRAME_TOKEN") {
            source.close(1008, "Invalid credentials");
            destination.terminate();
            return;
          }
        }
      }
      if (
        destination.readyState !== WebSocket.OPEN ||
        destination.bufferedAmount + data.length > MAX_SOCKET_BYTES
      ) {
        source.terminate();
        destination.terminate();
        return;
      }
      source.pause();
      destination.send(data, { binary }, (error) => {
        if (error) {
          source.terminate();
          destination.terminate();
        } else if (source.readyState === WebSocket.OPEN) source.resume();
      });
    });
    source.on("error", () => destination.terminate());
    source.on("close", (code, reason) => {
      if (destination.readyState === WebSocket.OPEN) {
        if (code === 1005 || code === 1006 || code === 1015)
          destination.terminate();
        else destination.close(code, reason);
      } else if (destination.readyState === WebSocket.CONNECTING)
        destination.terminate();
    });
  }

  server.on("upgrade", (request, socket, head) => {
    if (!allowed(request) || request.headers.origin !== localURL.origin) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    // Desktop/mobile streaming authenticates in its first start frame, not its URL.
    // Wait for the renderer marker before contacting the selected box.
    if (
      session &&
      ["/api/desktop-stream/ws", "/api/mobile-stream/ws"].includes(
        request.url,
      ) &&
      !request.headers.authorization &&
      bootstrapped
    ) {
      try {
        webSockets.handleUpgrade(request, socket, head, (client) => {
          track(client);
          const timeout = setTimeout(
            () => client.close(1008, "Authentication required"),
            5000,
          );
          timeout.unref();
          client.once("close", () => clearTimeout(timeout));
          client.once("error", () => clearTimeout(timeout));
          client.once("message", (data, binary) => {
            clearTimeout(timeout);
            let message;
            try {
              message = !binary && JSON.parse(data.toString());
            } catch {}
            if (message?.type !== "start" || message.token !== marker) {
              client.close(1008, "Invalid credentials");
              return;
            }
            client.pause();
            request.headers.authorization = `Bearer ${marker}`;
            const authorized = authorize(request, true);
            if (!authorized) return client.close(1008, "Session expired");
            const endpoint = new URL(target);
            endpoint.protocol = target.protocol === "https:" ? "wss:" : "ws:";
            let upstream;
            try {
              upstream = new WebSocket(endpoint.origin + authorized.path, {
                headers: authorized.headers,
                origin: target.origin,
                handshakeTimeout: 10000,
                maxPayload: MAX_SOCKET_BYTES,
                perMessageDeflate: false,
                followRedirects: false,
                agent: agent ?? false,
              });
            } catch {
              client.terminate();
              return;
            }
            track(upstream);
            client.once("close", () => upstream.terminate());
            client.once("error", () => upstream.terminate());
            upstream.on("error", () => client.terminate());
            const abortBeforeOpen = () => client.terminate();
            upstream.once("close", abortBeforeOpen);
            upstream.once("open", () => {
              upstream.removeListener("close", abortBeforeOpen);
              if (closed || client.readyState !== WebSocket.OPEN)
                return upstream.terminate();
              bridge(client, upstream, authorized.token);
              bridge(upstream, client);
              upstream.send(
                JSON.stringify({ ...message, token: authorized.token }),
                (error) => {
                  if (error) client.terminate();
                  else if (client.readyState === WebSocket.OPEN)
                    client.resume();
                },
              );
            });
          });
        });
      } catch {
        socket.destroy();
      }
      return;
    }
    const authorized = authorize(request, true);
    if (!authorized) {
      socket.end(
        "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const endpoint = new URL(target);
    endpoint.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    let upstream;
    try {
      upstream = new WebSocket(endpoint.origin + authorized.path, protocols, {
        headers: authorized.headers,
        origin: target.origin,
        handshakeTimeout: 10_000,
        maxPayload: MAX_SOCKET_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
        agent: agent ?? false,
      });
    } catch {
      socket.destroy();
      return;
    }
    track(upstream);
    const abort = () => upstream.terminate();
    socket.once("close", abort);
    upstream.on("error", () => socket.destroy());
    upstream.once("open", () => {
      if (closed || socket.destroyed) return upstream.terminate();
      request.selectedProtocol = upstream.protocol;
      try {
        webSockets.handleUpgrade(request, socket, head, (client) => {
          track(client);
          socket.removeListener("close", abort);
          bridge(client, upstream, authorized.token);
          bridge(upstream, client);
        });
      } catch {
        upstream.terminate();
        socket.destroy();
      }
    });
  });

  await new Promise((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolve();
    });
  });
  localURL = new URL(`http://127.0.0.1:${server.address().port}`);
  const applicationTokens = new Map();
  async function scopedAuthorization(authorized, applicationScope) {
    if (!applicationScope) return authorized;
    if (!session || !authorized?.token)
      throw Object.assign(new Error("BOX_APPLICATION_PLATFORM_SESSION_REQUIRED"), { code: "BOX_APPLICATION_PLATFORM_SESSION_REQUIRED" });
    if (applicationScope !== "super-advisory")
      throw Object.assign(new Error("BOX_APPLICATION_SCOPE_FORBIDDEN"), { code: "BOX_APPLICATION_SCOPE_FORBIDDEN" });
    const parent = authorized.token;
    let cached = applicationTokens.get(applicationScope);
    if (!cached || cached.parent !== parent || cached.renewAt <= Date.now()) {
      const pending = gateway.request({ path: applicationExchangePath, method: "POST",
        headers: { "content-type": "application/json" }, body: { application_id: applicationScope },
        applicationExchange: true }).then(response => {
        let value;
        try { value = JSON.parse(response.body.toString("utf8")); } catch { /* invalid response */ }
        if (response.status !== 200 || typeof value?.access_token !== "string" || !value.access_token ||
            value.token_type !== "Bearer" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 ||
            value.user?.application_id !== applicationScope) {
          const code = ["BOX_APPLICATION_RUNTIME_UPDATE_REQUIRED", "BOX_APPLICATION_ACCESS_DENIED", "BOX_APPLICATION_SCOPE_FORBIDDEN"].includes(value?.code)
            ? value.code : "BOX_APPLICATION_SESSION_INVALID";
          throw Object.assign(new Error(code), { code });
        }
        return { token: value.access_token, expiresAt: Date.now() + value.expires_in * 1000 };
      });
      cached = { parent, renewAt: Infinity, pending };
      applicationTokens.set(applicationScope, cached);
      pending.then(value => { cached.renewAt = Date.now() + Math.max(1000, (value.expiresAt - Date.now()) / 2); },
        () => { if (applicationTokens.get(applicationScope) === cached) applicationTokens.delete(applicationScope); });
    }
    const value = await cached.pending;
    if (closed || !session.getToken()) throw new Error("PLATFORM_SESSION_EXPIRED");
    // Never send a scoped credential obtained while a different parent was current.
    // This is before the business request; the caller may retry after renewal.
    if (session.getToken() !== parent) throw Object.assign(new Error("NETWORK_NOT_READY"), { code: "NETWORK_NOT_READY" });
    const endpoint = new URL(authorized.path, target);
    for (const field of TOKEN_QUERY_FIELDS) if (endpoint.searchParams.has(field)) endpoint.searchParams.set(field, value.token);
    return { path: endpoint.pathname + endpoint.search, token: value.token,
      headers: { ...authorized.headers, authorization: `Bearer ${value.token}` } };
  }
  let closing;
  const gateway = {
    url: localURL.origin + (bootstrapPath ?? ""),
    origin: localURL.origin,
    // Same immutable box origin and authentication scope. Main has obtained a
    // fresh grant; keep the loopback URL/opaque marker and existing app leases.
    replaceTransport(next) {
      if (closed) throw new Error("GATEWAY_CLOSED");
      const nextPath = next.session?.applicationExchangePath === "/api/auth/application/exchange"
        ? "/api/auth/application/exchange" : "/api/auth/platform/application";
      if (Boolean(next.session) !== Boolean(session) || nextPath !== applicationExchangePath ||
          next.session && !next.session.getToken()) throw new Error("PLATFORM_SESSION_EXPIRED");
      unsubscribeExpiry?.();
      const previous = session;
      agent = next.agent;
      session = next.session;
      applicationTokens.clear();
      for (const upstream of requests) upstream.destroy();
      for (const socket of sockets) socket.terminate();
      unsubscribeExpiry = session?.onExpired?.(onSessionExpired);
      if (previous !== session) previous?.close();
    },
    async request({ path, method = "GET", headers = {}, body, signal, stream = false, applicationScope, applicationExchange = false, idleTimeoutMs = 0, freshConnection = false } = {}) {
      if (closed) throw new Error("GATEWAY_CLOSED");
      if (typeof path !== "string" || !path.startsWith("/")) throw new Error("INVALID_GATEWAY_PATH");
      const request = {
        method,
        url: path,
        headers: {
          host: localURL.host,
          origin: localURL.origin,
          ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]).filter(([key,value]) => ["accept", "accept-language", "content-type", "x-octop-agent-id", "x-wanx-metering-session", "x-content-sha256", "range", "if-none-match", "if-modified-since"].includes(key) || (key === "x-space-link" && ["/api/personal-space/agent-access", "/api/personal-space/connection-access", "/api/clipboard/v1/agent-access"].includes(path.split("?")[0])) || (key === "x-wanx-data-context" && /^\/api\/semantica\//.test(path.split("?")[0]) && ["team","personal"].includes(value)) || (key === "x-xingtu-key" && /^\/api\/semantica\/open\/v1\//.test(path.split("?")[0])))),
          ...(session ? { authorization: `Bearer ${marker}` } : {}),
        },
      };
      const wasBootstrapped = bootstrapped;
      if (session) bootstrapped = true;
      let authorized = authorize(request, false, applicationExchange);
      bootstrapped = wasBootstrapped;
      if (authorized) authorized = await scopedAuthorization(authorized, applicationScope);
      if (!authorized) throw new Error("PLATFORM_SESSION_EXPIRED");
      // Bulk chunks must not reuse a control request's potentially stale tunnel.
      // Delegate dialing to the same authorized transport; never bypass P2P or TLS.
      const dedicatedAgent = freshConnection && agent ? new transport.Agent({ ...agent.options, keepAlive: false }) : null;
      if (dedicatedAgent) dedicatedAgent.createConnection = agent.createConnection.bind(agent);
      const upstream = transport.request(target, {
        method,
        path: authorized.path,
        // Keep the read side alive for a business response during an upload.
        headers: { ...authorized.headers, connection: freshConnection ? "close" : "keep-alive" },
        agent: dedicatedAgent ?? agent ?? false,
        signal,
      });
      requests.add(upstream);
      if (dedicatedAgent) upstream.once("close", () => dedicatedAgent.destroy());
      // Only callers with an idempotent recovery protocol opt into this. This
      // measures the local transport, not acknowledgement by the remote box.
      let transportPhase = "connecting", socket, written = 0, received = 0;
      const diagnostic = () => ({ transportPhase, requestBytes: socket ? Math.max(0, socket.bytesWritten - written) : 0, responseBytes: received, reusedSocket: upstream.reusedSocket === true });
      if (Number.isSafeInteger(idleTimeoutMs) && idleTimeoutMs > 0) {
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy(Object.assign(new Error("SPACE_CHUNK_STALLED"), { code: "SPACE_CHUNK_STALLED", ...diagnostic() })));
      }
      upstream.once("finish", () => { transportPhase = "awaiting_response"; });
      upstream.once("close", () => requests.delete(upstream));
      const timer = setTimeout(() => upstream.destroy(new Error("CONNECT_TIMEOUT")), 10_000);
      timer.unref();
      upstream.on("socket", (value) => {
        socket = value; written = socket.bytesWritten;
        const connected = () => { clearTimeout(timer); transportPhase = "sending"; };
        if (!socket.connecting) connected();
        else socket.once(target.protocol === "https:" ? "secureConnect" : "connect", connected);
      });
      upstream.once("close", () => clearTimeout(timer));
      return new Promise((resolve, rejectRequest) => {
        const uploading = body && typeof body.pipe === "function";
        const stopUpload = () => {
          if (uploading) {
            body.unpipe(upstream); body.pause();
            if (!upstream.destroyed && !upstream.writableEnded) upstream.end();
          }
        };
        const uploadError = error => upstream.destroy(error);
        if (uploading) body.once("error", uploadError);
        upstream.once("close", () => {
          stopUpload();
          if (uploading) body.removeListener("error", uploadError);
        });
        upstream.on("response", (response) => {
          transportPhase = "receiving";
          response.once("end", () => { upstream.setTimeout(0); });
          response.once("end", stopUpload);
          if (response.statusCode >= 400) stopUpload();
          const headers = headersWithoutHop(response.headers);
          delete headers["set-cookie"];
          delete headers["x-octop-access-token"];
          // Redirects may carry credentials in their destination. Apps never follow them.
          delete headers.location;
          const result = { status: response.statusCode || 502, headers };
          response.on("error", rejectRequest);
          if (stream) return resolve({ ...result, body: response });
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            received += chunk.length;
            size += chunk.length;
            if (size > 32 * 1024 * 1024) return response.destroy(new Error("RESPONSE_TOO_LARGE"));
            chunks.push(chunk);
          });
          response.on("end", () => resolve({ ...result, body: Buffer.concat(chunks) }));
        });
        upstream.on("error", rejectRequest);
        if (uploading) { body.pipe(upstream); return; }
        if (body !== undefined) upstream.write(
          Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body),
        );
        upstream.end();
      });
    },
    async openWebSocket({ path, headers = {}, protocols = [], applicationScope } = {}) {
      if (closed) throw new Error("GATEWAY_CLOSED");
      if (typeof path !== "string" || !path.startsWith("/")) throw new Error("INVALID_GATEWAY_PATH");
      const request = {
        method: "GET",
        url: path,
        headers: {
          host: localURL.host,
          origin: localURL.origin,
          ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]).filter(([key]) => ["accept", "accept-language", "content-type", "x-octop-agent-id", "x-wanx-metering-session"].includes(key))),
          ...(session ? { authorization: `Bearer ${marker}` } : {}),
        },
      };
      const wasBootstrapped = bootstrapped;
      if (session) bootstrapped = true;
      let authorized = authorize(request, true);
      bootstrapped = wasBootstrapped;
      if (authorized) authorized = await scopedAuthorization(authorized, applicationScope);
      if (!authorized) throw new Error("PLATFORM_SESSION_EXPIRED");
      const endpoint = new URL(target);
      endpoint.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const upstreamPath = new URL(authorized.path, target);
      if (upstreamPath.pathname !== "/api/browser-stream/ws" && authorized.token && !upstreamPath.searchParams.has("token") && !upstreamPath.searchParams.has("access_token"))
        upstreamPath.searchParams.set("token", authorized.token);
      const socket = new WebSocket(endpoint.origin + upstreamPath.pathname + upstreamPath.search, protocols, {
        headers: authorized.headers,
        origin: target.origin,
        handshakeTimeout: 10_000,
        maxPayload: MAX_SOCKET_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
        agent: agent ?? false,
      });
      track(socket);
      await new Promise((resolve, rejectSocket) => {
        const failSocket = (error) => {
          socket.terminate();
          rejectSocket(error);
        };
        socket.once("open", () => {
          // Consumers attach handlers after awaiting this method. Preserve frames
          // delivered in the same TCP packet as the upgrade response.
          socket.pause();
          resolve();
          setImmediate(() => { if (socket.readyState === WebSocket.OPEN) socket.resume(); });
        });
        socket.once("error", failSocket);
        socket.once("close", () => rejectSocket(new Error("BOX_STREAM_CLOSED")));
      });
      return socket;
    },
    close() {
      if (closing) return closing;
      closed = true;
      unsubscribeExpiry?.();
      session?.close();
      closing = new Promise((resolve) => {
        server.close(resolve);
        for (const upstream of requests) upstream.destroy();
        for (const socket of sockets) socket.terminate();
        for (const connection of connections) connection.destroy();
        webSockets.close();
      });
      return closing;
    },
  };
  function onSessionExpired(reason) {
    if (reason === "expired") {
      // Expired tokens authorize nothing. Keep only the local origin while main
      // obtains a fresh session; interrupted operations are never replayed.
      applicationTokens.clear();
      for (const upstream of requests) upstream.destroy();
      for (const socket of sockets) socket.terminate();
    } else void gateway.close();
  }
  let unsubscribeExpiry = session?.onExpired?.(onSessionExpired);
  return gateway;
}
