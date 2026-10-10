import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import { operationRegistry } from "centaurai-wanx";

// Only frozen SDK operations may reach the selected box. No arbitrary URL proxy.
const blockedAuth =
  /^\/api\/(?:auth\/(?!me(?:\/|$)|logout$|change-password$)|setup\/(?!status$))/;
const operations = operationRegistry
  .filter((op) => !blockedAuth.test(op.path))
  .map((op) => ({
    ...op,
    pattern: new RegExp(
      "^" +
        op.path.replace(/\{([^}]+)\}/g, (_, name) =>
          name === "file_path" ? "(.+)" : "([^/]+)",
        ) +
        "$",
    ),
    names: [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]),
  }));
const credentialHeader =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-nexus.*|x-octop-access-token)$/i;
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
export function requestInput(method, url, headers, body) {
  const op = operations.find(
    (candidate) =>
      candidate.method === method && candidate.pattern.test(url.pathname),
  );
  if (!op) throw new Error("OPERATION_NOT_ALLOWED");
  const match = url.pathname.match(op.pattern);
  const path = Object.fromEntries(
    op.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]),
  );
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (["token", "access_token"].includes(key)) continue; // local session nonce, never forwarded
    if (key === "as_user") throw new Error("PUBLIC_CREDENTIAL_OVERRIDE");
    query[key] =
      key in query
        ? [...(Array.isArray(query[key]) ? query[key] : [query[key]]), value]
        : value;
  }
  const header = Object.fromEntries(
    Object.entries(headers).filter(([key]) =>
      ["accept-language", "x-octop-agent-id"].includes(key.toLowerCase()),
    ),
  );
  return {
    op,
    input: { path, query, header, ...(body === undefined ? {} : { body }) },
  };
}
export function socketInput(url) {
  const query = Object.fromEntries(
    [...url.searchParams].filter(
      ([name]) => !["token", "access_token"].includes(name),
    ),
  );
  if ("as_user" in query) throw new Error("PUBLIC_CREDENTIAL_OVERRIDE");
  const agent = url.pathname.match(
    /^\/api\/agents\/([^/]+)\/(chat|terminal)\/ws$/,
  );
  if (agent)
    return { endpoint: agent[2], agentId: decodeURIComponent(agent[1]), query };
  const endpoints = {
    "/api/notifications/ws": "notifications",
    "/api/browser-stream/ws": "browser-stream",
    "/api/desktop-stream/ws": "desktop-stream",
    "/api/mobile-stream/ws": "mobile-stream",
    "/api/mobile/adb/shell/ws": "mobile-adb-shell",
  };
  if (!endpoints[url.pathname]) throw new Error("SOCKET_NOT_ALLOWED");
  return { endpoint: endpoints[url.pathname], query };
}
export function cleanFrame(text, sessionId) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (value && typeof value === "object")
    for (const name of ["token", "access_token"]) {
      if (name in value) {
        if (value[name] !== sessionId)
          throw new Error("PUBLIC_CREDENTIAL_OVERRIDE");
        delete value[name];
      }
    }
  return JSON.stringify(value);
}
export async function startGateway({ service, directory }) {
  let origin;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
  });
  const root = resolve(directory);
  // Allow only the inline boot scripts shipped in our own dashboard bundle.
  const index = await readFile(resolve(root, "index.html"), "utf8");
  const bootHashes = [
    ...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi),
  ]
    .filter((match) => !/\bsrc\s*=/.test(match[1]) && match[2].trim())
    .map(
      (match) =>
        `'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`,
    )
    .join(" ");
  const authenticate = (request, url) => {
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new Error("UNTRUSTED_ORIGIN");
    const sessionId =
      request.headers.authorization?.replace(/^Bearer /, "") ||
      url.searchParams.get("token") ||
      url.searchParams.get("access_token");
    service.requireCurrent(sessionId);
    return sessionId;
  };
  const server = http.createServer(async (request, reply) => {
    const controller = new AbortController();
    reply.on("close", () => controller.abort());
    let native;
    try {
      if (request.headers.host !== new URL(origin).host)
        throw new Error("UNTRUSTED_ORIGIN");
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith("/api/")) {
        const sessionId = authenticate(request, url);
        const parts = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new Error("REQUEST_BODY_TOO_LARGE");
          parts.push(chunk);
        }
        const bytes = Buffer.concat(parts);
        let body;
        if (bytes.length) {
          const contentType = request.headers["content-type"] || "";
          if (contentType.includes("json")) body = JSON.parse(bytes.toString());
          else if (contentType.includes("multipart/form-data"))
            body = await new Request("http://localhost", {
              method: "POST",
              headers: { "content-type": contentType },
              body: bytes,
            }).formData();
          else body = new Uint8Array(bytes);
        }
        const { op, input } = requestInput(
          request.method,
          url,
          request.headers,
          body,
        );
        const result = await service.stream(sessionId, op.operationId, input, {
          signal: controller.signal,
        });
        native = result.response;
        reply.writeHead(native.status, {
          ...Object.fromEntries(
            Object.entries(native.headers).filter(
              ([key]) =>
                !credentialHeader.test(key) &&
                ![
                  "content-length",
                  "transfer-encoding",
                  "connection",
                  "content-encoding",
                ].includes(key.toLowerCase()),
            ),
          ),
          "cache-control": "no-store",
        });
        for await (const chunk of native.chunks) {
          service.assertCurrent(result.context);
          if (!reply.write(chunk))
            await once(reply, "drain", { signal: controller.signal });
        }
        reply.end();
        if (url.pathname === "/api/auth/logout") await service.disconnect();
        return;
      }
      if (!["GET", "HEAD"].includes(request.method))
        throw new Error("OPERATION_NOT_ALLOWED");
      let file = resolve(root, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + sep) && file !== root)
        throw new Error("INVALID_PATH");
      if (!extname(file)) file = resolve(root, "index.html");
      const bytes = await readFile(file);
      reply.writeHead(200, {
        "content-type": mime[extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
        "content-security-policy": `default-src 'self'; script-src 'self' ${bootHashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'`,
        "x-content-type-options": "nosniff",
      });
      reply.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (reply.headersSent) reply.destroy();
      else {
        const code = /^[A-Z_]+$/.test(error.code || error.message)
          ? error.code || error.message
          : "REQUEST_FAILED";
        reply.writeHead(
          code === "REQUEST_BODY_TOO_LARGE"
            ? 413
            : code === "SESSION_CLOSED"
            ? 401
            : 403,
          { "content-type": "application/json", "cache-control": "no-store" },
        );
        reply.end(JSON.stringify({ code, message: code }));
      }
    } finally {
      await native?.close();
    }
  });
  server.on("upgrade", async (request, socket, head) => {
    let remote;
    const life = new AbortController();
    socket.once("close", () => life.abort());
    try {
      const url = new URL(request.url, origin);
      const sessionId = authenticate(request, url);
      const result = await service.socket(sessionId, socketInput(url), {
        signal: life.signal,
      });
      remote = result.socket;
      if (life.signal.aborted) {
        await remote.close();
        return;
      }
      wss.handleUpgrade(request, socket, head, (local) => {
        let sending = Promise.resolve();
        local.on("message", (data, binary) => {
          local.pause();
          sending = sending
            .then(async () => {
              service.assertCurrent(result.context);
              await remote.send(
                binary
                  ? { kind: "binary", bytes: new Uint8Array(data) }
                  : {
                      kind: "text",
                      text: cleanFrame(data.toString(), sessionId),
                    },
              );
              local.resume();
            })
            .catch(() => local.close(1008));
        });
        local.on("error", () => {
          void remote.close();
        });
        local.on("close", () => {
          life.abort();
          void remote.close();
        });
        void (async () => {
          try {
            for await (const frame of remote.frames) {
              service.assertCurrent(result.context);
              await new Promise((resolveSend, reject) =>
                local.send(
                  frame.kind === "text" ? frame.text : frame.bytes,
                  { binary: frame.kind === "binary" },
                  (error) => (error ? reject(error) : resolveSend()),
                ),
              );
            }
          } catch {
            /* Native closure is reflected in the computer client's state. */
          } finally {
            local.close(1000);
            await remote.close();
          }
        })();
      });
    } catch {
      await remote?.close();
      socket.destroy();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}
