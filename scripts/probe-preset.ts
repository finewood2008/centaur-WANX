/**
 * 验证 1：万象生成的 preset 能不能被 DSH 的 agent-presets 发现并 mount。
 *
 * 这是 (B)/(C) 方向的地基。spike.ts 当年验的是人读 slug（"customer-followup"），
 * 而现在的产物是 `app-<sha10>`；spike 也从没对着 $DSH_HOME/.agent-presets 验过
 * ——它只给了 shippedRoot，指望 loadProfile 的 userLayer 把用户根带进来。
 *
 * 本探针不碰 DeepSeek：造应用包全是纯函数，agentPresets.list()/mount()
 * 也都发生在任何模型调用之前。
 *
 * 跑法：npx tsx scripts/probe-preset.ts
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAppSpec } from "../src/appspec/validate";
import { compile } from "../src/compiler/compile";
import { serializeAppPackage } from "../src/compiler/serialize";
import { slugFromName } from "../src/appspec/slug";
import { WanxiangRuntime } from "../src/runtime/dsh-runtime";

const require = createRequire(import.meta.url);
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(PROJECT, ".dsh-home");

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/* ── 1. 造一个应用包（纯函数，不需要 LLM） ───────────────────────── */

step("1. 用纯函数造一个应用包");

const raw = {
  schema_version: "1.0",
  name: "探针助手",
  description: "只用来验证 preset 能不能被 DSH 发现并挂载的最小应用",
  goal: "验证 agentPresets.mount 能加载万象生成的 user preset",
  domain: "general",
  memory_binding: { read: ["*"], write: [], retrieval: "semantic" },
  capabilities: ["summarize"],
  delivery: { form: "一句话回复", trigger: "manual", output: "chat" },
  workflow: { steps: ["读一遍手册", "报出你能用的技能"] },
  boundaries: ["不要联网"],
};

const validated = validateAppSpec(raw);
if (!validated.ok) {
  bad(`AppSpec 不合法: ${validated.errors.join("; ")}`);
  process.exit(1);
}
ok("AppSpec 校验通过");

// includeCentaurPlugins 必须是 false —— @centaur/* 是不存在的占位插件，
// 带上它们 mount 会因为「插件加载不了」而失败，那是错误的失败原因。
// web 路径（server.ts:handleCreate / runFinalize）同样写死 false。
const pkg = compile(validated.value, { includeCentaurPlugins: false });
const files = serializeAppPackage(pkg);
const slug = slugFromName(validated.value.name);
ok(`slug = ${slug}`);
ok(`插件清单 = ${pkg.preset.agentCordis.map((e) => e.id).join(", ")}`);
ok(`技能文件 = ${pkg.skill ? pkg.skill.path : "(无)"}`);

/* ── 2. 装进 DSH_HOME（复刻 server.ts:installApp） ────────────────── */

step("2. 装进 DSH_HOME");
console.log(`  DSH_HOME = ${DSH_HOME}`);

const presetDir = join(DSH_HOME, ".agent-presets", slug);
mkdirSync(presetDir, { recursive: true });
writeFileSync(join(presetDir, "preset.yml"), files["preset.yml"] ?? "", "utf-8");
writeFileSync(join(presetDir, "agent.cordis.yml"), files["agent.cordis.yml"] ?? "", "utf-8");
ok(`preset 装到 ${presetDir}`);

for (const [name, content] of Object.entries(files)) {
  if (!name.startsWith("skills/")) continue;
  const target = join(DSH_HOME, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf-8");
  ok(`技能装到 ${target}`);
}

/* ── 3. Pass A：用 WanxiangRuntime 原样跑（同时验证那份死代码） ──── */

step("3. Pass A —— WanxiangRuntime 原样（只有 shippedRoot）");

const cwd = join(PROJECT, ".workspace", "probe");
rmSync(cwd, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });

