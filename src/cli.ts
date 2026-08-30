import { join } from "node:path";
import { runPipeline, writeAppPackage } from "./pipeline";
import { deepseekFromEnv } from "./definer/deepseek";
import { slugFromName } from "./appspec/slug";

export interface CliOptions {
  out: string;
  model?: string;
  baseUrl?: string;
  noMemory: boolean;
  maxRepairs: number;
}

export function parseArgs(argv: string[]): { intent: string; options: CliOptions } {
  const options: CliOptions = { out: "./wanxiang-apps", noMemory: false, maxRepairs: 3 };
  let intent = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") options.out = argv[++i];
    else if (a === "--model") options.model = argv[++i];
    else if (a === "--base-url") options.baseUrl = argv[++i];
    else if (a === "--no-memory") options.noMemory = true;
    else if (a === "--max-repairs") options.maxRepairs = Number(argv[++i]);
    else if (a === "-h" || a === "--help") break;
    else if (!a.startsWith("-") && intent === "") intent = a;
  }
  return { intent, options };
}

export function printUsage(): string {
  return `万象 —— 超级个体的应用创造器

用法: wanxiang "<意图描述>" [选项]

选项:
  -o, --out <dir>      输出目录（默认 ./wanxiang-apps，按应用名建子目录）
  --model <name>       DeepSeek 模型名（默认 deepseek-chat）
  --base-url <url>     API 地址（默认 https://api.deepseek.com）
  --no-memory          不挂尚未实现的记忆插件（过滤 @centaur/* 知君占位行，M0 阶段用）
  --max-repairs <n>    定义失败重试次数（默认 3）
  -h, --help           显示帮助`;
}

/** CLI 主流程，返回进程退出码。 */
export async function runCli(argv: string[]): Promise<number> {
  const { intent, options } = parseArgs(argv);
  if (intent === "") {
    console.log(printUsage());
    return 0;
  }

  console.log(`\n万象：正在根据意图生成应用……`);
  console.log(`  意图: ${intent}\n`);

  const llm = deepseekFromEnv({ model: options.model, baseUrl: options.baseUrl });
  const r = await runPipeline(intent, llm, {
    maxRepairs: options.maxRepairs,
    includeCentaurPlugins: !options.noMemory,
  });

  if (!r.ok) {
    console.error(`\n生成失败: ${r.error}`);
    return 1;
  }

  const appDir = join(options.out, slugFromName(r.appspec.name));
  await writeAppPackage(r.files, appDir);

  console.log(`✓ 应用「${r.appspec.name}」已生成（修复 ${r.repairs} 次）`);
  console.log(`  preset id: ${slugFromName(r.appspec.name)}`);
  console.log(`  领域: ${r.appspec.domain}`);
  console.log(`  能力: ${r.appspec.capabilities.join(", ")}`);
  console.log(`  落盘: ${appDir}`);
  console.log(`  文件: ${Object.keys(r.files).join(", ")}`);
  return 0;
}
