import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
describe("box connection lifetime", () => {
  it("abort closes HTTP and WebSocket; blocked sessions cannot write or reopen streams", async () => {
    const closed = vi.fn();
    vi.stubGlobal(
      "WebSocket",
      class {
        close = closed;
        addEventListener = vi.fn();
      },
    );
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_input, init) => {
      signal = init.signal;
      return new Promise<Response>((_, reject) =>
        signal!.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const box = await import("./boxConnection");
    box.openBoxSocket("wss://a.test/api/desktop/stream");
    const pending = box
      .boxFetch("https://a.test/api/admin/applications", { method: "PUT" })
      .catch((error) => error);
    box.stopBoxSession("switch");
    expect(signal?.aborted).toBe(true);
    expect(closed).toHaveBeenCalledWith(1000, "switch");
    expect((await pending).name).toBe("AbortError");
    await expect(
      box.boxFetch("https://b.test/api/admin/applications", { method: "POST" }),
    ).rejects.toThrow();
    expect(() =>
      box.openBoxSocket("wss://b.test/api/desktop/stream"),
    ).toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("manual cancellation stays local; a genuine transport failure freezes the box", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    const box = await import("./boxConnection");
    box.monitorBoxSession();
    const controller = new AbortController();
    controller.abort();
    await box
      .boxFetch("/api/health", { signal: controller.signal })
      .catch(() => {});
    expect(box.boxSessionStopped()).toBe(false);
    await box.boxFetch("/api/health").catch(() => {});
    expect(box.boxSessionStopped()).toBe(true);
  });
});
