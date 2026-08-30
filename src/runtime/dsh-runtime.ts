import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  createAppAgent,
  lastAssistantText,
  runAgentTask,
  type RunEvent,
} from "./run-agent";

export type { RunEvent } from "./run-agent";

const require = createRequire(import.meta.url);

export interface RuntimeConfig {
  /** DSH_HOME 绝对路径（万象自己的 home，避免污染用户 ~/.dsh） */
  dshHome: string;
  /** 内置 preset root（默认 dsh 包内 config/agent-presets） */
  shippedPresetRoot?: string;
}

/**
 * 独立的 headless 运行时：自己 boot 一棵最小的 DSH 树来跑「生成的应用」。
 *
 * 万象的服务进程**不再用它**——服务进程 boot 的是完整的 web profile
 * （见 src/main.ts），细聊和跑一次共享同一个 ctx。这个类留给探针脚本
 * （scripts/probe-*.ts）和不想拉起整个 web 面的调用方；会话驱动逻辑与
 * 服务进程共用同一份 `run-agent.ts`。
 */
export class WanxiangRuntime {
  private ctx: any = null;
  private agentMap = new Map<string, any>();

  /** boot 过了没有。 */
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
    // 软链，平时由 `dsh` 自己在首次启动时铺好。直接进程内 boot 的话，从没跑过
    // `dsh web` 的机器上那个目录是空的，boot 会炸在
    // 「plugin tree failed to load: failed to apply loader entry include」——
    // 一条完全看不出病因的错。healProfilesModuleFallback 是幂等的。
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
    const agent = await createAppAgent(this.ctx, presetId, cwd);
    const sessionId = String(agent.session.id);
    this.agentMap.set(sessionId, agent);
    return sessionId;
  }

  /** 驱动一轮对话，返回 assistant 的文本回复。 */
  async runTask(sessionId: string, task: string): Promise<string> {
    return this.runTaskStream(sessionId, task, () => {});
  }

  /** 驱动一轮对话，边跑边把进度推给 onEvent，结束后返回完整文本。 */
  async runTaskStream(
    sessionId: string,
    task: string,
    onEvent: (event: RunEvent) => void,
  ): Promise<string> {
    const agent = this.agentMap.get(sessionId);
    if (!agent) throw new Error(`session not found: ${sessionId}`);
    return runAgentTask(this.ctx, agent, task, onEvent);
  }

  /** 直接读某个会话从 seq 之后的最终文本（给需要自定义驱动的调用方）。 */
  lastText(sessionId: string, firstSeq: number): string {
    const agent = this.agentMap.get(sessionId);
    if (!agent) throw new Error(`session not found: ${sessionId}`);
    return lastAssistantText(agent, firstSeq);
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
