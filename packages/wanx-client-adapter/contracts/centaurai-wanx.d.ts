/** centaurai-wanx candidate public contract. There is no runtime implementation. */
import type { NativeOperations } from "./native-api.js";
import type { AgentMemoryMethods, GlobalMemoryMethods } from "./memory-methods.js";

export interface CallOptions { readonly signal?: AbortSignal; readonly requestId?: string; }
export interface NativeResponse<T> {
  readonly status: number;
  /** Credentials, token renewal and hop-by-hop headers are consumed by the host. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: T;
}
export interface NativeByteStream {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

// Page facades never accept native credential headers, query tokens or as_user.
type CleanQuery<R> = R extends { readonly query?: infer Q }
  ? Omit<NonNullable<Q>, "access_token" | "token" | "as_user"> : {};
type CleanPath<R, BindAgent extends boolean> = R extends { readonly path: infer P }
  ? (BindAgent extends true ? Omit<P, "agent_id"> : P) : {};
export type PublicRequest<R, BindAgent extends boolean = false> =
  Omit<R, "path" | "query" | "header"> &
  (keyof CleanPath<R, BindAgent> extends never ? {} : { readonly path: CleanPath<R, BindAgent> }) &
  (keyof CleanQuery<R> extends never ? {} : { readonly query?: CleanQuery<R> });
type PublicCall<R, T> = {} extends R
  ? (request?: R, options?: CallOptions) => Promise<T>
  : (request: R, options?: CallOptions) => Promise<T>;
type MemoryResult<K extends keyof AgentMemoryMethods> = K extends "packPortable"
  ? NativeByteStream : NativeResponse<NativeOperations[AgentMemoryMethods[K]]["responseBody"]>;
export type MemoryApi = {
  readonly [K in keyof AgentMemoryMethods]: PublicCall<
    PublicRequest<NativeOperations[AgentMemoryMethods[K]]["request"], true>, MemoryResult<K>
  >;
};
/** Host-scoped migration is separately granted, never implied by memory read. */
export type MemoryMigrationApi = {
  readonly [K in keyof GlobalMemoryMethods]: PublicCall<
    PublicRequest<NativeOperations[GlobalMemoryMethods[K]]["request"]>,
    NativeResponse<NativeOperations[GlobalMemoryMethods[K]]["responseBody"]>
  >;
};

export interface PublicIdentity { readonly accountId: string; readonly clientId: string; }
export interface PublicUser {
  readonly id: number; readonly username: string; readonly role: string;
  readonly displayName: string | null; readonly permissions: readonly string[];
}
export interface Device {
  readonly deviceId: string; readonly displayName: string;
  readonly online: boolean; readonly relationship: "owner" | "authorized";
}
export interface RuntimeCapabilities {
  readonly httpUnary: boolean; readonly httpResponseStream: boolean;
  readonly websocketMessages: boolean; readonly uploadStream: boolean;
  /** Derived from the approved platform contract, not a renderer request. */
  readonly networkPolicies: readonly ("direct-only" | "direct-then-relay")[];
}
export interface PublicContext {
  readonly generation: number; readonly accountId: string; readonly clientId: string;
  readonly applicationId: string; readonly deviceId: string;
  readonly user: PublicUser; readonly nativeLeaseExpiresAt: number;
  readonly selectedPath: "direct" | "relay";
  readonly capabilities: RuntimeCapabilities;
  /** Required provenance and source must be frozen with the matching server. */
  readonly platformBuild: string; readonly schemaHash: string;
}
export interface ConnectionStatus {
  readonly generation: number;
  readonly phase: "idle" | "authenticating" | "authorizing" | "connecting" |
    "transport-ready" | "binding-native-user" | "checking-platform" | "ready" |
    "recovering" | "disconnected" | "closed" | "failed";
  readonly reason?: string;
}
export type SocketEndpoint = "chat" | "notifications" | "terminal" | "browser-stream" |
  "desktop-stream" | "mobile-stream" | "mobile-adb-shell";
export type SocketFrame = { readonly kind: "text"; readonly text: string } |
  { readonly kind: "binary"; readonly bytes: Uint8Array };
export interface NativeSocket {
  readonly frames: AsyncIterable<SocketFrame>;
  send(frame: SocketFrame): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}
/** Trusted host only; the approved operation table and native permissions still apply. */
export interface NativeApi {
  invoke<K extends keyof NativeOperations>(operationId: K, request: NativeOperations[K]["request"], options?: CallOptions): Promise<NativeResponse<NativeOperations[K]["responseBody"]>>;
  stream<K extends keyof NativeOperations>(operationId: K, request: NativeOperations[K]["request"], options?: CallOptions): Promise<NativeByteStream>;
  openSocket(input: { readonly endpoint: SocketEndpoint; readonly agentId?: string; readonly options?: Readonly<Record<string, string | number | boolean>> }): Promise<NativeSocket>;
}
export interface AgentClient { readonly agentId: string; readonly memory: MemoryApi; }
export interface CentaurAIWanxSession {
  context(): PublicContext;
  readonly agents: { use(agentId: string): AgentClient };
  close(): Promise<void>;
}
export interface TrustedCentaurAIWanxSession extends CentaurAIWanxSession {
  readonly native: NativeApi;
  readonly memoryMigration: MemoryMigrationApi;
}
export interface CentaurAIWanxAppClient {
  readonly auth: {
    current(): Promise<PublicIdentity | null>;
    /** Host supplies client registration, OS identity, keys and secure storage. */
    loginPassword(input: { readonly phone: string; readonly password: string }): Promise<PublicIdentity>;
    logout(): Promise<void>;
  };
  readonly devices: { list(): Promise<readonly Device[]> };
  readonly connection: {
    status(): ConnectionStatus;
    onStatus(handler: (status: ConnectionStatus) => void): () => void;
    /** Uses a frozen approved host manifest; page cannot change app/scopes/profile. */
    connect(input: { readonly deviceId: string }): Promise<CentaurAIWanxSession>;
    disconnect(): Promise<void>;
  };
  dispose(): Promise<void>;
}
export interface CentaurAIWanxHost extends Omit<CentaurAIWanxAppClient, "connection"> {
  readonly connection: Omit<CentaurAIWanxAppClient["connection"], "connect"> & {
    connect(input: { readonly deviceId: string }): Promise<TrustedCentaurAIWanxSession>;
  };
}
declare const runtimeBrand: unique symbol;
export interface TrustedRuntime {
  readonly platform: "electron-main" | "go-native";
  readonly [runtimeBrand]: true;
}
export declare function createElectronRuntime(config: { readonly deploymentConfigPath: string }): TrustedRuntime;
export declare function createCentaurAIWanxHost(config: { readonly applicationManifestPath: string; readonly runtime: TrustedRuntime }): CentaurAIWanxHost;
