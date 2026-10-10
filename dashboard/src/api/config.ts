import {
  LAYOUT_MODE_KEY,
  MINIMAL_NAV_PANE_KEY,
} from "../layouts/layoutModeStorage";
import { isWanxDesktopClient } from "../utils/desktopClient";
declare const BASE_URL: string;
// Set before AuthGuard, so even the first login request targets this box.
if (
  new URLSearchParams(window.location.search).get("wanx_client") === "remote"
) {
  localStorage.setItem("wanx:remote-client", "1");
  localStorage.setItem(LAYOUT_MODE_KEY, "minimal");
  localStorage.setItem(MINIMAL_NAV_PANE_KEY, "settings");
  localStorage.removeItem("auth_token");
  sessionStorage.removeItem("auth_token");
  localStorage.removeItem("octop:active-agent");
}

/**
 * Get the full API URL with /api prefix
 * @param path - API path (e.g., "/models", "/skills")
 * @returns Full API URL (e.g., "http://localhost:8088/api/models" or "/api/models")
 */
export function getApiUrl(path: string): string {
  const base =
    isWanxDesktopClient() || localStorage.getItem("wanx:remote-client") === "1"
      ? ""
      : BASE_URL || "";
  const apiPrefix = "/api";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${apiPrefix}${normalizedPath}`;
}

/**
 * Get a WebSocket URL derived from the same origin as the API.
 * Converts http:// → ws:// and https:// → wss://.
 * If BASE_URL is empty (same-origin), uses the current page location.
 * @param path - API path (e.g., "/browser-stream/ws")
 * @returns Full WebSocket URL
 */
export function getWsUrl(path: string): string {
  const base =
    isWanxDesktopClient() || localStorage.getItem("wanx:remote-client") === "1"
      ? ""
      : BASE_URL || "";
  const apiPrefix = "/api";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const httpUrl = `${base}${apiPrefix}${normalizedPath}`;

  if (httpUrl.startsWith("http://")) {
    return httpUrl.replace("http://", "ws://");
  }
  if (httpUrl.startsWith("https://")) {
    return httpUrl.replace("https://", "wss://");
  }

  // Relative URL — derive from current page location
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${httpUrl}`;
}
