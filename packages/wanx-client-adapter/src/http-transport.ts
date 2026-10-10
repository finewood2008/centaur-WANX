import WebSocket from "ws";
import { socketPath } from "./socket-path.js";
import { WanxError } from "./errors.js";
import type { ByteResponse, SocketFrame, WanxTransport } from "./types.js";

/** HTTP/LAN/HTTPS adapter for trusted Node hosts. P2P uses createCentaurAIWanxHost. */
export function createHTTPTransport(options: { baseURL: string; token?: () => Promise<string | null> }): WanxTransport {
  const base = new URL(options.baseURL);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) throw new WanxError("INVALID_BASE_URL");
  const life = new AbortController(); const sockets = new Set<WebSocket>();
  const resolve = (path: string) => { if (!path.startsWith("/api/") || /[\\\r\n\0]/u.test(path)) throw new WanxError("INVALID_RELATIVE_PATH"); return options.baseURL.replace(/\/$/u, "") + path; };
  return {
    capabilities: { httpUnary: true, httpResponseStream: true, websocketMessages: true, uploadStream: false, maxRequestBodyBytes: Number.MAX_SAFE_INTEGER, networkPath: "local-http" },
    async request(input, call = {}): Promise<ByteResponse> {
      if (life.signal.aborted) throw new WanxError("SESSION_CLOSED");
      const requestLife = new AbortController(); const signal = AbortSignal.any([life.signal, requestLife.signal, ...(call.signal ? [call.signal] : [])]);
      const headers = new Headers(input.headers); const token = await options.token?.(); if (token) headers.set("Authorization", "Bearer " + token);
      const response = await fetch(resolve(input.path), { method: input.method, headers, ...(input.body ? { body: new Uint8Array(input.body) } : {}), signal, redirect: "manual" });
      const reader = response.body?.getReader(); let closed = false;
      const close = async () => { if (closed) return; closed = true; requestLife.abort(); await reader?.cancel().catch(() => undefined); };
      return {
        status: response.status, headers: Object.fromEntries(response.headers),
        chunks: (async function* () { try { while (reader && !closed) { const chunk = await reader.read(); if (chunk.done) break; yield chunk.value; } } finally { await close(); } })(), close,
      };
    },
    async openSocket(input, call = {}) {
      if (life.signal.aborted) throw new WanxError("SESSION_CLOSED");
      const url = new URL(resolve(socketPath(input))); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const token = await options.token?.(); if (token) url.searchParams.set("token", token);
      const socket = new WebSocket(url, { followRedirects: false }); sockets.add(socket);
      const queue: SocketFrame[] = []; let bytes = 0, ended = false, error: Error | undefined; let wake: (() => void) | undefined;
      const signal = AbortSignal.any([life.signal, ...(call.signal ? [call.signal] : [])]);
      const abort = () => socket.terminate(); signal.addEventListener("abort", abort, { once: true });
      const ready = new Promise<void>((resolveReady, reject) => { socket.once("open", resolveReady); socket.once("error", () => reject(new WanxError("WEBSOCKET_CONNECT_FAILED"))); socket.once("close", () => reject(new WanxError("WEBSOCKET_CONNECT_FAILED"))); });
      socket.on("message", (data, binary) => {
        const value = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) { error = new WanxError("WEBSOCKET_BUFFER_LIMIT"); socket.terminate(); return; }
        queue.push(binary ? { kind: "binary", bytes: new Uint8Array(value) } : { kind: "text", text: value.toString("utf8") });
        if (bytes >= 262144) socket.pause(); wake?.(); wake = undefined;
      });
      socket.on("error", () => { error = new WanxError("WEBSOCKET_FAILED"); });
      socket.on("close", code => { ended = true; sockets.delete(socket); signal.removeEventListener("abort", abort); if (code !== 1000 && code !== 1005 && !signal.aborted) error ??= new WanxError("WEBSOCKET_CLOSED", code); wake?.(); wake = undefined; });
      if (signal.aborted) abort();
      try { await ready; } catch (e) { socket.terminate(); throw e; }
      return {
        frames: (async function* () {
          try {
            for (;;) {
              while (queue.length) { const frame = queue.shift()!; bytes -= frame.kind === "binary" ? frame.bytes.byteLength : Buffer.byteLength(frame.text); if (bytes < 131072) socket.resume(); yield frame; }
              if (ended) { if (error) throw error; return; }
              await new Promise<void>(resolveWake => { wake = resolveWake; });
            }
          } finally { if (!ended) socket.close(1000); }
        })(),
        async send(frame) { if (ended) throw new WanxError("STREAM_CLOSED"); await new Promise<void>((resolveSend, reject) => socket.send(frame.kind === "text" ? frame.text : frame.bytes, { binary: frame.kind === "binary" }, e => e ? reject(new WanxError("WEBSOCKET_SEND_FAILED")) : resolveSend())); },
        async close(code = 1000, reason = "") { if (!ended) socket.close(code, reason); },
      };
    },
    async close() { life.abort(); for (const socket of sockets) socket.terminate(); sockets.clear(); },
  };
}
