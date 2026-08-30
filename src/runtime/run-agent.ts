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

/**
 * 创建一个挂在指定 preset 上的隔离会话。
 *
 * 返回 `{ agent, dispose }`——**dispose 必须调**。agents.create 返回的 disposer
 * 释放的是 agent scope（detachSession / detachAgent / loop）；丢掉它，长驻的单
 * 进程里每跑一次就泄漏一个活着的 agent。session log 在 runAgentTask 里已 flush
 * 到磁盘，dispose 之后细聊界面照样看得见这次会话。
 */
export async function createAppAgent(
  ctx: any,
  presetId: string,
  cwd: string,
): Promise<{ agent: any; dispose: () => void }> {
  const { installModelSelection } = await import("@deepseek-ai/dsh-agent");
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  const agentPresets = ctx.get("agentPresets");
  const selection = ctx.get("agentDefaultModel").currentSelection();
  mkdirSync(cwd, { recursive: true });

  const created = await ctx.get("agents").create({
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
  return {
    agent: created.agent,
    dispose: typeof created.dispose === "function" ? created.dispose : () => {},
  };
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

  const text = lastAssistantText(agent, firstSeq);

  // DSH 的驱动循环 kick() 用 `catch(_error){}` 吞掉一次 turn 里的任何异常
  // （凭证缺失、断网、工具失败），失败被写进 turn/end 的 reason={kind:"error"}
  // 之后 agent 照常回到 idle。whenIdle() 于是正常 resolve、这里不抛。
  // 不主动去读那条 error，跑失败就会被当成「跑成功、交付物为空」存档——
  // 用户在历史里永远看不到「上次为什么没跑成」。
  //
  // 只在**没有拿到有效产出**时才把 error 抛出来：中途某 turn 出错但助手最终
  // 还是给了东西，算成功；彻底没产出又有 error turn，才是真失败。
  if (text.trim() === "") {
    const failure = lastTurnError(agent, firstSeq);
    if (failure) throw new Error(failure);
  }

  return text;
}

/**
 * firstSeq 之后最后一条「失败」的 turn/end 的错误信息，没有则返回 null。
 * DSH 把它写成 reason={kind:"error", error:{message, code}}（aborted 不算失败）。
 */
export function lastTurnError(agent: any, firstSeq: number): string | null {
  let failure: string | null = null;
  for (const event of agent.session.events) {
    if (event.seq < firstSeq) continue;
    if (event.type !== "turn/end") continue;
    const reason = event.data?.reason;
    if (reason?.kind === "error") {
      const err = reason.error;
      const msg = typeof err?.message === "string" && err.message !== "" ? err.message : "";
      const code = typeof err?.code === "string" ? err.code : "";
      failure = msg || code || "运行时出错，助手没有产出";
    } else if (reason?.kind === "completed" || reason === undefined) {
      // 后面又有成功的 turn，把之前的失败清掉——以最后一次为准。
      failure = null;
    }
  }
  return failure;
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
