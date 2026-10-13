export interface HostStreamEvents {
  open: [];
  message: [data: Uint8Array, binary: boolean];
  close: [code: number, reason: Uint8Array];
  error: [error: Error];
}
export interface HostStream {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string | Uint8Array, options?: {binary?: boolean}, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string | Uint8Array): void;
  terminate(): void;
  on<K extends keyof HostStreamEvents>(event: K, listener: (...args: HostStreamEvents[K]) => void): this;
  once<K extends keyof HostStreamEvents>(event: K, listener: (...args: HostStreamEvents[K]) => void): this;
  removeListener<K extends keyof HostStreamEvents>(event: K, listener: (...args: HostStreamEvents[K]) => void): this;
}
export interface HostContext {
  protocolVersion?: number;
  accountId?: string;
  clientId?: string;
  boxId: string;
  user: { id: number; [key: string]: unknown };
  connection: 'ready' | 'recovering';
}
export interface HostClient {
  context(): Promise<HostContext>;
  request(path: string, options?: {
    method?: string; headers?: HeadersInit;
    /** JSON, string, Uint8Array/Buffer, Node Readable, or Web ReadableStream<Uint8Array>.
     * Streams are consumed once and destroyed/cancelled when the request stops. */
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<Response>;
  openStream(path: string, options?: { headers?: HeadersInit; protocols?: string[] }): Promise<HostStream>;
  onSessionInvalidated(listener: (event: {code: 'HOST_SESSION_EXPIRED'}) => void): () => void;
  close(): void;
}
export function createHostClient(options: {baseURL: string; token: string; timeoutMs?: number}): HostClient;
export function fromEnvironment(env?: Record<string, string | undefined>): HostClient | null;
