import {
  createCentaurAIWanxClient,
  applicationOperationRegistry,
  type WanxTransport,
} from "centaurai-wanx/browser";
import { request } from "../request";
import { stopBoxSession } from "../../utils/boxConnection";
export type * from "centaurai-wanx/browser";

// The existing same-origin adapter owns JWT renewal, locale and disconnects.
// The SDK owns operation serialization, contracts, policy and the facade.
const transport: WanxTransport = {
  capabilities: {
    httpUnary: true,
    httpResponseStream: false,
    websocketMessages: false,
    uploadStream: false,
    maxRequestBodyBytes: 2 * 1024 * 1024,
    networkPath: "direct",
  },
  async request(wire, options) {
    const body = await request(wire.path.replace(/^\/api/, ""), {
      method: wire.method,
      headers: wire.headers,
      body: wire.body ? new TextDecoder().decode(wire.body) : undefined,
      signal: options?.signal,
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      chunks: (async function* () {
        yield new TextEncoder().encode(JSON.stringify(body));
      })(),
      close: async () => {},
    };
  },
  async openSocket() {
    throw new Error("SOCKET_NOT_SUPPORTED");
  },
  async close() {},
};

export function createApplicationsSession() {
  const client = createCentaurAIWanxClient({
    transport,
    policy: {
      applicationId: "wanx",
      operations: applicationOperationRegistry
        .filter((operation) => operation.path.startsWith("/api/admin/"))
        .map((operation) => operation.operationId),
      sockets: [],
    },
  });
  return client;
}

export function reportApplicationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Request failed: 401/.test(message)) stopBoxSession("revoked");
  return message;
}
