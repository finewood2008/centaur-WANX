import type { LLMClient } from "./llm";

export interface DeepSeekConfig {
  apiKey: string;
  /** 默认 https://api.deepseek.com；gateway 部署时覆盖 */
  baseUrl?: string;
  /** 默认 deepseek-chat */
  model?: string;
}

/** DeepSeek（OpenAI 兼容）LLM 客户端，用原生 fetch。 */
export class DeepSeekLLMClient implements LLMClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly config: DeepSeekConfig) {
    this.baseUrl = config.baseUrl ?? "https://api.deepseek.com";
    this.model = config.model ?? "deepseek-chat";
  }

  async complete(prompt: string): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`DeepSeek API 错误 ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("DeepSeek API 返回空内容");
    }
    return content;
  }

  /** 流式调用。逐块解析 OpenAI 兼容的 `data:` 行，把 delta 喂给回调。 */
  async stream(prompt: string, onDelta: (text: string) => void): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        stream: true,
      }),
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw new Error(`DeepSeek API 错误 ${resp.status}: ${text}`);
    }

    const decoder = new TextDecoder();
    const reader = resp.body.getReader();
    let buffer = "";
    let full = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta !== "") {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // 半个 JSON——留给下一块拼上，不该中断整条流。
        }
      }
    }

    if (full === "") throw new Error("DeepSeek API 返回空内容");
    return full;
  }
}

/** 从环境变量初始化：DEEPSEEK_API_KEY（必填）、DEEPSEEK_BASE_URL（可选）。 */
export function deepseekFromEnv(overrides?: Partial<DeepSeekConfig>): DeepSeekLLMClient {
  const apiKey = overrides?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY 环境变量");
  return new DeepSeekLLMClient({
    apiKey,
    baseUrl: overrides?.baseUrl ?? process.env.DEEPSEEK_BASE_URL,
    model: overrides?.model,
  });
}
