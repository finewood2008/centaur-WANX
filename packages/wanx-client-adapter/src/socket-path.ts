import { WanxError } from "./errors.js";
import type { SocketInput } from "./types.js";
const paths = {
  chat: "/api/agents/{agent_id}/chat/ws", terminal: "/api/agents/{agent_id}/terminal/ws",
  notifications: "/api/notifications/ws", "browser-stream": "/api/browser-stream/ws",
  "desktop-stream": "/api/desktop-stream/ws", "mobile-stream": "/api/mobile-stream/ws",
  "mobile-adb-shell": "/api/mobile/adb/shell/ws",
} as const;
export function socketPath(input: SocketInput): string {
  let path: string = paths[input.endpoint]; if (!path) throw new WanxError("UNKNOWN_SOCKET");
  if (path.includes("{agent_id}")) {
    if (!input.agentId || /[\/\\\r\n\0]/u.test(input.agentId) || [".", ".."].includes(input.agentId)) throw new WanxError("INVALID_AGENT_ID");
    path = path.replace("{agent_id}", encodeURIComponent(input.agentId));
  }
  const q = new URLSearchParams();
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (["token", "access_token", "as_user"].includes(name)) throw new WanxError("PUBLIC_CREDENTIAL_OVERRIDE");
    q.append(name, String(value));
  }
  return path + (q.size ? "?" + q.toString() : "");
}
