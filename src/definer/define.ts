import type { AppSpec } from "../appspec/schema";
import { validateAppSpec } from "../appspec/validate";
import type { LLMClient } from "./llm";
import { buildDefinePrompt, buildRepairPrompt } from "./prompt";
import { extractJson } from "./parse";
import { normalizeAppSpec } from "./normalize";

export type DefineResult =
  | { ok: true; value: AppSpec; repairs: number }
  | { ok: false; error: string };

/**
 * 定义器：把用户意图经 LLM 转成 AppSpec。
 * LLM 输出必须通过 schema 校验；失败则把错误反馈回去重试（最多 maxRepairs 次）。
 */
export async function defineAppSpec(
  intent: string,
  llm: LLMClient,
  options: { maxRepairs?: number } = {},
): Promise<DefineResult> {
  const maxRepairs = options.maxRepairs ?? 2;
  let lastError = "";

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const prompt =
      attempt === 0 ? buildDefinePrompt(intent) : buildRepairPrompt(intent, lastError);

    const output = await llm.complete(prompt);

    let parsed: unknown;
    try {
      parsed = normalizeAppSpec(extractJson(output));
    } catch (e) {
      lastError = (e as Error).message;
      continue;
    }

    const result = validateAppSpec(parsed);
    if (result.ok) {
      return { ok: true, value: result.value, repairs: attempt };
    }
    lastError = result.errors.join("; ");
  }

  return { ok: false, error: lastError || "定义失败" };
}
