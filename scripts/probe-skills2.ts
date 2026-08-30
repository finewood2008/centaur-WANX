/**
 * 验证 3b：preset 里给 skill-filesystem 写的 config 到底生不生效？
 *
 * src/compiler/compile.ts 的注释断言：
 *   「实测 DSH 会整个忽略 preset 里给 skill-filesystem 写的 config
 *    （includeDefaultRoots: false 写了也不生效，customSkillDirs 从不被扫描）」
 *
 * 但 @deepseek-ai/dsh-skill-filesystem@0.1.0-rc.6 的 lib/index.js:166 明明
 * 把 customSkillDirs 推进了 roots，171 行用 includeDefaultRoots 控制共享根。
 * 这条注释若已过期，README 的「限制 2：技能不隔离」今天就能解掉。
 *
 * 三个场景，同一次 boot，各挂一个 preset：
 *   A  config: { includeDefaultRoots: false, customSkillDirs: [自己的目录] }
 *   B  无 config（= 现在的行为）
 *   C  无 config，技能放在 <projectRoot>/.dsh/skills，cwd 在 git 仓库之外
 *
 * 不需要 API key。跑法：npx tsx scripts/probe-skills2.ts
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dump } from "js-yaml";
import { validateAppSpec } from "../src/appspec/validate";
import { compile } from "../src/compiler/compile";
import { serializeAppPackage } from "../src/compiler/serialize";

const require = createRequire(import.meta.url);
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(PROJECT, ".dsh-home");
const STAGE = join(tmpdir(), `wanx-skill-probe-${randomUUID().slice(0, 8)}`);

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/** 造一个应用的产物；presetId 用可读名字，好认。 */
function build(presetId: string, label: string) {
  const v = validateAppSpec({
    schema_version: "1.0",
    name: label,
    description: "验证 skill-filesystem 的 preset config 生不生效的最小应用",
    goal: "验证技能隔离",
    domain: "general",
    memory_binding: { read: ["*"], write: [], retrieval: "semantic" },
    capabilities: ["summarize"],
    delivery: { form: "一句话", trigger: "manual", output: "chat" },
    workflow: { steps: ["读手册", "报技能"] },
    boundaries: ["不联网"],
  });
  if (!v.ok) throw new Error(v.errors.join("; "));
  const pkg = compile(v.value, { includeCentaurPlugins: false });
  const files = serializeAppPackage(pkg);
  const skillRel = Object.keys(files).find((f) => f.startsWith("skills/"))!;
  // 技能目录名派生自应用名，三个场景各不相同，便于分辨谁被发现了
  return { presetId, files, skillRel, skillName: skillRel.split("/")[1], cordis: pkg.preset.agentCordis };
}

/** 把 preset 写进 DSH_HOME，可选地给 skill-filesystem 注入 config。 */
function installPreset(b: ReturnType<typeof build>, skillFsConfig?: Record<string, unknown>) {
  const dir = join(DSH_HOME, ".agent-presets", b.presetId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "preset.yml"), b.files["preset.yml"], "utf-8");
  const cordis = b.cordis.map((e) =>
    e.id === "skill-filesystem" && skillFsConfig ? { ...e, config: skillFsConfig } : e,
  );
  writeFileSync(join(dir, "agent.cordis.yml"), dump(cordis, { lineWidth: -1, noRefs: true }), "utf-8");
}

step("0. 准备");
rmSync(STAGE, { recursive: true, force: true });

// 共享根里先放一个「别人的」技能 —— 隔离成功的话它不该出现
const intruderDir = join(DSH_HOME, "skills", "intruder-workflow");
mkdirSync(intruderDir, { recursive: true });
writeFileSync(
  join(intruderDir, "SKILL.md"),
  '---\nname: intruder-workflow\ndescription: "别的助手的手册，不该被看见"\n---\n\n# 入侵者\n',
  "utf-8",
);
ok(`共享根放了 intruder-workflow（隔离成功则不该出现）`);

const A = build("probe-a", "隔离探针甲");
const B = build("probe-b", "隔离探针乙");
const C = build("probe-c", "隔离探针丙");

// A：技能放自己的目录，preset 里写 customSkillDirs + includeDefaultRoots:false
const aSkills = join(STAGE, "app-a", "skills");
mkdirSync(join(aSkills, A.skillName), { recursive: true });
writeFileSync(join(aSkills, A.skillName, "SKILL.md"), A.files[A.skillRel], "utf-8");
installPreset(A, { includeDefaultRoots: false, customSkillDirs: [aSkills] });
ok(`A: 技能 → ${aSkills}/${A.skillName}，preset 带 config`);

// B：现在的行为 —— 技能进共享根，preset 不带 config
mkdirSync(join(DSH_HOME, "skills", B.skillName), { recursive: true });
writeFileSync(join(DSH_HOME, "skills", B.skillName, "SKILL.md"), B.files[B.skillRel], "utf-8");
installPreset(B);
ok(`B: 技能 → $DSH_HOME/skills/${B.skillName}，preset 无 config`);