let passA = false;
const runtime = new WanxiangRuntime();
try {
  await runtime.boot({ dshHome: DSH_HOME });
  ok("boot 成功");

  const presets = await runtime.listPresets();
  console.log(`  list() = ${presets.map((p) => `${p.id}(${p.trust})`).join(", ") || "(空)"}`);

  if (presets.some((p) => p.id === slug)) {
    ok(`用户 preset ${slug} 被发现了 —— userLayer 把 $DSH_HOME/.agent-presets 带进来了`);
    try {
      const sid = await runtime.createSession(slug, cwd);
      ok(`createSession 成功，mount 没抛：${sid}`);
      passA = true;
    } catch (e) {
      bad(`createSession/mount 抛了：${(e as Error).message}`);
    }
  } else {
    bad(`用户 preset ${slug} 不在 list() 里 —— userLayer 没带进用户根`);
  }
} catch (e) {
  bad(`boot 失败：${(e as Error).message}`);
} finally {
  await runtime.dispose().catch(() => {});
}

/* ── 4. Pass B：显式把用户根加进 roots ──────────────────────────── */

if (passA) {
  step("4. Pass A 已通过，跳过 Pass B");
  console.log("\n\x1b[1m结论：地基成立。\x1b[0m dsh-runtime.ts 不用改就能加载万象的 preset。");
  console.log("下一步 → 验证 2（双运行时共存）。");
  process.exit(0);
}

step("4. Pass B —— 显式把 $DSH_HOME/.agent-presets 加进 roots");

process.env.DSH_HOME = DSH_HOME;
const { boot, loadProfile } = await import("@deepseek-ai/dsh-app-boot");
const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");
const profile: any = loadProfile("dsh", "headless", INSTALL_ANCHOR, undefined, { userLayer: true });
const rootConfigPath = join(profile.dir, "cordis.yml");
writeFileSync(rootConfigPath, "# probe runtime root\n[]\n");
const shippedRoot = join(dirname(INSTALL_ANCHOR), "config", "agent-presets");

console.log(`  shippedRoot = ${shippedRoot}`);
console.log(`  userRoot    = ${join(DSH_HOME, ".agent-presets")}`);

const patches = [
  ...profile.layers.flatMap((l: any) => l.patches),
  ...profile.patches,
  { id: "headless-runner", disabled: true },
  { id: "headless-startup", disabled: true },
  {
    insert: [
      {
        id: "agent-presets",
        name: "@deepseek-ai/dsh-agent-presets",
        config: {
          default: "standard",
          roots: [
            { path: shippedRoot, trust: "system" },
            { path: join(DSH_HOME, ".agent-presets"), trust: "user" },
          ],
        },
      },
    ],
  },
];

let ctx: any = null;
try {
  ctx = await boot("wanxiang-probe", rootConfigPath, patches, () => {});
  ok("boot 成功");

  const ap = ctx.get("agentPresets");
  if (!ap) {
    bad("agentPresets 插件没挂上");
  } else {
    const list = await ap.list();
    console.log(`  list() = ${list.map((p: any) => `${p.id}(${p.trust})`).join(", ") || "(空)"}`);
    if (list.some((p: any) => p.id === slug)) {
      ok(`加了 userRoot 之后 ${slug} 被发现了`);
      console.log(
        "\n\x1b[1m结论：地基成立，但需要一行改动。\x1b[0m\n" +
          "在 src/runtime/dsh-runtime.ts 的 agent-presets config 的 roots 里加上\n" +
          '  { path: join(config.dshHome, ".agent-presets"), trust: "user" }\n' +
          "下一步 → 验证 2（双运行时共存）。",
      );
    } else {
      bad(`加了 userRoot 还是没有 ${slug}`);
      console.log(
        "\n\x1b[1m结论：(B)/(C) 的地基不成立。\x1b[0m\n" +
          "agent-presets 发现不了万象生成的 preset。回 (A)，并把 AppSpec 里\n" +
          "兑现不了的字段（delivery.trigger / memory_binding / retrieval）降级成纯文档字段。",
      );
    }
  }
} catch (e) {
  bad(`Pass B 失败：${(e as Error).message}`);
  console.log((e as Error).stack);
} finally {
  if (ctx) await ctx.fiber.dispose().catch(() => {});
}
