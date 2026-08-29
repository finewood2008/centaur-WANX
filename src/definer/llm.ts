/** LLM 调用抽象接口。生产环境接真实模型，测试用 Fake 实现。 */
export interface LLMClient {
  complete(prompt: string): Promise<string>;
  /**
   * 流式调用：边生成边把增量喂给 onDelta，返回完整文本。
   * **可选**——不实现的客户端（比如测试用的 Fake）照常工作，调用方回退到 complete。
   */
  stream?(prompt: string, onDelta: (text: string) => void): Promise<string>;
}

/** 测试用：按预设响应序列逐个返回，序列耗尽后返回空字符串。 */
export class FakeLLMClient implements LLMClient {
  constructor(private readonly responses: string[]) {}

  async complete(_prompt: string): Promise<string> {
    return this.responses.shift() ?? "";
  }
}
