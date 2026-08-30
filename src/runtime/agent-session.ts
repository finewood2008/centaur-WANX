import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * 会话工厂：万象的每条会话都从这里出生或复活。
 *
 * 「当前是哪个助手」不是全局状态——它是建会话那一刻写进 header 的两个显式
 * 参数：`agentPreset`（人格与工具集）和 `cwd`（它睁眼看见的世界，也是沙箱
 * 边界）。此后不可变；恢复历史会话时从它自己的 header 读回来，绝不用
 * 「当前默认」——换了 preset 的历史是模型没法继续演的历史。
 */

/** 会话 id 的语义前缀。「跑一次」与「对话」两类会话共存靠它区分。 */
export const RUN_PREFIX = "wanx-run-";
export const CHAT_PREFIX = "wanx-chat-";

export type SessionKind = "run" | "chat";

export interface AgentHold {
  agent: any;
  /** 必须 await：它停掉驱动循环、等它退出、从 registry 摘除、卸掉 scope。 */
  dispose: () => Promise<void>;
}

function newSessionId(kind: SessionKind, slug: string): string {
  return `${kind === "run" ? RUN_PREFIX : CHAT_PREFIX}${slug}-${randomUUID()}`;
}

/**
 * 建一条挂在指定助手上的全新会话。
 *
 * @param cwd 应用自己的 workspace——工具的根、技能发现的项目根、沙箱的
 *   写边界，三者由这一个值决定。调用方传 workspaceDir(APPS_DIR, slug)。
 */
export async function createSession(
  ctx: any,
  opts: { slug: string; kind: SessionKind; cwd: string },
): Promise<AgentHold> {
  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const selection = ctx.get("agentDefaultModel").currentSelection();
  mkdirSync(opts.cwd, { recursive: true });

  const created = await ctx.get("agents").create({
    sessionId: SessionId(newSessionId(opts.kind, opts.slug)),
    meta: { cwd: opts.cwd, agentPreset: opts.slug },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: any) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      await ctx.get("agentPresets").mount(agentCtx, opts.slug);
    },
  });
  return { agent: created.agent, dispose: () => created.dispose() };
}

/**
 * 复活一条历史会话继续聊。preset 从它自己的 header 读——durable 字段，
 * 权威；不存在或没绑助手就如实报错，不猜。
 */
export async function resumeSession(
  ctx: any,
  sessionId: string,
): Promise<AgentHold & { presetId: string }> {
  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const snap = await ctx.get("sessionQuery").readTitleSnapshot(SessionId(sessionId));
  const presetId: string | undefined = snap?.session?.agentPreset;
  if (!presetId) throw new Error("这条对话没有绑定助手");
  const selection = ctx.get("agentDefaultModel").currentSelection();
  const created = await ctx.get("agents").resume({
    resumeSessionId: SessionId(sessionId),
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: any) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      await ctx.get("agentPresets").mount(agentCtx, presetId);
    },
  });
  return { agent: created.agent, dispose: () => created.dispose(), presetId };
}
