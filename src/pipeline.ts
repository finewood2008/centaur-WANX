import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSpec } from "./appspec/schema";
import { defineAppSpec } from "./definer/define";
import type { LLMClient } from "./definer/llm";
import { compile } from "./compiler/compile";
import { serializeAppPackage } from "./compiler/serialize";

export type PipelineResult =
  | { ok: true; appspec: AppSpec; files: Record<string, string>; repairs: number }
  | { ok: false; error: string };

/**
 * 编排层：一句话 + LLM 客户端 → 完整应用包。
 * 链路：定义（LLM→AppSpec）→ 编译（AppSpec→AppPackage）→ 序列化（→YAML 文件）。
 * 若提供 outDir，则把应用包落盘到该目录（作为应用包根目录）。
 */
export async function runPipeline(
  intent: string,
  llm: LLMClient,
  options: { maxRepairs?: number; outDir?: string; includeCentaurPlugins?: boolean } = {},
): Promise<PipelineResult> {
  const defined = await defineAppSpec(intent, llm, { maxRepairs: options.maxRepairs });
  if (!defined.ok) {
    return { ok: false, error: defined.error };
  }

  const pkg = compile(defined.value, { includeCentaurPlugins: options.includeCentaurPlugins });
  const files = serializeAppPackage(pkg);

  if (options.outDir) {
    await writeAppPackage(files, options.outDir);
  }

  return {
    ok: true,
    appspec: defined.value,
    files,
    repairs: defined.repairs,
  };
}

/** 把应用包文件写到一个目录（文件名 → 内容）。 */
export async function writeAppPackage(
  files: Record<string, string>,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(outDir, name), content, "utf-8");
  }
}
