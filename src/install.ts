import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { load } from "js-yaml";
import { writeAppPackage } from "./pipeline";
import { workspaceDir } from "./runs";

/**
 * 应用包的落盘原语。创建(handleCreate/handleFinalize)与调教(applyRevision)
 * 共用同一条路径——写四处:
 *   1. `<appsDir>/<slug>/…`            应用包全套(app.yml、preset、技能副本、文档)
 *   2. `<dshHome>/.agent-presets/<slug>/` preset 的生效副本(roster 从这儿发现)
 *   3. `<workspace>/.dsh/skills/…`      技能的生效副本(运行时从 cwd 发现)
 *
 * 目录作为显式参数传入(而不是读模块常量),测试才能指到 temp 目录,
 * 也免得 server 与 tuning 之间长出循环依赖。
 */
export async function installApp(
  appsDir: string,
  dshHome: string,
  slug: string,
  files: Record<string, string>,
): Promise<string> {
  const appDir = join(appsDir, slug);
  await writeAppPackage(files, appDir);
  const presetDir = join(dshHome, ".agent-presets", slug);
  await mkdir(presetDir, { recursive: true });
  await writeFile(join(presetDir, "preset.yml"), files["preset.yml"] ?? "", "utf-8");
  await writeFile(join(presetDir, "agent.cordis.yml"), files["agent.cordis.yml"] ?? "", "utf-8");

  // 技能装进**应用自己的 workspace**:`<workspace>/.dsh/skills/<name>/SKILL.md`。
  //
  // preset 里的 `customSkillDirs` / `includeDefaultRoots` 实测不生效;真正通的
  // 那条根是 findProjectRoot(cwd) 之下的 `.dsh/skills`。所以隔离的做法是让共享
  // 根保持空,每个应用只看得见自己 workspace 里的手册。前提是 appsDir 在 git
  // 仓库之外——见 server.ts 里 APPS_DIR 的注释。
  const workspace = workspaceDir(appsDir, slug);
  for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith("skills/")) continue;
    const target = join(workspace, ".dsh", name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
  }
  return appDir;
}

/**
 * 读既有 preset.yml 里的 order(创建时刻的时间戳,决定选择器里的排序)。
 * 重编译(heal 与调教)都要保留它——洗掉的话用户的助手会在列表里跳位置。
 * 读不到(新装/文件坏了)返回 0。
 */
export async function readPresetOrder(appsDir: string, slug: string): Promise<number> {
  try {
    const preset = load(await readFile(join(appsDir, slug, "preset.yml"), "utf-8"));
    if (preset && typeof preset === "object" && typeof (preset as { order?: unknown }).order === "number") {
      return (preset as { order: number }).order;
    }
  } catch {
    /* 没有就用 0 */
  }
  return 0;
}
