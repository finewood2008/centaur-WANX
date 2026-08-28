/**
 * 从 LLM 输出中提取 JSON 对象。失败抛错。
 * 依次尝试：直接解析 → markdown 代码块 → 首个 {...} 块。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* continue */
    }
  }

  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace) {
    try {
      return JSON.parse(brace[0]);
    } catch {
      /* continue */
    }
  }

  throw new Error("无法从模型输出中提取 JSON");
}
