/** Browser-safe entry: host networking/auth remains the caller's responsibility. */
export { createCentaurAIWanxClient } from "./client.js";
export { applicationOperationRegistry } from "./generated/applications-registry.js";
export { projectTemplates } from "./project-templates.js";
export type * from "./application-contracts.js";
export type { WanxTransport, CallOptions, ByteResponse, NativeResponse } from "./types.js";
