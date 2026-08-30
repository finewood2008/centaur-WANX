import { createSession, type AgentHold } from "./agent-session";
import { projectSessionEvent } from "./chat-events";
import { makePresenter } from "./tool-view";

/**
 * 「跑一次」的会话驱动：在共享的宿主 ctx 上建一条一次性会话、驱动一轮任务。
 *
 * 会话构造统一走 agent-session.ts（对话链路也从那儿出生）；这里只保留
 * job 语义：每次全新会话（确定性）、跑完即收。进度事件由 chat-events 的
 * 投影 + tool-view 的呈现器给出——与对话界面同一份翻译，只是压扁成
 * step/text 两种（跑一次的界面只要白话进度条）。
 */

/**
 * 跑一次任务时推给界面的进度。
 *
 * `step` 是给用户看的白话（「正在读「八月客户往来.md」」），不是工具名——
 * 界面上不出现 glob / bash 这种词。`text` 是助手说的话。
 */
export interface RunEvent {
  kind: "step" | "text";
  text: string;
}

/**
 * 创建一个挂在指定 preset 上的隔离会话。
 *
 * 返回 `{ agent, dispose }`——**dispose 必须 await**：它停掉驱动循环、等它
 * 退出、从 registry 摘除、卸掉 scope。丢掉或不 await，长驻的单进程里每跑
 * 一次就漏一次没做完的拆卸。session log 在 runAgentTask 里已 flush 到磁盘，
 * dispose 之后历史照样读得到。
 */
export async function createAppAgent(
  ctx: any,
  presetId: string,
  cwd: string,
): Promise<AgentHold> {
  return createSession(ctx, { slug: presetId, kind: "run", cwd });
}

/**
 * 驱动一轮任务，边跑边把进度推给 onEvent，结束后返回助手的最终文本。
 *
 * 订阅 cordis 的 `session/event`（回调签名 `(session, event)`），只收本
 * session 的。连续重复的进度折叠——实测一次运行连着推了 18 条一样的
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
  const present = makePresenter(ctx, agent);

  // 订阅要在 followup 之前挂上，否则最前面几条事件会漏掉。
  let lastStep = "";
  let dispose: (() => void) | undefined;
  try {
    dispose = ctx.on("session/event", (session: any, event: any) => {
      if (session?.id !== agent.session.id) return;
      if (typeof event?.seq === "number" && event.seq < firstSeq) return;
      for (const ce of projectSessionEvent(event, present)) {
        if (ce.t === "tool.call") {
          if (ce.label === lastStep) continue;
          lastStep = ce.label;
          onEvent({ kind: "step", text: ce.label });
        } else if (ce.t === "assistant") {
          lastStep = "";
          onEvent({ kind: "text", text: ce.text });
        }
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

  // 内核的驱动循环 kick() 吞掉一次 turn 里的任何异常（凭证缺失、断网、工具
  // 失败），失败被写进 turn/end 的 reason={kind:"error"} 之后 agent 照常回到
  // idle。whenIdle() 于是正常 resolve、这里不抛。不主动去读那条 error，跑失败
  // 就会被当成「跑成功、交付物为空」存档——用户永远看不到「上次为什么没跑成」。
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
 * 内核把它写成 reason={kind:"error", error:{message, code}}（aborted 不算失败）。
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
