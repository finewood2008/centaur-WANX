import { z } from "zod";
import { AppSpecSchema, type AppSpec } from "./schema";

const KNOWN_TOP_LEVEL_KEYS = [
  "schema_version",
  "name",
  "description",
  "goal",
  "domain",
  "persona_note",
  "memory_binding",
  "capabilities",
  "delivery",
  "workflow",
  "boundaries",
  "params",
] as const;

export type ValidationResult =
  | { ok: true; value: AppSpec; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * 校验一个未知输入是否为合法 AppSpec。
 * - 成功：返回规范化后的 value（默认值已填充）+ warnings。
 * - 失败：返回逐字段的错误信息 + warnings。
 * - 未知字段：忽略（向前兼容）并在 warnings 里告警。
 */
export function validateAppSpec(input: unknown): ValidationResult {
  const warnings: string[] = [];

  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const unknown = Object.keys(input).filter((k) => !KNOWN_TOP_LEVEL_KEYS.includes(k as never));
    if (unknown.length > 0) {
      warnings.push(`忽略未知字段: ${unknown.join(", ")}`);
    }
  }

  const result = AppSpecSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data, warnings };
  }

  const errors = result.error.issues.map(formatIssue);
  return { ok: false, errors, warnings };
}

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}
