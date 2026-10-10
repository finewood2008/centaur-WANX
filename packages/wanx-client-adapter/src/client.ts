import { operationRegistry, moduleRegistry } from "./registry.js";
import { memoryMethods } from "./generated/memory.js";
import { parseSSE } from "./sse.js";
import { WanxError } from "./errors.js";
import { applicationsFacade } from "./applications.js";
import type { AgentClient, ApplicationPolicy, ByteResponse, CallOptions, CentaurAIWanxClient, Modules, NativeResponse, OperationId, SocketInput, WanxTransport, WireRequest } from "./types.js";

type Input = { path?: Record<string, unknown>; query?: Record<string, unknown>; header?: Record<string, unknown>; cookie?: unknown; body?: unknown };
const registry = new Map<string, (typeof operationRegistry)[number]>(operationRegistry.map(op => [op.operationId, op]));
const credential = /^(authorization|proxy-authorization|cookie|set-cookie|x-nexus.*|x-nexusaos.*)$/iu;

function segment(value: unknown, wildcard = false): string {
  if (typeof value !== "string" && typeof value !== "number") throw new WanxError("INVALID_PATH_PARAMETER");
  const parts = String(value).split("/");
  if (!wildcard && parts.length !== 1) throw new WanxError("INVALID_PATH_PARAMETER");
  if (parts.some(p => !p || p === "." || p === ".." || /[\\\r\n\0]/u.test(p))) throw new WanxError("INVALID_PATH_PARAMETER");
  return parts.map(p => encodeURIComponent(p)).join("/");
}

async function serialize(id: OperationId, input: Input, boundAgent?: string, trusted = false): Promise<WireRequest> {
  const op = registry.get(id); if (!op) throw new WanxError("UNKNOWN_OPERATION");
  if (!trusted && (input.header !== undefined || input.cookie !== undefined || ["access_token", "token", "as_user"].some(k => k in (input.query ?? {})))) throw new WanxError("PUBLIC_CREDENTIAL_OVERRIDE");
  if (boundAgent !== undefined && input.path && "agent_id" in input.path) throw new WanxError("BOUND_AGENT_OVERRIDE");
  const params: Record<string, unknown> = { ...input.path, ...(boundAgent !== undefined ? { agent_id: boundAgent } : {}) };
  let path = op.path.replace(/\{([^}]+)\}/gu, (_, name: string) => segment(params[name], name === "file_path"));
  const query = new URLSearchParams();
  const parameters = op.parameters as readonly { name: string; in: string; required?: boolean }[];
  for (const p of parameters) {
    if (p.in !== "query") continue;
    const value = input.query?.[p.name];
    if (value == null) { if (p.required) throw new WanxError("MISSING_QUERY_PARAMETER"); continue; }
    for (const part of Array.isArray(value) ? value : [value]) query.append(p.name, String(part));
  }
  if (input.query && Object.keys(input.query).some(k => !parameters.some(p => p.in === "query" && p.name === k))) throw new WanxError("UNKNOWN_QUERY_PARAMETER");
  if (query.size) path += "?" + query.toString();
  const headers: Record<string, string> = { Accept: op.stream === "sse" ? "text/event-stream" : "application/json" };
  if (boundAgent !== undefined) for (const p of parameters) {
    if (p.in === "header" && p.name.toLowerCase() === "x-octop-agent-id") headers[p.name] = boundAgent;
  }
  if (trusted && input.header) for (const [name, value] of Object.entries(input.header)) {
    if (credential.test(name)) throw new WanxError("CREDENTIAL_OVERRIDE");
    if (value != null) headers[name] = String(value);
  }
  if (op.bodyRequired && input.body === undefined) throw new WanxError("MISSING_BODY");
  let body: Uint8Array | undefined;
  if (input.body !== undefined) {
    if ((op.contentTypes as readonly string[]).includes("multipart/form-data")) {
      const form = input.body instanceof FormData ? input.body : new FormData();
      if (!(input.body instanceof FormData)) {
        if (typeof input.body !== "object" || input.body === null) throw new WanxError("INVALID_MULTIPART_BODY");
        for (const [key, value] of Object.entries(input.body)) {
          if (value == null) continue;
          for (const entry of Array.isArray(value) ? value : [value]) {
            if (entry instanceof Blob) form.append(key, entry);
            else if (entry instanceof Uint8Array) form.append(key, new Blob([new Uint8Array(entry)]), "upload.bin");
            else form.append(key, String(entry));
          }
        }
      }
      const encoded = new Response(form);
      headers["Content-Type"] = encoded.headers.get("content-type")!;
      body = new Uint8Array(await encoded.arrayBuffer());
    } else if (input.body instanceof Uint8Array) {
      headers["Content-Type"] = "application/octet-stream"; body = input.body;
    } else {
      headers["Content-Type"] = "application/json"; body = new TextEncoder().encode(JSON.stringify(input.body));
    }
  }
  return { method: op.method, path, headers, ...(body === undefined ? {} : { body }) };
}

