import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * 在一个已经 boot 好的 DSH ctx 上创建会话、驱动一轮任务。
 *
 * 这层与「ctx 是怎么来的」无关：万象服务进程用它驱动共享的 web-profile ctx
 * （与浏览器细聊同一个运行时——同一个 agent 平面、同一套 preset 语义），
 * `WanxiangRuntime` 用它驱动自己 boot 的 headless ctx（探针与测试）。
 */

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
 * 工具名 → 白话。用户不该在界面上看见 glob、read 这些词。
 * 认不出的工具统一说「正在处理」，绝不把原始工具名漏出去。
 */
const STEP_LABEL: Record<string, string> = {
  glob: "正在翻找资料",
  grep: "正在检索内容",
  read: "正在读材料",
  read_image: "正在看图片",
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
export function toRunEvents(event: any): RunEvent[] {
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

/** 创建一个挂在指定 preset 上的隔离会话，返回 agent 句柄。 */
export async function createAppAgent(ctx: any, presetId: string, cwd: string): Promise<any> {
  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const agentPresets = ctx.get("agentPresets");
  const selection = ctx.get("agentDefaultModel").currentSelection();
  mkdirSync(cwd, { recursive: true });

  const { agent } = await ctx.get("agents").create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd, agentPreset: presetId },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx: any) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      if (agentPresets) {
        await agentPresets.mount(agentCtx, presetId);
      }
    },
  });
  return agent;
}

/**
 * 驱动一轮任务，边跑边把进度推给 onEvent，结束后返回助手的最终文本。
 *
 * 订阅 cordis 的 `session/event`（回调签名 `(session, event)`），只收本
 * session 的。连续重复的进度折叠——实测一次运行连着推了 18 条
 * 「正在执行操作」，那不是进度，是噪音。
 */
export async function runAgentTask(
  ctx: any,
  agent: any,
  task: string,
  onEvent: (event: RunEvent) => void = () => {},
): Promise<string> {
  const { createUserMessage } = await import("@deepseek-ai/dsh-llm");

  await agent.whenIdle();
  const firstSeq = agent.session.seq;

  // 订阅要在 followup 之前挂上，否则最前面几条事件会漏掉。
  let lastStep = "";
  let dispose: (() => void) | undefined;
  try {
    dispose = ctx.on("session/event", (session: any, event: any) => {
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
    await ctx.get("sessions").flush(agent.session);
  } finally {
    dispose?.();
  }

  return lastAssistantText(agent, firstSeq);
}

/** 从 firstSeq 之后的事件里取助手最后一段非空文本。 */
export function lastAssistantText(agent: any, firstSeq: number): string {
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
