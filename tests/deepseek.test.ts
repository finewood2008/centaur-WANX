import { describe, it, expect, vi, afterEach } from "vitest";
import { DeepSeekLLMClient, deepseekFromEnv } from "../src/definer/deepseek";

afterEach(() => vi.unstubAllGlobals());

describe("DeepSeekLLMClient", () => {
  it("构造正确的请求并解析响应", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DeepSeekLLMClient({ apiKey: "test-key" });
    const out = await client.complete("prompt");

    expect(out).toBe("hello");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("deepseek-chat");
    expect(body.messages[0].content).toBe("prompt");
    expect(body.temperature).toBe(0.2);
  });

  it("自定义 baseUrl 与 model", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DeepSeekLLMClient({
      apiKey: "k",
      baseUrl: "http://127.0.0.1:3090/v1",
      model: "deepseek-v4-pro",
    });
    await client.complete("x");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3090/v1/chat/completions");
    expect(JSON.parse(init.body as string).model).toBe("deepseek-v4-pro");
  });

  it("非 200 响应抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" }),
    );
    const client = new DeepSeekLLMClient({ apiKey: "bad" });
    await expect(client.complete("x")).rejects.toThrow(/401/);
  });

  it("空内容抛错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) }),
    );
    const client = new DeepSeekLLMClient({ apiKey: "k" });
    await expect(client.complete("x")).rejects.toThrow(/空内容/);
  });
});

describe("deepseekFromEnv", () => {
  it("缺少 API key 时抛错", () => {
    const old = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => deepseekFromEnv()).toThrow(/DEEPSEEK_API_KEY/);
    if (old) process.env.DEEPSEEK_API_KEY = old;
  });
});
