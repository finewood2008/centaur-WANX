import { operationRegistry } from "./registry.js";
import { WanxError } from "./errors.js";
import type { ByteResponse, NativeSocket, SocketInput, WireRequest, CentaurAIWanxClient } from "./types.js";
import type { CentaurAIWanxHost } from "./native-host.js";

export const IPC_CHANNEL = "centaurai-wanx:v1";
const hostOnlyPaths = new Set(["/api/auth/login", "/api/auth/invite/redeem", "/api/auth/oauth/exchange", "/api/auth/oidc/exchange", "/api/setup/initial-admin", "/api/setup/begin", "/api/setup/verify-password", "/api/setup/resume-wizard"]);
interface IPCEvent { sender: { id: number }; senderFrame?: { url: string; parent?: unknown } | null; }
interface IPCMain { handle(channel: string, handler: (event: IPCEvent, input: unknown) => Promise<unknown>): void; removeHandler(channel: string): void; }
interface Request { method: string; params?: Record<string, unknown>; }
const documentURL = (value: string) => { const url = new URL(value); url.hash = ""; return url.href; };

async function decodeRequest(request: WireRequest): Promise<{ op: (typeof operationRegistry)[number]; input: Record<string, unknown>; boundAgent?: string }> {
  if (!request || typeof request.path !== "string" || !request.path.startsWith("/api/") || /[\\\r\n\0]/u.test(request.path)) throw new WanxError("INVALID_REQUEST");
  if (Object.keys(request.headers ?? {}).some(k => !["accept", "content-type", "x-octop-agent-id"].includes(k.toLowerCase()))) throw new WanxError("PUBLIC_CREDENTIAL_OVERRIDE");
  const url = new URL(request.path, "http://sdk.invalid");
  if (url.origin !== "http://sdk.invalid" || ["access_token", "token", "as_user"].some(k => url.searchParams.has(k))) throw new WanxError("PUBLIC_CREDENTIAL_OVERRIDE");
  for (const op of operationRegistry) {
    if (op.method !== request.method) continue;
    const names: string[] = [];
    const pattern = op.path.split(/(\{[^}]+\})/u).map(part => { if (part.startsWith("{")) { const name = part.slice(1, -1); names.push(name); return name === "file_path" ? "(.+)" : "([^/]+)"; } return part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }).join("");
    const match = new RegExp("^" + pattern + "$").exec(url.pathname); if (!match) continue;
    const path = Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1]!)]));
    const query: Record<string, string | string[]> = {};
    for (const name of new Set(url.searchParams.keys())) { const values = url.searchParams.getAll(name); query[name] = values.length === 1 ? values[0]! : values; }
    const input: Record<string, unknown> = { path, query };
    if (request.body !== undefined) {
      const content = Object.entries(request.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
      const bytes = new Uint8Array(request.body);
      if (content.includes("multipart/form-data")) input.body = await new Response(bytes, { headers: { "content-type": content } }).formData();
      else if (content.includes("json")) input.body = JSON.parse(new TextDecoder().decode(bytes));
      else input.body = bytes;
    }
    const agentHeader = Object.entries(request.headers).find(([key]) => key.toLowerCase() === "x-octop-agent-id")?.[1];
    if (agentHeader && !(op.parameters as readonly { in: string; name: string }[]).some(p => p.in === "header" && p.name.toLowerCase() === "x-octop-agent-id")) throw new WanxError("UNKNOWN_HEADER_PARAMETER");
    return { op, input, ...(agentHeader ? { boundAgent: agentHeader } : {}) };
  }
  throw new WanxError("UNKNOWN_OPERATION");
}

