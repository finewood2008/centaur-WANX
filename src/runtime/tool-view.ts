import { scopeOf } from "@deepseek-ai/dsh-scope";

/**
 * 工具调用的呈现器：把「模型在用哪个工具干什么」翻译成给用户看的中文白话。
 *
 * 三层兜底，绝不把原始工具名漏到界面上：
 *   1. 工具自带 presentCall —— 用它返回的**结构化字段**（路径/命令/diff）
 *      配中文动词模板拼一句白话。DSH 的 view.title 是英文，不直接用。
 *   2. 没有 presenter —— 万象自己的白话表（原 STEP_LABEL，降级为兜底）。
 *   3. 连表都不认识 —— 按名字说人话：MCP 工具（mcp__<server>__<tool>）说
 *      「正在使用外部能力：<server>」，其余一律「正在处理」。
 *
 * presenter 是第三方代码：每次调用都包 try/catch，一张坏卡片不该打断整条流。
 */

/** 万象的中文动词兜底表。只有没有 presenter 的工具才用得上（主要是 MCP）。 */
const FALLBACK_LABEL: Record<string, string> = {
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

/** 第 3 层：名字本身。MCP 工具用 server 名说话，绝不吐 raw name。 */
export function genericLabel(name: string): string {
  const m = /^mcp__([a-z0-9][a-z0-9-]{0,31})__/u.exec(name);
  return m ? `正在使用外部能力：${m[1]}` : "正在处理";
}

function basename(p: unknown): string {
  const s = typeof p === "string" ? p : "";
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function locName(view: any): string {
  return basename(view?.locations?.[0]?.path ?? "");
}

/** ToolCallView（DSH 的结构化渲染意图）→ 一句中文。 */
export function labelFromView(view: any, name: string): string {
  if (!view || typeof view !== "object") return FALLBACK_LABEL[name] ?? genericLabel(name);
  if (view.card === "terminal") return "正在执行操作";
  if (view.card === "diff") {
    const file = basename(view.diffs?.[0]?.path ?? "");
    return file ? `正在写「${file}」` : "正在写文件";
  }
  // generic：按 kind 分流，带上对象名（文件名）让进度有内容。
  switch (view.kind) {
    case "read": {
      const f = locName(view);
      return f ? `正在读「${f}」` : "正在读材料";
    }
    case "search":
      return "正在翻找资料";
    case "fetch":
      return "正在读取网页";
    case "edit": {
      const f = locName(view);
      return f ? `正在修改「${f}」` : "正在修改文件";
    }
    case "delete":
      return "正在清理文件";
    case "move":
      return "正在整理文件";
    case "execute":
      return "正在执行操作";
    default:
      return FALLBACK_LABEL[name] ?? genericLabel(name);
  }
}

/** 结果正文的长度上限。read 一份大文件的原文没必要整个塞进流里。 */
const MAX_RESULT_CHARS = 20_000;

function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text") {
      const t = (block as any).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  const joined = parts.join("\n");
  return joined.length > MAX_RESULT_CHARS
    ? `${joined.slice(0, MAX_RESULT_CHARS)}\n…（内容太长，截断了）`
    : joined;
}

export interface CallView {
  label: string;
  /** 展开卡片时给用户看的入参（小而可读时才给）。 */
  input?: string;
}

export interface ResultView {
  ok: boolean;
  text: string;
}

export interface Presenter {
  call(name: string, argsJson: string, callId: string): CallView;
  result(callId: string, data: any): ResultView;
}

/** 入参的展开展示：能 pretty-print 就 pretty，太大就不给。 */
function prettyInput(argsJson: string): string | undefined {
  if (typeof argsJson !== "string" || argsJson.length > 4000) return undefined;
  try {
    return JSON.stringify(JSON.parse(argsJson), null, 2);
  } catch {
    return argsJson || undefined;
  }
}

/**
 * 每个活着的 agent 一份 presenter。
 *
 * scope 是必须的：preset 把工具搬到 agent 平面之后，`tools.get(name)` 在
 * 全局视图里根本看不见它们——必须带上这个 agent 的 ScopeKey。
 */
export function makePresenter(ctx: any, agent: any): Presenter {
  const tools = safeGet(ctx, "tools");
  // scope 同步解析——presenter 必须是纯的：同一串事件永远投影出同一串结果，
  // 回放才与直播长得一样（异步就绪会让最前几张卡在回放与直播间不一致）。
  let scope: unknown;
  try {
    scope = scopeOf(agent?.ctx);
  } catch {
    scope = undefined;
  }

  return {
    call(name, argsJson, _callId) {
      let view: any;
      try {
        const def = tools?.get?.(name, scope);
        if (def?.presentCall) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(argsJson);
          } catch {
            parsed = {};
          }
          view = def.presentCall(parsed);
        }
      } catch {
        view = undefined;
      }
      const label = view
        ? labelFromView(view, name)
        : FALLBACK_LABEL[name] ?? genericLabel(name);
      return { label, input: prettyInput(argsJson) };
    },

    result(_callId, data) {
      // 成败要看两处：事件级 error 是内部故障身份（少见）；绝大多数真实失败
      // ——文件不存在、被沙箱拒绝——写在模型面 ToolResultBlock 的 isError 上。
      // 只看前者会把大多数失败标成绿点。
      const block = data?.message?.content?.[0];
      const ok = data?.error === undefined && block?.isError !== true;
      // v1 的结果正文直接取模型面文本（presentResult 的结构化卡片留给以后；
      // 摘要行保持 call 阶段的白话标题，客户端只换状态点）。
      let text = blocksText(block?.content);
      if (text === "" && !ok) {
        text = data?.error?.code ? `失败（${data.error.code}）` : "失败";
      }
      return { ok, text };
    },
  };
}

function safeGet(ctx: any, name: string): any {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}
