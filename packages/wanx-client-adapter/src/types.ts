import type { NativeOperations as BaselineOperations } from "./generated/native-api.js";
import type { ApplicationOperations, ManagementCapabilities } from "./application-contracts.js";
import type { BrainstormOperations } from "./brainstorm-contracts.js";
import type { ApplicationsApi } from "./applications.js";
export type NativeOperations = Omit<BaselineOperations, "login_api_auth_login_post" | "get_capabilities_api_settings_capabilities_get"> & ApplicationOperations & BrainstormOperations & {
 readonly login_api_auth_login_post: { readonly request: { readonly body: BaselineOperations["login_api_auth_login_post"]["request"]["body"] & { readonly application_id?: string } }; readonly responseBody: BaselineOperations["login_api_auth_login_post"]["responseBody"] };
 readonly get_capabilities_api_settings_capabilities_get: { readonly request: BaselineOperations["get_capabilities_api_settings_capabilities_get"]["request"]; readonly responseBody: ManagementCapabilities | BaselineOperations["get_capabilities_api_settings_capabilities_get"]["responseBody"] };
};
import type { moduleRegistry } from "./registry.js";
import type { memoryMethods } from "./generated/memory.js";

export type OperationId = keyof NativeOperations;
export interface CallOptions { signal?: AbortSignal; requestId?: string; }
export interface NativeResponse<T = unknown> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: T;
}
export interface ByteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}
export interface ServerEvent { readonly event: string; readonly data: string; readonly id?: string; readonly retry?: number; }
export type SocketEndpoint = "chat" | "notifications" | "terminal" | "browser-stream" | "desktop-stream" | "mobile-stream" | "mobile-adb-shell";
export type SocketFrame = { readonly kind: "text"; readonly text: string } | { readonly kind: "binary"; readonly bytes: Uint8Array };
export interface NativeSocket {
  readonly frames: AsyncIterable<SocketFrame>;
  send(frame: SocketFrame): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}
export interface SocketInput { endpoint: SocketEndpoint; agentId?: string; query?: Readonly<Record<string, string | number | boolean>>; }
export interface WireRequest { method: string; path: string; headers: Readonly<Record<string, string>>; body?: Uint8Array; }
export interface RuntimeCapabilities {
  readonly httpUnary: boolean; readonly httpResponseStream: boolean;
  readonly websocketMessages: boolean; readonly uploadStream: boolean;
  readonly maxRequestBodyBytes: number; readonly networkPath: "direct" | "relay" | "local-http";
}
/** Trusted-host port. It must never be exposed through Electron contextBridge. */
export interface WanxTransport {
  readonly capabilities: RuntimeCapabilities;
  request(request: WireRequest, options?: CallOptions): Promise<ByteResponse>;
  openSocket(input: SocketInput, options?: CallOptions): Promise<NativeSocket>;
  close(): Promise<void>;
}
export interface ApplicationPolicy {
  readonly applicationId: string;
  readonly operations: readonly OperationId[];
  readonly agents?: readonly string[];
  readonly sockets: readonly SocketEndpoint[];
}
type PublicQuery<R> = R extends { readonly query?: infer Q } ? Omit<NonNullable<Q>, "access_token" | "token" | "as_user"> : {};
export type PublicRequest<R, Bound extends boolean = false> =
  Omit<R, "path" | "query" | "header" | "cookie" | "body"> &
  (R extends { readonly path: infer P } ? (keyof (Bound extends true ? Omit<P, "agent_id"> : P) extends never ? {} : { readonly path: Bound extends true ? Omit<P, "agent_id"> : P }) : {}) &
  (keyof PublicQuery<R> extends never ? {} : { readonly query?: PublicQuery<R> }) &
  (R extends { readonly body: infer B } ? { readonly body: B | FormData } : R extends { readonly body?: infer B } ? { readonly body?: B | FormData } : {});
type Args<K extends OperationId, Bound extends boolean> = PublicRequest<NativeOperations[K]["request"], Bound>;
type Call<R, T> = {} extends R ? (request?: R, options?: CallOptions) => Promise<T> : (request: R, options?: CallOptions) => Promise<T>;
export type Operation<K extends OperationId, Bound extends boolean = false> = Call<Args<K, Bound>, NativeResponse<NativeOperations[K]["responseBody"]>> & {
  stream: Call<Args<K, Bound>, ByteResponse>;
  events: Call<Args<K, Bound>, AsyncIterable<ServerEvent>>;
};
export type Modules<Bound extends boolean = false> = {
  readonly [M in keyof typeof moduleRegistry]: {
    readonly [A in keyof (typeof moduleRegistry)[M]]: Operation<Extract<(typeof moduleRegistry)[M][A], OperationId>, Bound>;
  };
};
export type MemoryApi = { readonly [A in Exclude<keyof typeof memoryMethods, "listPortableSources">]: Operation<(typeof memoryMethods)[A], true> };
export interface AgentClient { readonly agentId: string; readonly modules: Modules<true>; readonly memory: MemoryApi; }
export interface CentaurAIWanxClient {
  readonly modules: Modules;
  readonly applications: ApplicationsApi;
  readonly native: {
    invoke<K extends OperationId>(id: K, request: NativeOperations[K]["request"], options?: CallOptions): Promise<NativeResponse<NativeOperations[K]["responseBody"]>>;
    stream<K extends OperationId>(id: K, request: NativeOperations[K]["request"], options?: CallOptions): Promise<ByteResponse>;
  };
  readonly agents: { use(id: string): AgentClient };
  readonly capabilities: RuntimeCapabilities;
  openSocket(input: SocketInput, options?: CallOptions): Promise<NativeSocket>;
  close(): Promise<void>;
}
