import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
describe("box connection lifetime", () => {
  it("rejects credentials, plain network HTTP, paths and query handoffs", async () => {
    const { normalizeBoxUrl } = await import("./boxConnection");
    for (const raw of [
      "http://192.168.1.2",
      "https://user:pass@box.test",
      "https://box.test/api",
      "https://box.test?token=secret",
      "file:///etc/passwd",
      "https://box.test/#token",
    ])
      expect(() => normalizeBoxUrl(raw)).toThrow();
    expect(normalizeBoxUrl("https://box.test:8443/")).toBe(
      "https://box.test:8443",
    );
    expect(normalizeBoxUrl("http://[::1]:8088")).toBe("http://[::1]:8088");
  });
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
  it("switch destinations contain no source identity and invalid input preserves a live session", async () => {
    const box = await import("./boxConnection");
    expect(box.boxDestination("https://b.test")).toBe(
      "https://b.test/boxes?wanx_client=remote",
    );
    const clear = vi.fn();
    expect(() => box.switchBox("https://b.test?token=x", clear)).toThrow();
    expect(clear).not.toHaveBeenCalled();
    expect(box.boxSessionStopped()).toBe(false);
  });
});
