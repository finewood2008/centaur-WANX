/**
 * 万象 DSH runtime spike（M0）：验证万象能把「生成的应用」经 DSH library API 跑起来。
 *
 * 分步验证：
 *   1. boot headless profile，拿到 ctx
 *   2. createSession('minimal') 复现内置 preset 可跑
 *   3. 尝试用万象生成的 preset（装到 $DSH_HOME/.agent-presets/<name>/）
 *
 * 运行：npx tsx scripts/spike.ts
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(__dirname, "..");

// key 从环境变量读（运行时 export）；若无则尝试从 centaur-build/.env.server
if (!process.env.DEEPSEEK_API_KEY) {
  const { readFileSync } = await import("node:fs");
  try {
    for (const line of readFileSync(join(process.env.HOME ?? "", "项目/centaur-build/.env.server"), "utf8").split("\n")) {
      const m = line.match(/^DEEPSEEK_API_KEY=(.*)$/);
      if (m) process.env.DEEPSEEK_API_KEY = m[1].trim();
    }
    console.log("[spike] 已从 centaur-build/.env.server 载入 key");
  } catch {
    /* ignore */
  }
}

const WANXIANG_HOME = join(PROJECT, ".dsh-home");
process.env.DSH_HOME = WANXIANG_HOME;

const { boot, loadProfile } = await import("@deepseek-ai/dsh-app-boot");
const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");
console.log("[spike] INSTALL_ANCHOR =", INSTALL_ANCHOR);

const profile = loadProfile("dsh", "headless", INSTALL_ANCHOR, undefined, { userLayer: true });
const rootConfigPath = join(profile.dir, "cordis.yml");
writeFileSync(rootConfigPath, "# wanxiang runtime root\n[]\n");

const SHIPPED_PRESET_ROOT = join(
  dirname(require.resolve("@deepseek-ai/dsh/package.json")),
  "config",
  "agent-presets",
);

const patches = [
  ...profile.layers.flatMap((l) => l.patches),
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
          roots: [{ path: SHIPPED_PRESET_ROOT, trust: "system" }],
        },
      },
    ],
  },
];

console.log("[spike] booting headless...");
const ctx = await boot("wanxiang", rootConfigPath, patches, () => {});
console.log("[spike] booted. agents=%s sessions=%s agentDefaultModel=%s",
  !!ctx.get("agents"), !!ctx.get("sessions"), !!ctx.get("agentDefaultModel"));

// 调试：agentPresets 是否挂载 + roots + list()
const ap = ctx.get("agentPresets");
if (ap) {
  console.log("[spike] agentPresets 存在");
  console.log("[spike] resolvedRoots =", JSON.stringify(ap.resolvedRoots ?? ap.config?.roots ?? "N/A"));
  try {
    const list = await ap.list();
    console.log("[spike] list() =", list.map((p: any) => `${p.id}(${p.trust})`).join(", ") || "(空)");
  } catch (e) {
    console.log("[spike] list() 失败:", (e as Error).message);
  }
} else {
  console.log("[spike] agentPresets 不存在！");
}

const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
const { SessionId } = await import("@deepseek-ai/dsh-session");

const agents = ctx.get("agents");
const sessions = ctx.get("sessions");
const selection = ctx.get("agentDefaultModel").currentSelection();

const cwd = join(PROJECT, ".workspace");
mkdirSync(cwd, { recursive: true });

async function createAgent(id: string, presetName: string) {
  const agentPresets = ctx.get("agentPresets");
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${id}-${randomUUID().slice(0, 8)}`),
    meta: { cwd, agentPreset: presetName },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: any) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      if (agentPresets) {
        await agentPresets.mount(agentCtx, presetName);
      }
    },
  });
  return agent;
}

function lastAssistantText(agent: any, firstSeq: number): string {
  let text = "";
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data?.message?.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (joined !== "") text = joined;
    }
  }
  return text;
}

async function runTask(agent: any, task: string) {
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(createUserMessage({ content: [{ type: "text", text: task }], source: { kind: "user" } }));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  return lastAssistantText(agent, firstSeq);
}

// —— 验证 1：内置 minimal preset ——
console.log("\n[spike] 验证 1：内置 minimal preset...");
try {
  const agent = await createAgent("minimal", "minimal");
  const reply = await runTask(agent, "只回答一个词：万象");
  console.log("[spike] minimal 结果 =", JSON.stringify(reply.slice(0, 80)));
} catch (e) {
  console.log("[spike] minimal 失败:", (e as Error).message);
}

// —— 验证 2：万象生成的 preset ——
// 需先把万象 preset 装到 $DSH_HOME/.agent-presets/<name>/
console.log("\n[spike] 验证 2：万象 preset（agentPreset 引用）...");
try {
  const agent = await createAgent("wanxiang", "customer-followup");
  const reply = await runTask(agent, "你好，请介绍一下你自己");
  console.log("[spike] 万象 preset 结果 =", JSON.stringify(reply.slice(0, 120)));
} catch (e) {
  console.log("[spike] 万象 preset 失败:", (e as Error).message);
}

await ctx.fiber.dispose();
console.log("\n[spike] disposed.");
