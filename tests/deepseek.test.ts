import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("环境变量和配置文件都没有 key 时抛错", () => {
    const oldKey = process.env.DEEPSEEK_API_KEY;
    const oldCfg = process.env.WANXIANG_CONFIG;
    delete process.env.DEEPSEEK_API_KEY;
    // 指到一个不存在的路径，免得读到本机真实配置里的 key 让用例时灵时不灵。
    process.env.WANXIANG_CONFIG = join(tmpdir(), `wanx-none-${Math.random()}.json`);
    expect(() => deepseekFromEnv()).toThrow(/还没设置模型 key/);
    if (oldKey) process.env.DEEPSEEK_API_KEY = oldKey;
    if (oldCfg === undefined) delete process.env.WANXIANG_CONFIG;
    else process.env.WANXIANG_CONFIG = oldCfg;
  });

  it("环境变量没有时用配置文件里的 key", async () => {
    const { writeConfig } = await import("../src/config");
    const oldKey = process.env.DEEPSEEK_API_KEY;
    const oldCfg = process.env.WANXIANG_CONFIG;
    const dir = mkdtempSync(join(tmpdir(), "wanx-ds-"));
    delete process.env.DEEPSEEK_API_KEY;
    process.env.WANXIANG_CONFIG = join(dir, "config.json");
    writeConfig({ deepseekApiKey: "sk-from-config" });
    expect(() => deepseekFromEnv()).not.toThrow();
    if (oldKey) process.env.DEEPSEEK_API_KEY = oldKey;
    if (oldCfg === undefined) delete process.env.WANXIANG_CONFIG;
    else process.env.WANXIANG_CONFIG = oldCfg;
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("verifyKey", () => {
  it("key 里有非 ASCII 字符时给人话，而不是 ByteString 内部错误", async () => {
    const { verifyKey } = await import("../src/definer/deepseek");
    expect(await verifyKey("sk-这是中文")).toMatch(/不该出现的字符/);
  });

  it("带空格或换行的 key 也拦下来", async () => {
    const { verifyKey } = await import("../src/definer/deepseek");
    expect(await verifyKey("sk-abc def")).toMatch(/不该出现的字符/);
    expect(await verifyKey("sk-abc\n")).toMatch(/不该出现的字符/);
  });
});
