/**
 * 验证 4（端到端）：job 模式真的跑得起来吗？
 *
 *   createSession(preset, cwd) → runTask() → 拿到交付物文本
 *
 * 前三条验证的是 DSH 的【发现】逻辑；这条验证模型的【使用】行为：
 * 它到底会不会去加载 SKILL.md 并照着做。
 *
 * 测试设计的关键：src/compiler/persona.ts 的 buildPersonaText **不包含**
 * workflow 步骤，只写一句「你有一份工作手册，干活前先按它的步骤走」。
 * 步骤只存在于 SKILL.md 里。所以把暗号埋进 workflow.steps，
 * 模型说得出暗号 ⇒ 它确实加载并执行了手册，而不是从人格提示词里读到的。
 *
 * 技能只放 <cwd>/.dsh/skills/（验证 3 证明这条根是通的），
 * cwd 在 git 仓库之外，findProjectRoot 才会落在 cwd 本身。
 *
 * 需要 DEEPSEEK_API_KEY。跑法：
 *   DEEPSEEK_API_KEY=sk-… npx tsx scripts/probe-run.ts
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { WanxiangRuntime } from "../src/runtime/dsh-runtime";
import { validateAppSpec } from "../src/appspec/validate";
import { compile } from "../src/compiler/compile";
import { serializeAppPackage } from "../src/compiler/serialize";
import { slugFromName } from "../src/appspec/slug";

const require = createRequire(import.meta.url);
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(PROJECT, ".dsh-home");
const STAGE = join(tmpdir(), `wanx-run-probe-${randomUUID().slice(0, 8)}`);
const TOKEN = "SKILL-TOKEN-7F3A9C";

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

if (!process.env.DEEPSEEK_API_KEY) {
  bad("没有 DEEPSEEK_API_KEY");
  process.exit(1);
}

/* ── 1. 造一个带暗号的应用 ──────────────────────────────────────── */

step("1. 造应用（暗号埋在 workflow.steps，只会进 SKILL.md）");

const v = validateAppSpec({
  schema_version: "1.0",
  name: "端到端探针",
  description: "验证 job 模式端到端跑通：会不会加载工作手册并照着做的最小应用",
  goal: "按工作手册产出一句话",
  domain: "general",
  memory_binding: { read: ["*"], write: [], retrieval: "semantic" },
  capabilities: ["summarize"],
  delivery: { form: "一句话回复", trigger: "manual", output: "chat" },
  workflow: {
    steps: [
      "用一句话回答用户的问题",
      `在回答的最后另起一行，原样写出这串暗号：${TOKEN}`,
    ],
  },
  boundaries: ["不要联网"],
});
if (!v.ok) { bad(v.errors.join("; ")); process.exit(1); }
const spec = v.value;
const slug = slugFromName(spec.name);
const files = serializeAppPackage(compile(spec, { includeCentaurPlugins: false }));
const skillRel = Object.keys(files).find((f) => f.startsWith("skills/"))!;
const skillName = skillRel.split("/")[1];

// 自证：persona 里不该有暗号
const personaText = String(
  (compile(spec, { includeCentaurPlugins: false }).preset.agentCordis
    .find((e) => e.id === "persona")!.config as any).text,
);
if (personaText.includes(TOKEN)) {
  bad("暗号漏进了 persona，这个测试不成立");
  process.exit(1);
}
ok(`persona 里没有暗号（长度 ${personaText.length}）`);
ok(`SKILL.md 里有暗号：${files[skillRel].includes(TOKEN)}`);

/* ── 2. 装：preset 进 DSH_HOME，技能只进 <cwd>/.dsh/skills ──────── */

step("2. 装");

const presetDir = join(DSH_HOME, ".agent-presets", slug);
rmSync(presetDir, { recursive: true, force: true });
mkdirSync(presetDir, { recursive: true });
writeFileSync(join(presetDir, "preset.yml"), files["preset.yml"], "utf-8");
writeFileSync(join(presetDir, "agent.cordis.yml"), files["agent.cordis.yml"], "utf-8");
ok(`preset → ${presetDir}`);

// 共享根里绝不放它 —— 发现得了就只能是从 cwd 来的
rmSync(join(DSH_HOME, "skills", skillName), { recursive: true, force: true });

const cwd = join(STAGE, "workspace");
const skillDir = join(cwd, ".dsh", "skills", skillName);
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), files[skillRel], "utf-8");
ok(`技能 → ${skillDir}/SKILL.md（共享根里没有）`);

/* ── 3. boot + createSession + runTask ─────────────────────────── */

step("3. WanxiangRuntime.boot()");
const runtime = new WanxiangRuntime();
try {
  await runtime.boot({ dshHome: DSH_HOME });
  ok("boot 成功");

  step("4. createSession（cwd 在 git 仓库之外）");
  console.log(`  cwd = ${cwd}`);
  const sessionId = await runtime.createSession(slug, cwd);
  ok(`createSession 成功：${sessionId}`);

  step("5. runTaskStream —— 真调模型，边跑边推进度");
  const task = "今天适合做什么？";
  console.log(`  任务：${task}\n`);
  const t0 = Date.now();
  const seen: string[] = [];
  const reply = await runtime.runTaskStream(sessionId, task, (e) => {
    const line = e.kind === "step" ? `  \x1b[2m· ${e.text}\x1b[0m` : `  \x1b[36m› ${e.text.split("\n")[0].slice(0, 60)}\x1b[0m`;
    seen.push(e.kind);
    console.log(line);
  });
  const ms = Date.now() - t0;
  runtime.releaseSession(sessionId);

  console.log(`\n  用时 ${(ms / 1000).toFixed(1)}s，流式事件 ${seen.length} 条（step ${seen.filter((k) => k === "step").length} / text ${seen.filter((k) => k === "text").length}）`);
  console.log(`\n  ── 最终交付物 ──\n${reply.split("\n").map((l) => "  " + l).join("\n")}\n  ────────────────`);

  step("结论");
  const streamed = seen.length > 0;
  if (reply.includes(TOKEN) && streamed) {
    console.log(
      "\x1b[1m✓ job 模式端到端跑通，且流式可用。\x1b[0m\n" +
        "暗号只存在于 SKILL.md（persona 里没有，已自证），模型说出来了 ⇒ 手册被加载并执行。\n" +
        "runTaskStream 的进度事件也收到了 ⇒ 界面不会白屏干等。",
    );
  } else if (reply.includes(TOKEN)) {
    console.log("\x1b[1m△ 跑通了但没有流式事件。\x1b[0m ctx.on('session/event') 没挂上，界面只能等结果。");
  } else if (reply !== "") {
    console.log("\x1b[1m✗ 模型答了，但没执行手册。\x1b[0m task 文本需要显式提示「按你的工作手册跑一遍」。");
  } else {
    console.log("\x1b[1m✗ 没拿到回复。\x1b[0m");
  }
} catch (e) {
  bad(`失败：${(e as Error).message}`);
  console.log((e as Error).stack);
} finally {
  await runtime.dispose().catch(() => {});
  rmSync(STAGE, { recursive: true, force: true });
}
