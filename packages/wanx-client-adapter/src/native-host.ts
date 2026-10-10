import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCentaurAIWanxClient } from "./client.js";
import { socketPath } from "./socket-path.js";
import { WanxError } from "./errors.js";
import type { ApplicationPolicy, ByteResponse, CallOptions, CentaurAIWanxClient, NativeSocket, RuntimeCapabilities, SocketInput, WanxTransport, WireRequest } from "./types.js";

export interface SecureStore { load(): Promise<string | null>; save(value: string): Promise<void>; clear(): Promise<void>; }
interface Identity { clientId: string; privateKeyPEM: string; publicKeyPEM: string; platform: string; deviceModel: string; }
interface SecretRecord { version: 1; identity: Identity; session?: unknown; }
interface RPCReply { id: string; result?: unknown; error?: string; callback?: string; event?: string; value?: unknown; }

class RPC {
  public onEvent?: (name: string, value: unknown) => void;
  private readonly child: ChildProcessWithoutNullStreams;
  private next = 0; private buffer = ""; private closed = false;
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  constructor(binary: string, private readonly storeCallback: (method: string, value: unknown) => Promise<void>) {
    this.child = spawn(binary, [], { stdio: "pipe", windowsHide: true, shell: false });
    this.child.stdout.setEncoding("utf8");
    // Never forward raw native diagnostic text into application logs or IPC.
    this.child.stderr.resume();
    this.child.on("error", () => this.fail(new WanxError("NATIVE_HOST_START_FAILED")));
    this.child.on("exit", () => this.fail(new WanxError("NATIVE_HOST_CLOSED")));
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { this.fail(new WanxError("NATIVE_PROTOCOL_ERROR")); this.child.kill(); return; }
      for (;;) {
        const end = this.buffer.indexOf("\n"); if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let reply: RPCReply;
        try { reply = JSON.parse(line) as RPCReply; } catch { this.fail(new WanxError("NATIVE_PROTOCOL_ERROR")); return; }
        if (reply.event) { this.onEvent?.(reply.event, reply.value); continue; }
        if (reply.callback) {
          void this.storeCallback(reply.callback, reply.value).then(() => this.send({ reply: reply.id }), () => this.send({ reply: reply.id, error: "SECURE_STORAGE_FAILED" }));
          continue;
        }
        const request = this.pending.get(reply.id); if (!request) continue;
        this.pending.delete(reply.id);
        if (reply.error) request.reject(new WanxError(reply.error)); else request.resolve(reply.result);
      }
    });
  }
  private send(value: unknown) { if (!this.closed) this.child.stdin.write(JSON.stringify(value) + "\n"); }
  private fail(error: WanxError) { if (this.closed) return; this.closed = true; for (const request of this.pending.values()) request.reject(error); this.pending.clear(); this.onEvent?.("process.closed", undefined); }
  call<T>(method: string, params: unknown = {}, options: CallOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new WanxError("NATIVE_HOST_CLOSED"));
    if (options.signal?.aborted) return Promise.reject(new WanxError("CANCELLED"));
    const id = String(++this.next);
    return new Promise<T>((resolve, reject) => {
      const abort = () => { this.send({ id: String(++this.next), method: "cancel", params: { requestId: id } }); this.pending.delete(id); reject(new WanxError("CANCELLED")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value as T); }, reject: error => { cleanup(); reject(error); } });
      this.send({ id, method, params });
    });
  }
  async close() { if (this.closed) return; this.child.stdin.end(); this.fail(new WanxError("NATIVE_HOST_CLOSED")); this.child.kill(); }
}

