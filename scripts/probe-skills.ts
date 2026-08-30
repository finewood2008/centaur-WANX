/**
 * 验证 3：技能只放在 session 的 cwd 下，DSH 发现得了吗？
 *
 * 这决定技能隔离能不能靠 cwd 解决 —— 也就决定 README 的「限制 2」怎么修。
 * 现在 installApp 把技能装进共享的 $DSH_HOME/skills/，所有助手互相可见。
 *
 * 不需要 API key：ctx.skills.list({ cwd }) 是纯发现逻辑，不走模型。
 *
 * 跑法：npx tsx scripts/probe-skills.ts
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { validateAppSpec } from "../src/appspec/validate";
import { compile } from "../src/compiler/compile";
import { serializeAppPackage } from "../src/compiler/serialize";
import { slugFromName } from "../src/appspec/slug";

const require = createRequire(import.meta.url);
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(PROJECT, ".dsh-home");

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/* ── 1. 造应用包 ────────────────────────────────────────────────── */

step("1. 造应用包");

const validated = validateAppSpec({
  schema_version: "1.0",
  name: "技能隔离探针",
  description: "验证技能只放在 cwd 下能不能被 DSH 发现的最小应用",
  goal: "验证 cwd 能否作为技能隔离边界",
  domain: "general",
  memory_binding: { read: ["*"], write: [], retrieval: "semantic" },
  capabilities: ["summarize"],
  delivery: { form: "一句话回复", trigger: "manual", output: "chat" },
  workflow: { steps: ["读一遍手册", "报出你能用的技能"] },
  boundaries: ["不要联网"],
});
if (!validated.ok) {
  bad(validated.errors.join("; "));
  process.exit(1);
}
const spec = validated.value;
const slug = slugFromName(spec.name);
const files = serializeAppPackage(compile(spec, { includeCentaurPlugins: false }));
const skillRel = Object.keys(files).find((f) => f.startsWith("skills/"))!;
const skillName = skillRel.split("/")[1];
ok(`slug = ${slug}`);
ok(`技能 = ${skillName}`);

/* ── 2. preset 装进 DSH_HOME；技能【只】装进 cwd ─────────────────── */

step("2. 装：preset 进 DSH_HOME，技能只进 cwd");

const presetDir = join(DSH_HOME, ".agent-presets", slug);
mkdirSync(presetDir, { recursive: true });
writeFileSync(join(presetDir, "preset.yml"), files["preset.yml"], "utf-8");
writeFileSync(join(presetDir, "agent.cordis.yml"), files["agent.cordis.yml"], "utf-8");
ok(`preset → ${presetDir}`);

// 关键：确保共享根里【没有】这个技能，否则发现了也说明不了问题。
const sharedSkill = join(DSH_HOME, "skills", skillName);
rmSync(sharedSkill, { recursive: true, force: true });
ok(`共享根已清干净：${sharedSkill} 存在=${existsSync(sharedSkill)}`);

const cwd = join(PROJECT, ".workspace", "skill-probe");
rmSync(cwd, { recursive: true, force: true });
const cwdSkill = join(cwd, skillRel);
mkdirSync(dirname(cwdSkill), { recursive: true });
writeFileSync(cwdSkill, files[skillRel], "utf-8");
ok(`技能 → ${cwdSkill}`);

/* ── 3. boot + createSession，抓住 agentCtx ─────────────────────── */

step("3. boot + createSession（抓 agentCtx）");

process.env.DSH_HOME = DSH_HOME;
const { boot, loadProfile } = await import("@deepseek-ai/dsh-app-boot");
const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");
const profile: any = loadProfile("dsh", "headless", INSTALL_ANCHOR, undefined, { userLayer: true });
const rootConfigPath = join(profile.dir, "cordis.yml");
writeFileSync(rootConfigPath, "# skill probe root\n[]\n");
const shippedRoot = join(dirname(INSTALL_ANCHOR), "config", "agent-presets");

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
        config: { default: "standard", roots: [{ path: shippedRoot, trust: "system" }] },
      },
    ],
  },
];

let ctx: any = null;
try {
  ctx = await boot("wanxiang-skill-probe", rootConfigPath, patches, () => {});
  ok("boot 成功");

  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const agentPresets = ctx.get("agentPresets");
  const selection = ctx.get("agentDefaultModel").currentSelection();

  let agentCtx: any = null;
  mkdirSync(cwd, { recursive: true });
  await ctx.get("agents").create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd, agentPreset: slug },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (c: any) => {
      agentCtx = c;
      installModelSelection(c, { current: selection, assembled: undefined });
      if (agentPresets) await agentPresets.mount(c, slug);
    },
  });
  ok("createSession 成功");

  /* ── 4. 问 skills 服务：cwd 下的技能发现得了吗 ─────────────── */

  step("4. ctx.skills.list({ cwd })");

  const skills = agentCtx?.get?.("skills") ?? agentCtx?.skills ?? ctx.get("skills");
  if (!skills) {
    bad("拿不到 skills 服务");
  } else {
    const show = async (label: string, options: any) => {
      try {
        const list = await skills.list(options);
        const names = list.map((s: any) => s.name ?? s.id ?? JSON.stringify(s));
        const hit = names.includes(skillName);
        console.log(`  ${hit ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${label} → ${names.join(", ") || "(空)"}`);
        return hit;
      } catch (e) {
        bad(`${label} 抛了：${(e as Error).message}`);
        return false;
      }
    };

    const withCwd = await show("带 cwd", { cwd });
    const noCwd = await show("不带 cwd", {});

    console.log("");
    if (withCwd) {
      console.log(
        "\x1b[1m结论：cwd 可以当技能隔离边界。\x1b[0m\n" +
          "installApp 应改成把技能装进 apps/<slug>/workspace/skills/，\n" +
          "不再写共享的 $DSH_HOME/skills/；pruneOrphanSkills() 可以整个删掉。" +
          (noCwd ? "\n注意：不带 cwd 也发现得了，说明它同时还在别的根里 —— 需要再确认隔离是真的。" : ""),
      );
    } else {
      console.log(
        "\x1b[1m结论：cwd 下的技能发现不了。\x1b[0m\n" +
          "隔离得另想办法，$DSH_HOME/skills/ + pruneOrphanSkills() 这个补丁继续留着。",
      );
    }
  }
} catch (e) {
  bad(`失败：${(e as Error).message}`);
  console.log((e as Error).stack);
} finally {
  if (ctx) await ctx.fiber.dispose().catch(() => {});
}
