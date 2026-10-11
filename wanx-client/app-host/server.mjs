import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

const fail = (code) => Object.assign(new Error(code), { code });
const MAX_LINE = 48 * 1024 * 1024;

function safeMethod(method) {
  return typeof method === "string" && /^[a-z][a-z0-9._-]{1,63}$/.test(method);
}

export async function createApplicationHost({
  applicationId,
  isApplicationAllowed,
  capabilitiesFor,
  context,
  request,
  openStream,
  closeSession,
  socketPath,
  token = randomBytes(32).toString("hex"),
} = {}) {
  if (typeof applicationId !== "string" || !applicationId) throw new TypeError("applicationId is required");
  if (typeof context !== "function") throw new TypeError("context is required");
  const endpoint = socketPath || (process.platform === "win32"
    ? `\\\\.\\pipe\\wanx-app-${randomUUID()}`
    : `/tmp/wanx-app-${randomUUID()}.sock`);
  const server = net.createServer();
  const connections = new Map();
  let closed = false;

  async function dispatch(message, state) {
    const allowed = isApplicationAllowed
      ? isApplicationAllowed(message?.applicationId, message?.launchId, message?.token) &&
        (isApplicationAllowed.length >= 3 || message?.token === token)
      : message?.applicationId === applicationId && message?.token === token;
    if (!message || !allowed) throw fail("APPLICATION_IPC_UNAUTHORIZED");
    state.launchId = message.launchId;
    if (!safeMethod(message.method)) throw fail("APPLICATION_IPC_METHOD_INVALID");
    const capabilities = capabilitiesFor?.(message.applicationId, message.launchId) || [];
    if (message.method === "context.get") return context(message.applicationId, message.launchId);
    if (message.method === "identity.get") {
      if (!capabilities.includes("identity.read")) throw fail("APPLICATION_CAPABILITY_DENIED");
      return { ...(await context(message.applicationId, message.launchId)), identityOnly: true };
    }
    if (["http.request", "http.stream"].includes(message.method)) {
      if (!capabilities.includes("http.request")) throw fail("APPLICATION_CAPABILITY_DENIED");
      if (typeof request !== "function") throw fail("APPLICATION_REQUEST_UNAVAILABLE");
      const path = message.params?.path;
      if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("\\") || path.includes("//"))
        throw fail("APPLICATION_PATH_NOT_ALLOWED");
      let body = message.params?.body;
      if (message.params?.bodyEncoding === "base64") {
        if (typeof body !== "string") throw fail("APPLICATION_BODY_INVALID");
        try { body = Buffer.from(body, "base64"); } catch { throw fail("APPLICATION_BODY_INVALID"); }
      } else if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body)) {
        body = JSON.stringify(body);
      }
      const response = await request({
        path,
        method: message.params?.method || "GET",
        body,
        headers: message.params?.headers,
        signal: state.controller.signal,
        stream: message.method === "http.stream",
      }, message.applicationId, message.launchId);
      if (message.method === "http.stream") return { httpStream: response };
      return {
        ...response,
        ...(Buffer.isBuffer(response?.body) ? { body: response.body.toString("base64") } : {}),
      };
    }
    if (message.method === "stream.open") {
      if (!capabilities.includes("chat.stream")) throw fail("APPLICATION_CAPABILITY_DENIED");
      if (typeof openStream !== "function") throw fail("APPLICATION_STREAM_UNAVAILABLE");
      const path = message.params?.path;
      if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("\\") || path.includes("//"))
        throw fail("APPLICATION_PATH_NOT_ALLOWED");
      const upstream = await openStream({
        path,
        headers: message.params?.headers,
        protocols: message.params?.protocols,
      }, message.applicationId, message.launchId);
      if (state.controller.signal.aborted) { upstream.close(); throw fail("APPLICATION_SESSION_CLOSED"); }
      const streamId = randomUUID();
      state.streams.set(streamId, upstream);
      upstream.on("message", (data, binary) => {
        state.send({
          type: "stream.message",
          streamId,
          data: Buffer.from(data).toString("base64"),
          binary: Boolean(binary),
        });
      });
      upstream.on("error", () => state.send({ type: "stream.error", streamId }));
      upstream.on("close", (code, reason) => {
        state.streams.delete(streamId);
        state.send({
          type: "stream.close",
          streamId,
          code: Number.isInteger(code) ? code : 1000,
          reason: Buffer.from(reason || "").toString("base64"),
        });
      });
      return { streamId };
    }
    if (message.method === "stream.send") {
      if (!capabilities.includes("chat.stream")) throw fail("APPLICATION_CAPABILITY_DENIED");
      const stream = state.streams.get(message.params?.streamId);
      const data = message.params?.data;
      if (!stream || typeof data !== "string") throw fail("APPLICATION_STREAM_INVALID");
      stream.send(Buffer.from(data, "base64"), { binary: Boolean(message.params?.binary) });
      return { sent: true };
    }
    if (message.method === "stream.close") {
      if (!capabilities.includes("chat.stream")) throw fail("APPLICATION_CAPABILITY_DENIED");
      const stream = state.streams.get(message.params?.streamId);
      if (stream) {
        state.streams.delete(message.params.streamId);
        stream.close();
      }
      return { closed: true };
    }
    if (message.method === "session.close") {
      for (const stream of state.streams.values()) stream.close();
      state.streams.clear();
      await closeSession?.(message.applicationId, message.launchId);
      return { closed: true };
    }
    throw fail("APPLICATION_IPC_METHOD_NOT_ALLOWED");
  }

  server.on("connection", (socket) => {
    socket.once("close", () => connections.delete(socket));
    let buffer = "";
    const state = {
      streams: new Map(),
      controller: new AbortController(),
      send(value) {
        if (!socket.destroyed) {
          if (socket.writableLength > MAX_LINE) return socket.destroy();
          socket.write(JSON.stringify(value) + "\n");
        }
      },
    };
    connections.set(socket, state);
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.once("close", () => {
      state.controller.abort();
      for (const stream of state.streams.values()) stream.close();
      state.streams.clear();
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) { socket.destroy(); return; }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.write(JSON.stringify({ error: "APPLICATION_IPC_INVALID_JSON" }) + "\n"); continue; }
        void dispatch(message, state).then(async (value) => {
          if (!value?.httpStream) return state.send({ id: message.id, ok: true, value });
          const response = value.httpStream;
          state.send({ id: message.id, ok: true, value: { status: response.status, headers: response.headers } });
          const body = Buffer.isBuffer(response.body) ? [response.body] : response.body;
          try {
            for await (const bytes of body) {
              for (let offset = 0; offset < bytes.length; offset += 65536) {
                if (socket.destroyed) throw fail("APPLICATION_SESSION_CLOSED");
                const data = Buffer.from(bytes.subarray(offset, offset + 65536)).toString("base64");
                await new Promise((resolve, reject) => socket.write(JSON.stringify({ type: "http.data", data }) + "\n", (error) => error ? reject(error) : resolve()));
              }
            }
            state.send({ type: "http.end" });
          } catch { state.send({ type: "http.error" }); }
        }).catch((error) => state.send({ id: message.id, ok: false, error: error.code || "APPLICATION_IPC_FAILED" }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  return Object.freeze({
    endpoint,
    token,
    revoke(launchId) {
      for (const [socket, state] of connections) if (state.launchId === launchId) socket.destroy();
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of connections.keys()) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (process.platform !== "win32") await rm(endpoint, { force: true });
    },
  });
}
