import { createCentaurAIWanxClient } from "./client.js";
import { WanxError } from "./errors.js";
import type { CentaurAIWanxHost, ConnectionStatus, PublicIdentity } from "./native-host.js";
import type { ApplicationPolicy, ByteResponse, CentaurAIWanxClient, NativeSocket, RuntimeCapabilities, SocketFrame, WanxTransport } from "./types.js";
export type CentaurAIWanxAppClient = Omit<CentaurAIWanxClient, "native">;
export interface RendererBridge { call(method: string, params?: unknown): Promise<unknown>; }
/** Policy here aids UI typing; main enforces its own immutable application policy. */
export function createCentaurAIWanxApp(config: { bridge: RendererBridge; policy: ApplicationPolicy }) {
  async function call<T>(method: string, params?: unknown): Promise<T> { const reply = await config.bridge.call(method, params) as { ok: boolean; value?: T; code?: string }; if (!reply.ok) throw new WanxError(reply.code ?? "IPC_REQUEST_FAILED"); return reply.value as T; }
  let current: CentaurAIWanxClient | undefined;
  const disconnect = async () => { if (current) { await current.close(); current = undefined; } else await call("connection.disconnect"); };
  return {
    auth: { current: () => call<PublicIdentity | null>("auth.current"), sendSMS: (phone: string) => call<{ expiresIn: number }>("auth.sendSMS", { phone }), loginPassword: async (input: { phone: string; password: string }) => { await disconnect(); return call<PublicIdentity>("auth.loginPassword", input); }, loginSMS: async (input: { phone: string; code: string }) => { await disconnect(); return call<PublicIdentity>("auth.loginSMS", input); }, logout: async () => { await disconnect(); await call("auth.logout"); } },
    devices: { list: () => call<Awaited<ReturnType<CentaurAIWanxHost["devices"]["list"]>>>("devices.list") },
    connection: {
      status: () => call<ConnectionStatus>("connection.status"), disconnect,
      async connect(input: { deviceId: string }): Promise<CentaurAIWanxAppClient> {
        await disconnect(); const { capabilities } = await call<{ capabilities: RuntimeCapabilities }>("connection.connect", input);
        const transport: WanxTransport = {
          capabilities,
          async request(request, options = {}): Promise<ByteResponse> {
            if (options.signal?.aborted) throw new WanxError("CANCELLED");
            const response = await call<{ handle: string; status: number; headers: Record<string, string> }>("http.open", { request }); let closed = false;
            const close = async () => { if (closed) return; closed = true; options.signal?.removeEventListener("abort", abort); await call("http.close", { handle: response.handle }); };
            const abort = () => { void close().catch(() => undefined); }; options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) { await close(); throw new WanxError("CANCELLED"); }
            return { status: response.status, headers: response.headers, chunks: (async function* () { try { while (!closed) { const chunk = await call<{ done: boolean; bytes?: Uint8Array }>("http.read", { handle: response.handle }); if (chunk.bytes) yield new Uint8Array(chunk.bytes); if (chunk.done) break; } } finally { await close(); } })(), close };
          },
          async openSocket(input, options = {}): Promise<NativeSocket> {
            const { handle } = await call<{ handle: string }>("socket.open", { input }); let closed = false;
            const close = async (code = 1000, reason = "") => { if (closed) return; closed = true; options.signal?.removeEventListener("abort", abort); await call("socket.close", { handle, code, reason }); };
            const abort = () => { void close().catch(() => undefined); }; options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) { await close(); throw new WanxError("CANCELLED"); }
            return { frames: (async function* () { try { while (!closed) { const chunk = await call<IteratorResult<SocketFrame>>("socket.read", { handle }); if (chunk.done) break; yield chunk.value; } } finally { await close(); } })(), send: frame => call("socket.send", { handle, frame }), close };
          },
          close: () => call("connection.disconnect"),
        };
        current = createCentaurAIWanxClient({ transport, policy: config.policy });
        const { native: _trustedOnly, ...appClient } = current;
        return Object.freeze(appClient);
      },
    },
    dispose: disconnect,
  };
}
