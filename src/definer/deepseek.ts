import type { LLMClient } from "./llm";
import { resolveBaseUrl, resolveKey, resolveModel } from "../config";

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

/**
 * 初始化客户端。key 先看环境变量，再看本地配置（`~/.config/wanxiang/config.json`）。
 *
 * 桌面应用是双击启动的，没有 shell 环境变量，所以配置文件这条路必须有——
 * 否则用户只能聊到一半被「缺少 DEEPSEEK_API_KEY」拦住。
 */
export function deepseekFromEnv(overrides?: Partial<DeepSeekConfig>): DeepSeekLLMClient {
  const apiKey = overrides?.apiKey ?? resolveKey();
  if (!apiKey) throw new Error("还没设置模型 key");
  return new DeepSeekLLMClient({
    apiKey,
    baseUrl: overrides?.baseUrl ?? resolveBaseUrl(),
    model: overrides?.model ?? resolveModel(),
  });
}

/**
 * 验一下这把 key 能不能用。用 /models 这个最便宜的接口，不消耗额度。
 * 返回 null 表示通过，否则是给用户看的中文原因。
 */
export async function verifyKey(apiKey: string, baseUrl?: string): Promise<string | null> {
  // HTTP 头只接受可见 ASCII。key 里混进空格或中文时，fetch 会抛一个
  // 「Cannot convert argument to a ByteString」的内部错误——那对用户毫无意义。
  if (!/^[\x21-\x7e]+$/u.test(apiKey)) {
    return "key 里有不该出现的字符（空格、换行或中文）。复制的时候可能带上了别的内容。";
  }
  const base = baseUrl?.trim() || "https://api.deepseek.com";
  try {
    const resp = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 401) return "这把 key 不被接受（401），检查一下有没有复制全。";
    if (resp.status === 402) return "这把 key 余额不足（402）。";
    if (!resp.ok) return `模型服务返回 ${resp.status}，暂时用不了。`;
    return null;
  } catch (e) {
    const reason = (e as Error).message;
    return `连不上模型服务：${reason}。如果你在代理后面，确认代理是通的。`;
  }
}
