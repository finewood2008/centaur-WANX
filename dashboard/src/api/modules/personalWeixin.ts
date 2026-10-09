import { request } from "../request";

export interface PersonalWeixinChannel {
  id: string;
  agent_id: string;
  kind: string;
  name: string;
  enabled: boolean;
  runtime?: { connected: boolean; reason?: string; detail?: string };
}
export const personalWeixinApi = {
  list: (agentId: string) =>
    request<PersonalWeixinChannel[]>(`/agents/${agentId}/channels`),
  generate: (agentId: string, signal?: AbortSignal) =>
    request<{ qrcode_token: string; qrcode_url: string }>(
      `/agents/${agentId}/channels/weixin/qrcode/generate`,
      { method: "POST", signal },
    ),
  poll: (agentId: string, qrcode_token: string, signal?: AbortSignal) =>
    request<{
      status: "wait" | "error" | "success";
      channel_id?: string;
      message?: string;
    }>(`/agents/${agentId}/channels/weixin/qrcode/poll`, {
      method: "POST",
      body: JSON.stringify({ qrcode_token }),
      signal,
    }),
  setEnabled: (agentId: string, id: string, enabled: boolean) =>
    request<PersonalWeixinChannel>(
      `/agents/${agentId}/channels/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ enabled }) },
    ),
};
