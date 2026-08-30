import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import type { AppSpec } from "./appspec/schema";

/** 单个参数声明(AppSpec.params 的元素类型)。 */
export type AppParam = AppSpec["params"][number];

/**
 * 参数的运行期取值层。
 *
 * AppSpec.params 是访谈里声明的「有哪些旋钮」;**用户拧到哪一档**是运行期
 * 状态,与 schedule.yml 同款哲学:放 `<appsDir>/<slug>/params.yml`,不进
 * 冻结的规格。跑一次和定时跑都用这里存好的值——定时跑没有人在场,参数
 * 必须有持久落点,这不是 UX 偏好,是结构必然。
 */

export type ParamValues = Record<string, unknown>;

export function paramsFile(appsDir: string, slug: string): string {
  return join(appsDir, slug, "params.yml");
}

/** 读当前值。没有或坏了返回空对象(与 readSchedule 同款韧性)。 */
export async function readParamValues(appsDir: string, slug: string): Promise<ParamValues> {
  try {
    const parsed = load(await readFile(paramsFile(appsDir, slug), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = (parsed as { values?: unknown }).values;
      if (values && typeof values === "object" && !Array.isArray(values)) {
        return values as ParamValues;
      }
    }
  } catch {
    /* 没有就是没设置 */
  }
  return {};
}

export async function writeParamValues(
  appsDir: string,
  slug: string,
  values: ParamValues,
): Promise<void> {
  await mkdir(join(appsDir, slug), { recursive: true });
  await writeFile(paramsFile(appsDir, slug), dump({ values }, { lineWidth: -1, noRefs: true }), "utf-8");
}

/**
 * 按声明逐项校验用户输入。未知参数名丢弃(strip 哲学),类型不合给中文原因,
 * 全部通过才整体可写。空字符串视为「清掉这项」。
 */
export function validateParamValues(
  schema: readonly AppParam[],
  input: unknown,
): { ok: true; values: ParamValues } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "参数得是一个对象" };
  }
  const byName = new Map(schema.map((p) => [p.name, p]));
  const values: ParamValues = {};
  for (const [name, raw] of Object.entries(input as Record<string, unknown>)) {
    const spec = byName.get(name);
    if (!spec) continue; // 未知名丢弃
    const label = spec.label ?? spec.name;
    if (raw === undefined || raw === null || raw === "") continue; // 清掉
    switch (spec.type) {
      case "string": {
        if (typeof raw !== "string" || raw.trim() === "") {
          return { ok: false, error: `「${label}」得是一段文字` };
        }
        values[name] = raw.trim();
        break;
      }
      case "number": {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: `「${label}」得是个数字` };
        values[name] = n;
        break;
      }
      case "boolean": {
        if (typeof raw !== "boolean") return { ok: false, error: `「${label}」只能是开或关` };
        values[name] = raw;
        break;
      }
      case "enum": {
        if (typeof raw !== "string" || !(spec.options ?? []).includes(raw)) {
          return { ok: false, error: `「${label}」只能从给定的选项里选` };
        }
        values[name] = raw;
        break;
      }
      case "date": {
        if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
          return { ok: false, error: `「${label}」得是日期(YYYY-MM-DD)` };
        }
        values[name] = raw;
        break;
      }
      case "list": {
        const arr = Array.isArray(raw)
          ? raw
          : typeof raw === "string"
            ? raw.split("\n")
            : null;
        if (!arr || arr.some((x) => typeof x !== "string")) {
          return { ok: false, error: `「${label}」得是一行一条的清单` };
        }
        const cleaned = (arr as string[]).map((x) => x.trim()).filter((x) => x !== "");
        if (cleaned.length > 0) values[name] = cleaned;
        break;
      }
    }
  }
  return { ok: true, values };
}

/**
 * 任务文本里的「本次参数」段。开头声明生效值优先——手册「可调的」一节里
 * 渲染的是创建时的默认值,不声明的话模型会看到两个矛盾的数。
 * 没有任何参数声明时返回空数组(任务里不出现这一段)。
 */
export function buildParamsSection(
  schema: readonly AppParam[],
  values: ParamValues,
): string[] {
  if (schema.length === 0) return [];
  const lines = [
    "",
    "本次参数（工作手册「可调的」一节里的默认值，以这里的为准）：",
  ];
  for (const p of schema) {
    const label = p.label ?? p.name;
    const v = values[p.name] ?? p.default;
    if (v === undefined || v === null || v === "") {
      lines.push(
        p.required
          ? `- ${label}：（必填，还没设置——用你的判断，并在产出里提醒用户去设置）`
          : `- ${label}：未设置`,
      );
    } else if (Array.isArray(v)) {
      lines.push(`- ${label}：${v.join("、")}`);
    } else if (typeof v === "boolean") {
      lines.push(`- ${label}：${v ? "开" : "关"}`);
    } else {
      lines.push(`- ${label}：${String(v)}`);
    }
  }
  return lines;
}
