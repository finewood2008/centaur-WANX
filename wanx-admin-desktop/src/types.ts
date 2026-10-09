export type Row = Record<string, any>;
export interface Box {
  id: string;
  name: string;
  connection: "https" | "p2p";
  baseURL?: string;
  deviceId?: string;
}
export interface AdminState {
  status: "disconnected" | "connecting" | "connected";
  sessionId: string | null;
  boxes: Box[];
  box: Box | null;
  user: {
    id: number;
    username: string;
    role: string;
    permissions: string[];
  } | null;
  capabilities: Row | null;
  error: string | null;
  timezone: string;
}
export interface Bridge {
  invoke(
    action: string,
    payload?: Row,
    sessionId?: string | null,
  ): Promise<any>;
  onState(callback: (state: AdminState) => void): () => void;
  onDesktop(callback: (frame: Row) => void): () => void;
}
declare global {
  interface Window {
    wanxAdmin?: Bridge;
  }
}
export const emptyState: AdminState = {
  status: "disconnected",
  sessionId: null,
  boxes: [],
  box: null,
  user: null,
  capabilities: null,
  error: null,
  timezone: "Asia/Shanghai",
};
export const permission = (state: AdminState, key: string) =>
  state.status === "connected" &&
  (state.user?.role === "admin" || state.user?.permissions.includes(key));
export const productPermission = (state: AdminState) =>
  permission(state, "applications_manage") ||
  permission(state, "applications_develop");
export function collection(data: any): Row[] {
  return Array.isArray(data)
    ? data
    : data?.items ??
        data?.users ??
        data?.roles ??
        data?.plugins ??
        data?.packages ??
        data?.entries ??
        (data ? [data] : []);
}
export function formatTime(value: any, timezone: string): string {
  if (!value) return "—";
  const date =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        dateStyle: "short",
        timeStyle: "medium",
      }).format(date);
}