async function bundledBinary(): Promise<string> {
  const key = `${process.platform}-${process.arch}`;
  const root = new URL("../native/bin/", import.meta.url);
  let manifest: Record<string, { file: string; sha256: string }>;
  try { manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8")) as typeof manifest; }
  catch { throw new WanxError("NATIVE_BINARY_NOT_INSTALLED"); }
  const entry = manifest[key]; if (!entry || !/^[a-zA-Z0-9._-]+$/u.test(entry.file)) throw new WanxError("HOST_PLATFORM_NOT_SUPPORTED");
  const binary = fileURLToPath(new URL(entry.file, root)).replace(/\.asar([/\\])/u, ".asar.unpacked$1");
  if (createHash("sha256").update(await readFile(binary)).digest("hex") !== entry.sha256) throw new WanxError("NATIVE_BINARY_HASH_MISMATCH");
  return binary;
}

class ProcessTransport implements WanxTransport {
  constructor(private readonly rpc: RPC, public readonly capabilities: RuntimeCapabilities) {}
  async request(request: WireRequest, options: CallOptions = {}): Promise<ByteResponse> {
    if (request.body && request.body.byteLength > this.capabilities.maxRequestBodyBytes) throw new WanxError("REQUEST_BODY_TOO_LARGE");
    const reply = await this.rpc.call<{ handle: string; status: number; headers: Record<string, string> }>("http.open", { method: request.method, path: request.path, headers: request.headers, body: Buffer.from(request.body ?? []).toString("base64") }, options);
    let closed = false;
    const close = async () => { if (closed) return; closed = true; options.signal?.removeEventListener("abort", abort); await this.rpc.call("http.close", { handle: reply.handle }).catch(() => undefined); };
    const abort = () => { void close(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { await close(); throw new WanxError("CANCELLED"); }
    const rpc = this.rpc;
    return {
      status: reply.status, headers: reply.headers,
      chunks: (async function* () {
        try { while (!closed) { const chunk = await rpc.call<{ body: string; done: boolean }>("http.read", { handle: reply.handle }, options); if (chunk.body) yield new Uint8Array(Buffer.from(chunk.body, "base64")); if (chunk.done) break; } }
        finally { await close(); }
      })(), close,
    };
  }
  async openSocket(input: SocketInput, options: CallOptions = {}): Promise<NativeSocket> {
    const reply = await this.rpc.call<{ handle: string }>("socket.open", { endpoint: input.endpoint, path: socketPath(input) }, options);
    let closed = false; const rpc = this.rpc;
    const close = async (closeCode = 1000, reason = "") => { if (closed) return; closed = true; options.signal?.removeEventListener("abort", abort); await rpc.call("socket.close", { handle: reply.handle, closeCode, reason }).catch(() => undefined); };
    const abort = () => { void close(); }; options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { await close(); throw new WanxError("CANCELLED"); }
    return {
      frames: (async function* () { try { while (!closed) { const frame = await rpc.call<{ kind: "text" | "binary"; body: string }>("socket.read", { handle: reply.handle }, options); if (frame.kind === "text") yield { kind: "text" as const, text: Buffer.from(frame.body, "base64").toString("utf8") }; else yield { kind: "binary" as const, bytes: new Uint8Array(Buffer.from(frame.body, "base64")) }; } } finally { await close(); } })(),
      async send(frame) { if (closed) throw new WanxError("STREAM_CLOSED"); await rpc.call("socket.write", { handle: reply.handle, kind: frame.kind, body: Buffer.from(frame.kind === "text" ? frame.text : frame.bytes).toString("base64") }, options); }, close,
    };
  }
  // Session disposal preserves the process/account, allowing a later reconnect.
  async close() { await this.rpc.call("connection.disconnect"); }
}

export interface NativeHostOptions {
  readonly consumerBaseURL: string; readonly secureStore: SecureStore;
  readonly trustedGatewayHosts: readonly string[]; readonly trustedICEHosts: readonly string[];
  readonly policy: ApplicationPolicy;
}
export interface PublicIdentity { readonly accountId: string; readonly clientId: string; }
export interface NativeDevice { readonly deviceId: string; readonly deviceName?: string; readonly online: boolean; readonly role: string; readonly scopes: readonly string[]; readonly ownershipEpoch: number; readonly status: string; }
export interface ConnectionStatus { readonly generation: number; readonly phase: "idle" | "connecting" | "ready" | "disconnected" | "failed" | "closed"; readonly reason?: string; }
export interface CentaurAIWanxHost {
  readonly auth: { current(): Promise<PublicIdentity | null>; sendSMS(phone: string): Promise<{ expiresIn: number }>; loginPassword(input: { phone: string; password: string }): Promise<PublicIdentity>; loginSMS(input: { phone: string; code: string }): Promise<PublicIdentity>; logout(): Promise<void>; };
  readonly devices: { list(): Promise<readonly NativeDevice[]> };
  readonly connection: { status(): ConnectionStatus; onStatus(handler: (status: ConnectionStatus) => void): () => void; connect(input: { deviceId: string; linkExisting?: { username: string; password: string } }): Promise<CentaurAIWanxClient>; disconnect(): Promise<void>; };
  initializeOwner(wizardToken: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Create in Electron main or another Node native host. Never in a renderer. */
export async function createCentaurAIWanxHost(options: NativeHostOptions): Promise<CentaurAIWanxHost> {
  const raw = await options.secureStore.load(); let record: SecretRecord;
  if (raw) {
    try { record = JSON.parse(raw) as SecretRecord; if (record.version !== 1 || !record.identity.clientId || !record.identity.privateKeyPEM || !record.identity.publicKeyPEM) throw new Error(); }
    catch { throw new WanxError("INVALID_STORED_IDENTITY"); }
  } else {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const platform = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform as "darwin" | "win32" | "linux"];
    if (!platform) throw new WanxError("HOST_PLATFORM_NOT_SUPPORTED");
    record = { version: 1, identity: { clientId: randomUUID(), privateKeyPEM: keys.privateKey, publicKeyPEM: keys.publicKey, platform, deviceModel: process.arch } };
    await options.secureStore.save(JSON.stringify(record));
  }
  const rpc = new RPC(await bundledBinary(), async (method, value) => {
    let nextRecord: SecretRecord;
    if (method === "session.save") nextRecord = { ...record, session: value };
    else if (method === "session.clear") nextRecord = { version: 1, identity: record.identity };
    else throw new WanxError("NATIVE_PROTOCOL_ERROR");
    await options.secureStore.save(JSON.stringify(nextRecord)); record = nextRecord;
  });
  try { await rpc.call("initialize", { consumerBaseURL: options.consumerBaseURL, identity: record.identity, session: record.session, policy: options.policy, trustedGatewayHosts: options.trustedGatewayHosts, trustedICEHosts: options.trustedICEHosts }); }
  catch (error) { await rpc.close(); throw error; }
  let status: ConnectionStatus = { generation: 0, phase: "idle" }; let current: CentaurAIWanxClient | undefined; let disposed = false; let leaseId: string | undefined;
  let control = Promise.resolve(); const listeners = new Set<(status: ConnectionStatus) => void>();
  const update = (phase: ConnectionStatus["phase"], reason?: string) => { status = Object.freeze({ generation: status.generation, phase, ...(reason ? { reason } : {}) }); for (const handler of listeners) { try { handler(status); } catch { /* Observers do not control the connection. */ } } };
  const serialize = <T>(run: () => Promise<T>): Promise<T> => { const next = control.then(() => { if (disposed) throw new WanxError("HOST_CLOSED"); return run(); }); control = next.then(() => undefined, () => undefined); return next; };
  const disconnect = async () => { leaseId = undefined; status = { generation: status.generation + 1, phase: "disconnected" }; if (current) { await current.close(); current = undefined; } else await rpc.call("connection.disconnect"); update("disconnected"); };
  rpc.onEvent = (name, value) => {
    if (disposed) return;
    if (name === "connection.closed" && leaseId === (value as { leaseId?: string })?.leaseId && status.phase === "ready") {
      void serialize(disconnect).then(() => update("disconnected", "NATIVE_SESSION_ENDED"), () => update("failed", "NATIVE_HOST_CLOSED"));
    } else if (name === "process.closed") {
      leaseId = undefined; void current?.close().catch(() => undefined); current = undefined; update("failed", "NATIVE_HOST_CLOSED");
    }
  };
  return {
    auth: {
      current: () => rpc.call("account.current"), sendSMS: phone => rpc.call("account.sendSMS", { phone }),
      loginPassword: input => serialize(async () => { await disconnect(); return rpc.call("account.loginPassword", input); }),
      loginSMS: input => serialize(async () => { await disconnect(); return rpc.call("account.loginSMS", input); }),
      logout: () => serialize(async () => { await disconnect(); await rpc.call("account.logout"); }),
    },
    devices: { list: () => rpc.call("devices.list") },
    connection: {
      status: () => status,
      onStatus(handler) { listeners.add(handler); return () => listeners.delete(handler); },
      connect: input => serialize(async () => {
        await disconnect(); update("connecting");
        try {
          const result = await rpc.call<{ leaseId: string; capabilities: RuntimeCapabilities }>("connection.connect", { deviceId: input.deviceId, username: input.linkExisting?.username, password: input.linkExisting?.password });
          leaseId = result.leaseId;
          current = createCentaurAIWanxClient({ transport: new ProcessTransport(rpc, result.capabilities), policy: options.policy }); update("ready"); return current;
        } catch (error) { update("failed", error instanceof WanxError ? error.code : "CONNECT_FAILED"); throw error; }
      }),
      disconnect: () => serialize(disconnect),
    },
    initializeOwner: wizardToken => rpc.call("owner.initialize", { wizardToken }),
    async dispose() { if (disposed) return; await control; try { await disconnect(); } finally { disposed = true; update("closed"); await rpc.close(); } },
  };
}

/** Local integration adapter; credentials stay in this trusted native process. */
export async function createNativeHTTPTransport(options: { baseURL: string; token?: string; policy: ApplicationPolicy }): Promise<WanxTransport> {
  const rpc = new RPC(await bundledBinary(), async () => { throw new WanxError("NATIVE_PROTOCOL_ERROR"); });
  try { await rpc.call("initialize", { localBaseURL: options.baseURL, localToken: options.token, policy: options.policy }); }
  catch (error) { await rpc.close(); throw error; }
  const transport = new ProcessTransport(rpc, { httpUnary: true, httpResponseStream: true, websocketMessages: false, uploadStream: false, maxRequestBodyBytes: 2 * 1024 * 1024, networkPath: "local-http" });
  return { capabilities: transport.capabilities, request: transport.request.bind(transport), openSocket: transport.openSocket.bind(transport), close: () => rpc.close() };
}
