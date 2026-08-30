import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dump } from "js-yaml";
import type { AppSpec } from "./appspec/schema";
import { defineAppSpec } from "./definer/define";
import type { LLMClient } from "./definer/llm";
import { asList, asText, draftToIntent, fillGuesses, type PRDDraft } from "./definer/draft";
import { compile } from "./compiler/compile";
import { serializeAppPackage } from "./compiler/serialize";
import { renderPrd, rationaleOf } from "./prd/render";

export type PipelineResult =
  | { ok: true; appspec: AppSpec; files: Record<string, string>; repairs: number }
  | { ok: false; error: string };

/**
 * 编排层：一句话 + LLM 客户端 → 完整应用包。
 * 链路：定义（LLM→AppSpec）→ 编译（AppSpec→AppPackage）→ 序列化（→YAML 文件）。
 */
export async function runPipeline(
  intent: string,
  llm: LLMClient,
  options: {
    maxRepairs?: number;
    outDir?: string;
    includeCentaurPlugins?: boolean;
    /** preset 在 DSH 选择器里的排序值，见 CompileOptions.order。 */
    order?: number;
  } = {},
): Promise<PipelineResult> {
  const defined = await defineAppSpec(intent, llm, { maxRepairs: options.maxRepairs });
  if (!defined.ok) {
    return { ok: false, error: defined.error };
  }

  const pkg = compile(defined.value, {
    includeCentaurPlugins: options.includeCentaurPlugins,
    order: options.order,
  });
  const files = serializeAppPackage(pkg);

  if (options.outDir) {
    await writeAppPackage(files, options.outDir);
  }

  return { ok: true, appspec: defined.value, files, repairs: defined.repairs };
}

export type FinalizeResult =
  | { ok: true; appspec: AppSpec; files: Record<string, string>; draft: PRDDraft; repairs: number }
  | { ok: false; error: string };

/**
 * 确认后的组装：PRDDraft → AppSpec → 应用包 ＋ prd.md ＋ rationale.yml。
 *
 * 用户的选择是权威的：`workflow` / `boundaries` / `name` 在定义器返回后被草稿
 * **覆盖回去**，不让模型重新发挥。其余字段（domain、capabilities、枚举）仍由
 * 定义器从结构化草稿里映射——那些需要落到枚举上，不是自由文本。
 */
export async function runFinalize(
  draft: PRDDraft,
  llm: LLMClient,
  options: { turns?: number; date: string; order?: number; maxRepairs?: number } = { date: "" },
): Promise<FinalizeResult> {
  const filled = fillGuesses(draft);
  const defined = await defineAppSpec(draftToIntent(filled), llm, {
    maxRepairs: options.maxRepairs,
  });
  if (!defined.ok) return { ok: false, error: defined.error };

  const appspec: AppSpec = { ...defined.value };

  const steps = asList(filled.slots.workflow?.value);
  if (steps.length > 0) appspec.workflow = { steps };

  const bounds = asList(filled.slots.boundaries?.value);
  if (bounds.length > 0) appspec.boundaries = bounds;

  const wanted = asText(filled.derived.name).trim();
  if (wanted.length >= 2 && wanted.length <= 30) appspec.name = wanted;

  const pkg = compile(appspec, { includeCentaurPlugins: false, order: options.order });
  const files = serializeAppPackage(pkg);

  files["prd.md"] = renderPrd(filled, {
    name: appspec.name,
    turns: options.turns ?? 0,
    date: options.date,
  });
  files["rationale.yml"] = dump(rationaleOf(filled), { lineWidth: -1, noRefs: true });

  return { ok: true, appspec, files, draft: filled, repairs: defined.repairs };
}

/** 把应用包文件写到一个目录（文件名 → 内容）。 */
export async function writeAppPackage(
  files: Record<string, string>,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = join(outDir, name);
    // 文件名可以带子目录（技能包是 skills/<name>/SKILL.md），先把目录建出来。
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
  }
}