export function createCentaurAIWanxClient(config: { transport: WanxTransport; policy: ApplicationPolicy }): CentaurAIWanxClient {
  const transport = config.transport;
  const allowed = new Set(config.policy.operations);
  const allowedAgents = config.policy.agents === undefined ? undefined : new Set(config.policy.agents);
  const allowedSockets = new Set(config.policy.sockets);
  let closed = false;
  const controllers = new Set<AbortController>();
  const liveStreams = new Set<ByteResponse>();
  const liveSockets = new Set<Awaited<ReturnType<WanxTransport["openSocket"]>>>();
  const assertActive = () => { if (closed) throw new WanxError("SESSION_CLOSED"); };
  function authorize(id: OperationId, input: Input, agent?: string) {
    assertActive(); if (!allowed.has(id)) throw new WanxError("OPERATION_NOT_ALLOWED");
    const effective = agent ?? input.path?.agent_id;
    if (effective !== undefined && allowedAgents && !allowedAgents.has(String(effective))) throw new WanxError("AGENT_NOT_ALLOWED");
  }
  async function stream(id: OperationId, input: Input = {}, options: CallOptions = {}, agent?: string, trusted = false): Promise<ByteResponse> {
    authorize(id, input, agent);
    const request = await serialize(id, input, agent, trusted);
    assertActive();
    if (request.body && request.body.byteLength > transport.capabilities.maxRequestBodyBytes) throw new WanxError("REQUEST_BODY_TOO_LARGE");
    const controller = new AbortController(); controllers.add(controller);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let response: ByteResponse;
    try { response = await transport.request(request, { ...options, signal }); }
    catch (error) { controllers.delete(controller); throw error; }
    if (closed) { await response.close(); controllers.delete(controller); throw new WanxError("SESSION_CLOSED"); }
    let finished = false;
    const cleanup = async () => { if (finished) return; finished = true; controllers.delete(controller); liveStreams.delete(wrapped); await response.close(); };
    const wrapped: ByteResponse = {
      status: response.status,
      headers: Object.freeze(Object.fromEntries(Object.entries(response.headers).filter(([k]) => !credential.test(k)))),
      chunks: (async function* () { try { for await (const chunk of response.chunks) { assertActive(); yield chunk; } } finally { await cleanup(); } })(),
      close: cleanup,
    };
    liveStreams.add(wrapped); return wrapped;
  }
  async function invoke(id: OperationId, input: Input = {}, options?: CallOptions, agent?: string, trusted = false): Promise<NativeResponse> {
    const response = await stream(id, input, options, agent, trusted);
    const chunks: Uint8Array[] = []; let size = 0;
    try { for await (const chunk of response.chunks) { chunks.push(chunk); size += chunk.byteLength; if (size > 16 * 1024 * 1024) throw new WanxError("UNARY_RESPONSE_TOO_LARGE"); } }
    finally { await response.close(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const content = Object.entries(response.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    let body: unknown;
    if (!size) body = undefined;
    else if (content.includes("json")) { try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new WanxError("INVALID_JSON_RESPONSE"); } }
    else body = content.startsWith("text/") ? new TextDecoder().decode(bytes) : bytes;
    return { status: response.status, headers: response.headers, body };
  }
  function method(id: OperationId, agent?: string) {
    return Object.assign((input?: Input, options?: CallOptions) => invoke(id, input, options, agent), {
      stream: (input?: Input, options?: CallOptions) => stream(id, input, options, agent),
      events: async (input?: Input, options?: CallOptions) => {
        const response = await stream(id, input, options, agent);
        if (response.status < 200 || response.status >= 300) { await response.close(); throw new WanxError("NATIVE_HTTP_ERROR", response.status); }
        return (async function* () { try { yield* parseSSE(response.chunks); } finally { await response.close(); } })();
      },
    });
  }
  function modules(agent?: string): Modules {
    return Object.freeze(Object.fromEntries(Object.entries(moduleRegistry).map(([name, methods]) => [name, Object.freeze(Object.fromEntries(Object.entries(methods).map(([alias, id]) => [alias, method(id, agent)])))]))) as unknown as Modules;
  }
  const client: CentaurAIWanxClient = {
    capabilities: transport.capabilities,
    modules: modules(),
    applications: applicationsFacade(modules()),
    native: {
      invoke: ((id: OperationId, input: Input, options?: CallOptions) => invoke(id, input, options, undefined, true)) as CentaurAIWanxClient["native"]["invoke"],
      stream: ((id: OperationId, input: Input, options?: CallOptions) => stream(id, input, options, undefined, true)) as CentaurAIWanxClient["native"]["stream"],
    },
    agents: { use(id: string): AgentClient {
      assertActive(); segment(id);
      if (allowedAgents && !allowedAgents.has(id)) throw new WanxError("AGENT_NOT_ALLOWED");
      return Object.freeze({ agentId: id, modules: modules(id) as unknown as AgentClient["modules"], memory: Object.freeze(Object.fromEntries(Object.entries(memoryMethods).filter(([alias]) => alias !== "listPortableSources").map(([alias, op]) => [alias, method(op, id)]))) as unknown as AgentClient["memory"] });
    } },
    async openSocket(input: SocketInput, options?: CallOptions) {
      assertActive(); if (!allowedSockets.has(input.endpoint)) throw new WanxError("SOCKET_NOT_ALLOWED");
      if (input.agentId && allowedAgents && !allowedAgents.has(input.agentId)) throw new WanxError("AGENT_NOT_ALLOWED");
      if (["token", "access_token", "as_user"].some(k => k in (input.query ?? {}))) throw new WanxError("PUBLIC_CREDENTIAL_OVERRIDE");
      const socket = await transport.openSocket(input, options);
      if (closed) { await socket.close(); throw new WanxError("SESSION_CLOSED"); }
      liveSockets.add(socket);
      const close = async (code?: number, reason?: string) => { liveSockets.delete(socket); await socket.close(code, reason); };
      return {
        frames: (async function* () { try { for await (const frame of socket.frames) { assertActive(); yield frame; } } finally { await close(); } })(),
        async send(frame) {
          assertActive();
          if (frame.kind === "text") {
            let value: unknown; try { value = JSON.parse(frame.text); } catch { /* Native text frames can be plain text. */ }
            if (value && typeof value === "object" && ["token", "access_token"].some(key => key in value!)) throw new WanxError("PUBLIC_CREDENTIAL_OVERRIDE");
          }
          await socket.send(frame);
        }, close,
      };
    },
    async close() {
      if (closed) return; closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...liveStreams].map(r => r.close()));
      await Promise.allSettled([...liveSockets].map(r => r.close()));
      await transport.close();
    },
  };
  return Object.freeze(client);
}