// C：技能放 <projectRoot>/.dsh/skills，cwd 在 git 仓库之外（/tmp 之下没有 .git）
const cRoot = join(STAGE, "app-c");
mkdirSync(join(cRoot, ".dsh", "skills", C.skillName), { recursive: true });
writeFileSync(join(cRoot, ".dsh", "skills", C.skillName, "SKILL.md"), C.files[C.skillRel], "utf-8");
installPreset(C);
ok(`C: 技能 → ${cRoot}/.dsh/skills/${C.skillName}，preset 无 config`);

/* ── boot ────────────────────────────────────────────────────────── */

step("1. boot");
process.env.DSH_HOME = DSH_HOME;
const { boot, loadProfile } = await import("@deepseek-ai/dsh-app-boot");
const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");
const profile: any = loadProfile("dsh", "headless", INSTALL_ANCHOR, undefined, { userLayer: true });
const rootConfigPath = join(profile.dir, "cordis.yml");
writeFileSync(rootConfigPath, "# skill probe root\n[]\n");
const shippedRoot = join(dirname(INSTALL_ANCHOR), "config", "agent-presets");

let ctx: any = null;
try {
  ctx = await boot("wanxiang-skill-probe2", rootConfigPath, [
    ...profile.layers.flatMap((l: any) => l.patches),
    ...profile.patches,
    { id: "headless-runner", disabled: true },
    { id: "headless-startup", disabled: true },
    {
      insert: [{
        id: "agent-presets",
        name: "@deepseek-ai/dsh-agent-presets",
        config: { default: "standard", roots: [{ path: shippedRoot, trust: "system" }] },
      }],
    },
  ], () => {});
  ok("boot 成功");

  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const agentPresets = ctx.get("agentPresets");
  const selection = ctx.get("agentDefaultModel").currentSelection();

  async function scenario(b: ReturnType<typeof build>, cwd: string, note: string) {
    mkdirSync(cwd, { recursive: true });
    let agentCtx: any = null;
    await ctx.get("agents").create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: { cwd, agentPreset: b.presetId },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (c: any) => {
        agentCtx = c;
        installModelSelection(c, { current: selection, assembled: undefined });
        await agentPresets.mount(c, b.presetId);
      },
    });
    const skills = agentCtx.get("skills");
    const names = (await skills.list({ cwd })).map((s: any) => s.name ?? s.id);
    const own = names.includes(b.skillName);
    const leaked = names.filter((n: string) => n === "intruder-workflow" || (n.startsWith("app-") && n !== b.skillName));
    console.log(`\n  \x1b[1m${note}\x1b[0m`);
    console.log(`    发现 = ${names.join(", ") || "(空)"}`);
    console.log(`    ${own ? "\x1b[32m✓\x1b[0m 自己的技能在" : "\x1b[31m✗\x1b[0m 自己的技能不在"}`);
    console.log(`    ${leaked.length === 0 ? "\x1b[32m✓\x1b[0m 没有别人的技能漏进来" : `\x1b[31m✗\x1b[0m 漏进来了: ${leaked.join(", ")}`}`);
    return { own, isolated: leaked.length === 0 };
  }

  step("2. 三个场景");
  const rA = await scenario(A, join(STAGE, "app-a", "workspace"), "A —— preset 带 customSkillDirs + includeDefaultRoots:false");
  const rB = await scenario(B, join(STAGE, "app-b", "workspace"), "B —— 现在的行为（技能进共享根，无 config）");
  const rC = await scenario(C, cRoot, "C —— <projectRoot>/.dsh/skills，cwd 在 git 之外");

  step("结论");
  if (rA.own && rA.isolated) {
    console.log(
      "\x1b[1mpreset 的 skill-filesystem config 是生效的。\x1b[0m\n" +
        "compile.ts 里那条「DSH 整个忽略这个 config」的注释在 rc.6 上已经不成立。\n" +
        "→ README 的「限制 2：技能不隔离」今天就能解：compile() 给 skill-filesystem 写\n" +
        "  { includeDefaultRoots: false, customSkillDirs: [<应用自己的 skills 目录>] }，\n" +
        "  installApp 不再往 $DSH_HOME/skills/ 写，pruneOrphanSkills() 整个删掉。",
    );
  } else if (rA.own && !rA.isolated) {
    console.log("customSkillDirs 生效了，但 includeDefaultRoots:false 没挡住共享根 —— 半个隔离。");
  } else {
    console.log("\x1b[1mconfig 确实不生效。\x1b[0m compile.ts 那条注释成立，隔离得另想办法。");
  }
  console.log(`\nA 自己的技能=${rA.own} 隔离=${rA.isolated}`);
  console.log(`B 自己的技能=${rB.own} 隔离=${rB.isolated}（预期：技能在、隔离失败）`);
  console.log(`C 自己的技能=${rC.own} 隔离=${rC.isolated}（project 根 .dsh/skills 通不通）`);
} catch (e) {
  bad(`失败：${(e as Error).message}`);
  console.log((e as Error).stack);
} finally {
  if (ctx) await ctx.fiber.dispose().catch(() => {});
  rmSync(join(DSH_HOME, "skills", "intruder-workflow"), { recursive: true, force: true });
}
