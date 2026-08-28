import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);

export interface RuntimeConfig {
  /** DSH_HOME 绝对路径（万象自己的 home，避免污染用户 ~/.dsh） */
  dshHome: string;
  /** 内置 preset root（默认 dsh 包内 config/agent-presets） */
  shippedPresetRoot?: string;
}

/**
 * 万象运行时：把「生成的应用」（DSH preset）经 DSH library API 在框架下跑起来。
 *
 * 封装了 spike 验证过的关键路径：
 *   boot headless → insert agent-presets 插件 → createSession 时 setup 里
 *   await agentPresets.mount(agentCtx, presetId) → followup drive → 读结果。
 *
 * 单进程可创建多个隔离 agent（每个 session 独立 cwd + preset）。
 */
export class WanxiangRuntime {
  private ctx: any = null;
  private agents: any = null;
  private sessions: any = null;
  private agentMap = new Map<string, any>();

  async boot(config: RuntimeConfig): Promise<void> {
    process.env.DSH_HOME = config.dshHome;

    const { boot, loadProfile } = await import("@deepseek-ai/dsh-app-boot");
    const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");
    const profile = loadProfile("dsh", "headless", INSTALL_ANCHOR, undefined, {
      userLayer: true,
    });

    const rootConfigPath = join(profile.dir, "cordis.yml");
    writeFileSync(rootConfigPath, "# wanxiang runtime root\n[]\n");

    const shippedRoot =
      config.shippedPresetRoot ??
      join(dirname(INSTALL_ANCHOR), "config", "agent-presets");

    const patches = [
      ...profile.layers.flatMap((l: any) => l.patches),
      ...(profile as any).patches,
      { id: "headless-runner", disabled: true },
      { id: "headless-startup", disabled: true },
      {
        insert: [
          {
            id: "agent-presets",
            name: "@deepseek-ai/dsh-agent-presets",
            config: {
              default: "standard",
              roots: [{ path: shippedRoot, trust: "system" }],
            },
          },
        ],
      },
    ];

    this.ctx = await boot("wanxiang", rootConfigPath, patches, () => {});
    this.agents = this.ctx.get("agents");
    this.sessions = this.ctx.get("sessions");
  }

  /** 列出当前可用的 preset（含万象生成的 user preset）。 */
  async listPresets(): Promise<Array<{ id: string; trust: string }>> {
    const agentPresets = this.ctx?.get("agentPresets");
    if (!agentPresets) return [];
    const list = await agentPresets.list();
    return list.map((p: any) => ({ id: p.id, trust: p.trust }));
  }

  /** 创建一个挂在指定 preset 上的隔离会话。 */
  async createSession(presetId: string, cwd: string): Promise<string> {
    if (!this.ctx) throw new Error("runtime not booted");
    const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
    const { SessionId } = await import("@deepseek-ai/dsh-session");
    const agentPresets = this.ctx.get("agentPresets");
    const selection = this.ctx.get("agentDefaultModel").currentSelection();
    const sessionId = `session-${randomUUID()}`;
    mkdirSync(cwd, { recursive: true });

    const { agent } = await this.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd, agentPreset: presetId },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx: any) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
        if (agentPresets) {
          await agentPresets.mount(agentCtx, presetId);
        }
      },
    });

    this.agentMap.set(sessionId, agent);
    return sessionId;
  }

  /** 驱动一轮对话，返回 assistant 的文本回复。 */
  async runTask(sessionId: string, task: string): Promise<string> {
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const agent = this.agentMap.get(sessionId);
    if (!agent) throw new Error(`session not found: ${sessionId}`);

    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(
      createUserMessage({
        content: [{ type: "text", text: task }],
        source: { kind: "user" },
      }),
    );
    await agent.whenIdle();
    await this.sessions.flush(agent.session);
    return this.lastAssistantText(agent, firstSeq);
  }

  private lastAssistantText(agent: any, firstSeq: number): string {
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

  async dispose(): Promise<void> {
    if (this.ctx) await this.ctx.fiber.dispose();
    this.agentMap.clear();
    this.ctx = null;
  }
}
