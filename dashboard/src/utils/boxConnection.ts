/** A box switch replaces the document: no mutable global API destination. */
export const BOX_SESSION_EVENT = "wanx:box-session";
let stopped = false;
let monitored = false;
const lifetime = new AbortController();
const sockets = new Set<WebSocket>();

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

window.addEventListener("wanx:leave-box", () => stopBoxSession("switch"));
window.addEventListener("pagehide", () => stopBoxSession("switch"));
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
