/**
 * 把 `examples/` 里的示例助手装进本机，让人一打开就有东西可看。
 *
 * 为什么需要：万象的第一屏是「造一个助手」，而造助手要模型 key。没有 key 的
 * 访客看不到任何东西——看不到助手主页、看不到「跑一次」、更看不到交付物长什么样。
 * 预置一个**跑过一次**的示例，这些全都不需要 key 就能看。
 *
 * 装两处，跟 server.ts 的 installApp 一致：
 *   <APPS_DIR>/<slug>/                        应用包 + 资料 + 历史产出
 *   <APPS_DIR>/<slug>/workspace/.dsh/skills/  工作手册（按助手隔离）
 *   $DSH_HOME/.agent-presets/<slug>/          preset，配了 key 之后能真的跑起来
 *
 * 幂等：已经装过就跳过，不覆盖用户自己改过的东西。
 *
 * 跑法：npm run seed-demo
 */
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(PROJECT, "examples");

// 跟 src/server.ts 保持一致：应用落盘必须在 git 仓库之外，
// 否则 findProjectRoot 会一路走到仓库根，所有助手共享同一个 .dsh/skills。
const APPS_DIR =
  process.env.WANXIANG_APPS ?? join(homedir(), ".local", "share", "wanxiang", "apps");
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(PROJECT, ".dsh-home");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 从 app.yml 里读 name，只为把日志写得像人话。 */
async function nameOf(dir: string): Promise<string> {
  try {
    const text = await readFile(join(dir, "app.yml"), "utf-8");
    return /^name:\s*(.+)$/mu.exec(text)?.[1]?.trim() ?? "(无名)";
  } catch {
    return "(无名)";
  }
}

/** preset 目录名＝slug，从 skills/<slug>-workflow 反推，免得再引一次哈希函数。 */
async function slugOf(dir: string): Promise<string | null> {
  try {
    const names = await readdir(join(dir, "skills"));
    const hit = names.map((n) => /^(app-[a-z0-9]+)-workflow$/u.exec(n)).find(Boolean);
    return hit ? hit[1] : null;
  } catch {
    return null;
  }
}

async function seed(exampleDir: string): Promise<void> {
  const slug = await slugOf(exampleDir);
  if (!slug) {
    console.warn(`  跳过 ${exampleDir}：认不出 slug`);
    return;
  }
  const label = await nameOf(exampleDir);
  const target = join(APPS_DIR, slug);

  if (await exists(target)) {
    console.log(`  已存在，跳过：「${label}」(${slug})`);
    return;
  }

  await mkdir(APPS_DIR, { recursive: true });
  await cp(exampleDir, target, { recursive: true });

  // 工作手册装进助手自己的 workspace。共享的 $DSH_HOME/skills/ 一个字都不写——
  // 隔离靠的正是「让共享根保持空」。
  const skillsSrc = join(target, "skills");
  if (await exists(skillsSrc)) {
    await cp(skillsSrc, join(target, "workspace", ".dsh", "skills"), { recursive: true });
  }

  // preset 装进 DSH_HOME，配了 key 之后这个示例助手能真的跑起来。
  const presetDir = join(DSH_HOME, ".agent-presets", slug);
  await mkdir(presetDir, { recursive: true });
  for (const f of ["preset.yml", "agent.cordis.yml"]) {
    const from = join(target, f);
    if (await exists(from)) await writeFile(join(presetDir, f), await readFile(from, "utf-8"), "utf-8");
  }

  const runs = await readdir(join(target, "runs")).catch(() => [] as string[]);
  console.log(`  装好了：「${label}」(${slug})，含 ${runs.length} 次历史产出`);
}

const entries = await readdir(EXAMPLES, { withFileTypes: true }).catch(() => []);
const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(EXAMPLES, e.name));

if (dirs.length === 0) {
  console.log("examples/ 下没有示例，什么也没做。");
} else {
  console.log(`装示例助手 → ${APPS_DIR}`);
  for (const d of dirs) await seed(d);
  console.log("好了。跑 `npm start`，侧边栏里就能看到它。");
}
