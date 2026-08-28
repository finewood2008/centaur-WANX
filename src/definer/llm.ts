/** LLM 调用抽象接口。生产环境接真实模型，测试用 Fake 实现。 */
export interface LLMClient {
  complete(prompt: string): Promise<string>;
}

/** 测试用：按预设响应序列逐个返回，序列耗尽后返回空字符串。 */
export class FakeLLMClient implements LLMClient {
  constructor(private readonly responses: string[]) {}

  async complete(_prompt: string): Promise<string> {
    return this.responses.shift() ?? "";
  }
}
