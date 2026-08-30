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
 * 跑一次任务时推给界面的进度。
 *
 * `step` 是给用户看的白话（「正在翻资料」），不是工具名——界面上不出现
 * glob / bash 这种词。`text` 是助手说的话。
 */
export interface RunEvent {
  kind: "step" | "text";
  text: string;
}

/**
 * 工具名 → 白话。用户不该在界面上看见 glob、bash 这些词。
 * 认不出的工具统一说「正在处理」，绝不把原始工具名漏出去。
 */
const STEP_LABEL: Record<string, string> = {
  glob: "正在翻找资料",
  grep: "正在检索内容",
  read: "正在读材料",
  write: "正在写文件",
  edit: "正在修改文件",
  bash: "正在执行操作",
  skill: "正在读工作手册",
  web_search: "正在联网查找",
  web_fetch: "正在读取网页",
  todo_write: "正在梳理步骤",
};

function stepLabel(tool: string): string {
  return STEP_LABEL[tool] ?? STEP_LABEL[tool.toLowerCase()] ?? "正在处理";
}

/** 从一条 session 事件里抽出要推给界面的东西。认不出的事件返回空数组。 */
function toRunEvents(event: any): RunEvent[] {
  if (event?.type !== "assistant/message") return [];
  const out: RunEvent[] = [];
  for (const block of event.data?.message?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      out.push({ kind: "text", text: block.text });
    } else if (block?.type === "tool_use" || block?.type === "tool-call") {
      out.push({ kind: "step", text: stepLabel(String(block.name ?? "")) });
    }
  }
  return out;
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

  /** boot 过了没有。server 靠它决定要不要等 bootPromise。 */
  get booted(): boolean {
    return this.ctx !== null;
  }

  async boot(config: RuntimeConfig): Promise<void> {
    process.env.DSH_HOME = config.dshHome;

    const { boot, loadProfile, healProfilesModuleFallback } = await import(
      "@deepseek-ai/dsh-app-boot"
    );
    const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");

    // 先备料，再 boot。
    //
    // DSH 的插件要从 `$DSH_HOME/profiles/node_modules` 解析，那是一堆指向安装目录的
    // 软链，平时由 `dsh` 自己在首次启动时铺好。万象的 job 模式直接进程内 boot，
    // 从没跑过 `dsh web` 的机器上那个目录是空的，boot 会炸在
    // 「plugin tree failed to load: failed to apply loader entry include」——
    // 一条完全看不出病因的错。每个新用户第一次点「让它跑一次」都会中。
    // healProfilesModuleFallback 是幂等的，铺好了再调也没有代价。
    healProfilesModuleFallback(INSTALL_ANCHOR, config.dshHome);

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
    return this.runTaskStream(sessionId, task, () => {});
  }

  /**
   * 驱动一轮对话，边跑边把进度推给 onEvent，结束后返回完整文本。
   *
   * 订阅 cordis 的 `session/event`（回调签名是 `(session, event)`），只收本
   * session 的。跑一次要 5～15 秒，不流式的话用户对着白屏干等——对着不懂技术
   * 的用户，那等同于「卡住了」。
   */
  async runTaskStream(
    sessionId: string,
    task: string,
    onEvent: (event: RunEvent) => void,
  ): Promise<string> {
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const agent = this.agentMap.get(sessionId);
    if (!agent) throw new Error(`session not found: ${sessionId}`);

    await agent.whenIdle();
    const firstSeq = agent.session.seq;

    // 订阅要在 followup 之前挂上，否则最前面几条事件会漏掉。
    //
    // 连续重复的进度要折叠：实测一次运行里连着推了 18 条「正在执行操作」，
    // 那不是进度，是噪音——用户看到的是一串一模一样的行在刷屏。
    let lastStep = "";
    let dispose: (() => void) | undefined;
    try {
      dispose = this.ctx.on("session/event", (session: any, event: any) => {
        if (session?.id !== agent.session.id) return;
        if (typeof event?.seq === "number" && event.seq < firstSeq) return;
        for (const e of toRunEvents(event)) {
          if (e.kind === "step") {
            if (e.text === lastStep) continue;
            lastStep = e.text;
          } else {
            lastStep = "";
          }
          onEvent(e);
        }
      });
    } catch {
      // 订阅不上就退化成非流式：结果照样拿得到，只是没有中途进度。
    }

    try {
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: task }],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
    } finally {
      dispose?.();
    }

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

  /** 收掉一个会话。job 模式每次跑都开新会话，跑完就该收掉。 */
  releaseSession(sessionId: string): void {
    this.agentMap.delete(sessionId);
  }

  async dispose(): Promise<void> {
    if (this.ctx) await this.ctx.fiber.dispose();
    this.agentMap.clear();
    this.ctx = null;
  }
}
