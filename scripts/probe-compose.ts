/**
 * 探针：两层组合（dsh-base + @centaur/wanxiang）能不能立起来、立起来之后
 * 是不是我们要的形状。
 *
 * 断言五件事：
 *   1. boot 成功，万象 bundle 的 inject 全部就绪（缺一个整个插件不激活）；
 *   2. webserver 在指定端口上，/ 与 /health 是万象的，/chat /api /assets
 *      /plugins 全部 404——没有第二个界面；
 *   3. 万象编译出的 preset 能被发现并 mount；
 *   4. mount 之后 agent scope 里可见的工具 = preset 写的那些，**不含 bash**
 *      ——「capabilities 是真话」的机制在新组合下仍然成立；
 *   5. system prompt 里没有任何一段自称 DeepSeek Harness。
 *
 * 用一次性的 scratch home，不碰真 .dsh-home。不需要 API key（不发请求）。
 *
 *   npx tsx scripts/probe-compose.ts
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load } from "js-yaml";

const SCRATCH = join(tmpdir(), "wanx-probe-compose");
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

// boot.ts 在模块加载时读这些 env——必须先设再 import。
process.env.WANXIANG_DSH_HOME = join(SCRATCH, "home");
process.env.WANXIANG_PORT = "8799";
process.env.WANXIANG_APPS = join(SCRATCH, "apps");

let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

async function main(): Promise<void> {
  const { bootWanxiang } = await import("../src/boot");
  const { validateAppSpec } = await import("../src/appspec/validate");
  const { compile } = await import("../src/compiler/compile");
  const { serializePreset } = await import("../src/compiler/serialize");
  const { createAppAgent } = await import("../src/runtime/run-agent");
  const { makePresenter } = await import("../src/runtime/tool-view");

  // 先把一个真实编译产物装进 scratch home 的用户 preset 根——走与 installApp
  // 相同的落盘路径，boot 后 roster 里就该有它。
  const meta = load(readFileSync(join("examples", "demo-meeting-todo", "app.yml"), "utf-8"));
  const validated = validateAppSpec(meta);
  if (!validated.ok) throw new Error(`示例 app.yml 不合法: ${validated.errors.join("; ")}`);
  const { presetYml, agentCordisYml } = serializePreset(
    compile(validated.value, { includeCentaurPlugins: false }),
  );
  const slug = "probe-app";
  const presetDir = join(process.env.WANXIANG_DSH_HOME!, ".agent-presets", slug);
  mkdirSync(presetDir, { recursive: true });
  writeFileSync(join(presetDir, "preset.yml"), presetYml);
  writeFileSync(join(presetDir, "agent.cordis.yml"), agentCordisYml);

  console.log("boot 两层组合中…");
  const ctx = await bootWanxiang();

  // 1. 服务面
  for (const svc of [
    "webServer",
    "agents",
    "sessions",
    "agentPresets",
    "agentDefaultModel",
    "sessionQuery",
    "sessionPersistence",
    "tools",
    "sandboxPolicy",
    "approval",
    "systemPrompt",
  ]) {
    let got: unknown;
    try {
      got = ctx.get(svc);
    } catch {
      got = undefined;
    }
    check(`服务 ${svc}`, got !== undefined && got !== null);
  }

  // 2. HTTP 版图
  const port = ctx.get("webServer")?.port;
  check("webserver 端口", port === 8799, String(port));
  const status = async (path: string): Promise<number> =>
    (await fetch(`http://127.0.0.1:8799${path}`)).status;
  check("/health 是万象的", (await status("/health")) === 200);
  const health = await (await fetch("http://127.0.0.1:8799/health")).json();
  check("界面契约版本 = 4", health.ui === 4, String(health.ui));
  for (const gone of ["/chat", "/api/session", "/assets/index.js", "/plugins/x/client.js", "/manifest.webmanifest", "/favicon.svg"]) {
    check(`${gone} → 404`, (await status(gone)) === 404);
  }

  // 3. preset 可发现、可 mount
  const roster = await ctx.get("agentPresets").list();
  check(
    "编译产物在 roster 里",
    roster.some((p: any) => p.id === slug),
    roster.map((p: any) => p.id).join(","),
  );

  const hold = await createAppAgent(ctx, slug, join(SCRATCH, "apps", slug, "workspace"));
  check("mount 成功（agent 建起来了）", Boolean(hold.agent));

  // 4. scope 里的工具面
  const { scopeOf } = await import("@deepseek-ai/dsh-scope");
  const scope = scopeOf(hold.agent.ctx);
  const names: string[] = (ctx.get("tools").schemas(scope) ?? []).map((t: any) => t.name);
  check("scope 里能看见 read", names.includes("read"), names.join(","));
  check("scope 里能看见 todo_write", names.includes("todo_write"));
  check("scope 里**没有** bash", !names.includes("bash"));
  check("scope 里**没有** run_subagent", !names.some((n) => n.includes("subagent")));

  // presenter 冒烟：read 的 presentCall 出中文、不漏工具名
  const present = makePresenter(ctx, hold.agent);
  await new Promise((r) => setTimeout(r, 50)); // 等 scope 的异步解析
  const view = present.call("read", JSON.stringify({ file_path: join(SCRATCH, "资料.md") }), "c1");
  check("presenter 出带文件名的中文白话", view.label === "正在读「资料.md」", view.label);
  check("presenter 不漏原始工具名", !/\bread\b/u.test(view.label), view.label);

  // 5. system prompt 不自称 DeepSeek Harness
  const sp = ctx.get("systemPrompt");
  const globalAsm = await sp.assemble({});
  const globalText = (globalAsm?.sections ?? []).map((s: any) => `${s.name}:${s.text}`).join("\n");
  check("全局 prompt 无 DeepSeek Harness", !globalText.includes("DeepSeek Harness"));
  const scopedAsm = await sp.assemble({ scope });
  const scopedText = (scopedAsm?.sections ?? []).map((s: any) => `${s.name}:${s.text}`).join("\n");
  check("agent prompt 无 DeepSeek Harness", !scopedText.includes("DeepSeek Harness"));
  check(
    "persona（助手人格）在 agent prompt 里",
    scopedText.includes(validated.value.name) || scopedText.length > globalText.length,
  );

  await hold.dispose();
  check("dispose 干净返回", true);

  await ctx.fiber.dispose();
  console.log(failed === 0 ? "\n探针全绿。" : `\n${failed} 项失败。`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("探针崩了:", e);
  process.exit(1);
});