/** Bind one application window. The host and its manifest remain in main. */
export function bindCentaurAIWanxElectron(config: { ipcMain: IPCMain; webContentsId: number; documentURL: string; host: CentaurAIWanxHost }): () => Promise<void> {
  const trustedURL = documentURL(config.documentURL); let client: CentaurAIWanxClient | undefined; let next = 0;
  const streams = new Map<string, { response: ByteResponse; iterator: AsyncIterator<Uint8Array> }>();
  const sockets = new Map<string, { socket: NativeSocket; iterator: AsyncIterator<import("./types.js").SocketFrame> }>();
  const reset = async () => { await Promise.allSettled([...streams.values()].map(v => v.response.close())); streams.clear(); await Promise.allSettled([...sockets.values()].map(v => v.socket.close())); sockets.clear(); client = undefined; };
  config.ipcMain.handle(IPC_CHANNEL, async (event, raw) => {
    try {
      if (event.sender.id !== config.webContentsId || !event.senderFrame || event.senderFrame.parent || documentURL(event.senderFrame.url) !== trustedURL) throw new WanxError("IPC_SENDER_NOT_ALLOWED");
      const { method, params = {} } = raw as Request;
      let value: unknown;
      switch (method) {
        case "auth.current": value = await config.host.auth.current(); break;
        case "auth.sendSMS": value = await config.host.auth.sendSMS(params.phone as string); break;
        case "auth.loginPassword": await reset(); value = await config.host.auth.loginPassword({ phone: params.phone as string, password: params.password as string }); break;
        case "auth.loginSMS": await reset(); value = await config.host.auth.loginSMS({ phone: params.phone as string, code: params.code as string }); break;
        case "auth.logout": await reset(); await config.host.auth.logout(); break;
        case "devices.list": value = await config.host.devices.list(); break;
        case "connection.status": value = config.host.connection.status(); break;
        case "connection.connect": await reset(); client = await config.host.connection.connect({ deviceId: params.deviceId as string }); value = { capabilities: client.capabilities }; break;
        case "connection.disconnect": await reset(); await config.host.connection.disconnect(); break;
        case "http.open": {
          if (!client) throw new WanxError("NOT_CONNECTED");
          const { op, input, boundAgent } = await decodeRequest(params.request as unknown as WireRequest);
          // Credential-issuing native auth flows are completed by trusted host
          // code. The app uses the account facade and never receives native JWTs.
          if (hostOnlyPaths.has(op.path)) throw new WanxError("HOST_ONLY_OPERATION");
          const module = op.tags[0]!.replace(/[-_]([a-z])/gu, (_, c: string) => c.toUpperCase());
          const publicModules = (boundAgent ? client.agents.use(boundAgent).modules : client.modules) as unknown as Record<string, Record<string, { stream(input: unknown): Promise<ByteResponse> }>>;
          const response = await publicModules[module]![op.alias]!.stream(input);
          const handle = String(++next); streams.set(handle, { response, iterator: response.chunks[Symbol.asyncIterator]() });
          value = { handle, status: response.status, headers: response.headers }; break;
        }
        case "http.read": { const stream = streams.get(params.handle as string); if (!stream) throw new WanxError("STREAM_CLOSED"); const chunk = await stream.iterator.next(); if (chunk.done) { await stream.response.close(); streams.delete(params.handle as string); } value = { done: Boolean(chunk.done), bytes: chunk.value }; break; }
        case "http.close": { const stream = streams.get(params.handle as string); await stream?.response.close(); streams.delete(params.handle as string); break; }
        case "socket.open": { if (!client) throw new WanxError("NOT_CONNECTED"); const socket = await client.openSocket(params.input as unknown as SocketInput); const handle = String(++next); sockets.set(handle, { socket, iterator: socket.frames[Symbol.asyncIterator]() }); value = { handle }; break; }
        case "socket.read": { const socket = sockets.get(params.handle as string); if (!socket) throw new WanxError("STREAM_CLOSED"); value = await socket.iterator.next(); break; }
        case "socket.send": { const socket = sockets.get(params.handle as string); if (!socket) throw new WanxError("STREAM_CLOSED"); await socket.socket.send(params.frame as unknown as import("./types.js").SocketFrame); break; }
        case "socket.close": { const socket = sockets.get(params.handle as string); await socket?.socket.close(params.code as number | undefined, params.reason as string | undefined); sockets.delete(params.handle as string); break; }
        default: throw new WanxError("IPC_METHOD_NOT_ALLOWED");
      }
      return { ok: true, value };
    } catch (error) { return { ok: false, code: error instanceof WanxError ? error.code : "IPC_REQUEST_FAILED" }; }
  });
  return async () => { config.ipcMain.removeHandler(IPC_CHANNEL); await reset(); await config.host.dispose(); };
}
