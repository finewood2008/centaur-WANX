import type { AppSpec } from "../appspec/schema";
import { compile } from "../compiler/compile";
import { serializeAppPackage } from "../compiler/serialize";
import { defineAppSpec } from "./define";
import { extractJson } from "./parse";
import type { LLMClient } from "./llm";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** 引导者一轮回复：问题文本 + 给用户点选的 3 个候选选项（可选）。 */
export interface GuideReply {
  text: string;
  options?: string[];
}

export interface InterviewOutcome {
  done: boolean;
  reply: string;
  app?: {
    name: string;
    appspec: AppSpec;
    files: Record<string, string>;
  };
}

const SYSTEM_PROMPT = `你是「应用引导者」，通过多轮对话帮用户创建一个应用。

你需要逐步了解这些信息：
1. 应用目标 goal：这个应用要帮用户解决什么问题
2. 领域 domain：customer_management（客户管理）/ research（研究）/ content（内容）/ archive（归档）/ personal_assistant（个人助理）/ general（通用）
3. 记忆绑定 memory_binding：读哪些记忆库、写哪些、检索策略
4. 能力 capabilities：search（搜索）/ summarize（总结）/ extract（抽取）/ compose（撰写）/ notify（通知）/ api_call（调用API）/ browse（浏览网页）
5. 交付物 delivery：产出什么、触发方式、去向
6. 用户参数 params：需要用户提供哪些参数

每轮回复必须输出 JSON（不要 markdown 代码块、不要其他任何文字），格式：
{"question":"引导问题","options":["选项1","选项2","选项3"]}

- question：本轮问用户的问题（中文，简短友好）
- options：给用户的 3 个候选回答，针对当前问的维度，简短具体、方便点选
- 每轮只问 1 个维度，不要一次问太多
- 当信息已足够定义应用时，输出 {"question":"信息已经完整，可以生成应用了","options":[]}`;

export function buildInterviewPrompt(messages: ChatMessage[]): string {
  const lines: string[] = [SYSTEM_PROMPT, ""];
  for (const m of messages) {
    lines.push(`${m.role === "user" ? "用户" : "引导者"}：${m.content}`);
  }
  lines.push("引导者：");
  return lines.join("\n");
}

/** 解析引导者的回复：优先取 JSON 的 question+options，失败则整段当纯文本。 */
export function parseGuideReply(output: string): GuideReply {
  try {
    const parsed = extractJson(output);
    if (parsed && typeof parsed === "object" && parsed !== null) {
      const q = (parsed as Record<string, unknown>).question;
      const opts = (parsed as Record<string, unknown>).options;
      if (typeof q === "string" && Array.isArray(opts)) {
        const options = opts.filter((o): o is string => typeof o === "string").slice(0, 3);
        return { text: q, options: options.length > 0 ? options : undefined };
      }
    }
  } catch {
    /* fall through to plain text */
  }
  return { text: output };
}

/** 对话引导：LLM 提问 + 候选选项，逐步收集信息。 */
export async function conductDialog(
  messages: ChatMessage[],
  llm: LLMClient,
): Promise<GuideReply> {
  const output = await llm.complete(buildInterviewPrompt(messages));
  return parseGuideReply(output);
}

/** 从对话历史生成应用（复用确定性的 defineAppSpec 链路）。 */
export async function generateFromConversation(
  messages: ChatMessage[],
  llm: LLMClient,
): Promise<InterviewOutcome> {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
    .join("\n");
  const intent = `根据以下对话创建应用：\n${transcript}`;

  const defined = await defineAppSpec(intent, llm, { maxRepairs: 2 });
  if (defined.ok) {
    // 知君插件（memory-read/write）尚未实现，先编译成 DSH 兼容变体（不含占位插件）；
    // 知君插件落地后改回 includeCentaurPlugins: true。
    const pkg = compile(defined.value, { includeCentaurPlugins: false });
    const files = serializeAppPackage(pkg);
    return {
      done: true,
      reply: `已为你生成应用「${defined.value.name}」！`,
      app: { name: defined.value.name, appspec: defined.value, files },
    };
  }
  return {
    done: false,
    reply: `生成遇到问题：${defined.error}。请继续补充信息后重试。`,
  };
}
