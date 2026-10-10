/** A box switch replaces the document: no mutable global API destination. */
export const BOX_SESSION_EVENT = "wanx:box-session";
export const BOX_DIRECTORY_KEY = "wanx:boxes:v1";
export type BoxAddress = { name: string; url: string };
let stopped = false;
let monitored = false;
const lifetime = new AbortController();
const sockets = new Set<WebSocket>();

export function normalizeBoxUrl(raw: string): string {
  const url = new URL(raw.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error("INVALID_BOX_URL");
  return url.origin;
}

export function loadBoxes(): BoxAddress[] {
  try {
    const data: unknown = JSON.parse(
      localStorage.getItem(BOX_DIRECTORY_KEY) || "[]",
    );
    if (!Array.isArray(data)) return [];
    return data.filter((row): row is BoxAddress => {
      try {
        return (
          typeof row.name === "string" && normalizeBoxUrl(row.url) === row.url
        );
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function saveBoxes(boxes: BoxAddress[]): void {
  localStorage.setItem(
    BOX_DIRECTORY_KEY,
    JSON.stringify(
      boxes.map((box) => ({
        name: box.name.trim().slice(0, 80),
        url: normalizeBoxUrl(box.url),
      })),
    ),
  );
}

export function stopBoxSession(reason: "offline" | "switch" | "revoked"): void {
  if (stopped) return;
  stopped = true;
  lifetime.abort();
  for (const socket of sockets) socket.close(1000, reason);
  sockets.clear();
  window.dispatchEvent(new CustomEvent(BOX_SESSION_EVENT, { detail: reason }));
}

export function boxSessionStopped(): boolean {
  return stopped;
}
export function monitorBoxSession(): void {
  monitored = true;
}

export function boxSignal(signal?: AbortSignal | null): AbortSignal {
  if (!signal) return lifetime.signal;
  // Also works in older WebViews which don't implement AbortSignal.any.
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([signal, lifetime.signal]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted || lifetime.signal.aborted) abort();
  else {
    signal.addEventListener("abort", abort, {
      once: true,
      signal: controller.signal,
    });
    lifetime.signal.addEventListener("abort", abort, {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

export async function boxFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (stopped) throw new DOMException("Box session closed", "AbortError");
  try {
    return await fetch(input, { ...init, signal: boxSignal(init.signal) });
  } catch (error) {
    // Explicit cancellation of a page request is not a network outage.
    if (
      monitored &&
      !init.signal?.aborted &&
      !stopped &&
      !(error instanceof DOMException && error.name === "AbortError")
    ) {
      stopBoxSession("offline");
    }
    throw error;
  }
}

export function openBoxSocket(url: string): WebSocket {
  if (stopped) throw new DOMException("Box session closed", "AbortError");
  const socket = new WebSocket(url);
  sockets.add(socket);
  socket.addEventListener("close", () => sockets.delete(socket), {
    once: true,
  });
  return socket;
}

/** Destination receives only a local UI preference, never the source box token. */
export function boxDestination(raw: string): string {
  return `${normalizeBoxUrl(raw)}/boxes?wanx_client=remote`;
}

export function switchBox(raw: string, clearCredentials: () => void): void {
  const destination = boxDestination(raw); // validate before destroying the current session
  stopBoxSession("switch");
  clearCredentials();
  window.location.assign(destination);
}

export function openNativeBoxChooser(): boolean {
  const invoke = (
    window as Window & { _wails?: { invoke?: (value: string) => void } }
  )._wails?.invoke;
  if (!invoke) return false;
  stopBoxSession("switch");
  invoke("wails:event:emit:desktop:boxes");
  return true;
}

window.addEventListener("wanx:leave-box", () => stopBoxSession("switch"));
window.addEventListener("pagehide", () => stopBoxSession("switch"));
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
