import { extractJson } from "./parse";
import { missingSlots, SLOT_KEYS, type PRDDraft, type SlotKey } from "./draft";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AskOption {
  label: string;
  description?: string;
  /** 选了它，PRD 里会写成的那句话。把点选和右栏文档绑在一起。 */
  doc?: string;
  /** 判断信息的小标，如「涉及金额」。 */
  tag?: string;
}

export interface Ask {
  slot: SlotKey;
  type: "single" | "multi";
  options: AskOption[];
  allowCustom: boolean;
}

export interface PmTurn {
  /** 分隔符之前的散文。问题只有这一个来源。 */
  prose: string;
  patch: unknown;
  derive: unknown;
  ask: Ask | null;
  done: boolean;
}

export const SEPARATOR = "<<<SPEC>>>";

/**
 * 找出散文和结构化部分的分界。
 *
 * 严格标记优先；但模型很爱把标记写成光秃秃的 `---`（markdown 分隔线），
 * 那样 JSON 会直接漏到界面上。所以再兜一层：从行首的 `{` 开始就当结构区，
 * 并把结尾多余的 `---` 削掉。流式时用同一套逻辑算「能给界面看的部分」，
 * 半个 JSON 也不会被吐出去。
 */
export function splitProseAndSpec(raw: string): { prose: string; spec: string | null } {
  const marked = raw.indexOf(SEPARATOR);
  if (marked >= 0) {
    return { prose: trimRule(raw.slice(0, marked)), spec: raw.slice(marked + SEPARATOR.length) };
  }
  const brace = raw.search(/(^|\n)\s*\{/u);
  if (brace >= 0) {
    const at = raw.indexOf("{", brace);
    return { prose: trimRule(raw.slice(0, at)), spec: raw.slice(at) };
  }
  return { prose: raw, spec: null };
}

/** 削掉散文尾巴上的 markdown 分隔线和空白。 */
function trimRule(text: string): string {
  return text.replace(/\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u, "").trim();
}

/**
 * 流式时能安全推给界面的部分。
 * `final` 为 false 时末尾留一截不发，免得半个标记或半个 `{` 漏出去。
 */
export function visiblePart(raw: string, final: boolean): string {
  const { prose, spec } = splitProseAndSpec(raw);
  if (spec !== null || final) return prose;
  return prose.slice(0, Math.max(0, prose.length - SEPARATOR.length));
}

/** 开场白是静态文案，不走 LLM：省一次调用，也保证第一屏不用等。 */
export const OPENING =
  "我是万象的产品经理。接下来我问、你选——每一步的结论我都会写进右边那份文档，你随时能看。";

const SLOT_BRIEF: Record<SlotKey, string> = {
  goal: "它盯着什么（→ 第 3 节 目标）",
  scope: "它管哪一摊事（喂第 1、2 节和助手名，本身不单独成节）",
  sources: "它平时要翻哪些资料（→ 第 5 节 资料来源）",
  actions: "它会替用户动手做哪几件事（→ 第 6 节 功能需求）",
  deliverable: "用户会拿到什么（→ 第 8 节 交付物）",
  when: "什么时候用它（→ 第 9 节 触发方式）",
  workflow: "它每次干活的步骤，有先后顺序（→ 第 7 节 工作流程，会变成它真正的工作手册）",
  boundaries: "它不该做什么（→ 第 4 节 非目标）",
  params: "用户想随时自己调的东西（→ 第 10 节 可配置项）",
};

const MULTI_SLOTS = new Set<SlotKey>(["sources", "actions", "deliverable", "workflow", "boundaries"]);

/** 模型没给选项时的保底，保证「每一轮都有选择项」这条不被破。 */
const FALLBACK_OPTIONS: Record<SlotKey, AskOption[]> = {
  goal: [
    { label: "别漏掉该做的事", description: "把承诺和待办盯住", doc: "不遗漏该跟进的事项" },
    { label: "帮我盯住变化", description: "有新情况就让我知道", doc: "监测变化并主动提示" },
    { label: "替我整理成型", description: "把零散的东西收成结果", doc: "把零散信息整理成结论" },
  ],
  scope: [
    { label: "客户与关系", description: "跟人打交道的那一摊", doc: "范围限定在客户与合作关系" },
    { label: "研究与情报", description: "盯市场、盯对手", doc: "范围限定在研究与情报" },
    { label: "内容与文档", description: "写东西、整理材料", doc: "范围限定在内容与文档" },
  ],
  sources: [
    { label: "我的工作记录", description: "平时随手记下的东西", doc: "你的工作记录" },
    { label: "往来邮件与消息", description: "对外沟通的痕迹", doc: "往来邮件与消息" },
    { label: "会议与通话记录", description: "口头信息的来源", doc: "会议与通话记录" },
  ],
  actions: [
    { label: "翻一遍找出重点", description: "在你给的资料里搜", doc: "搜索" },
    { label: "归纳成一条", description: "合并重复、去掉噪音", doc: "归纳" },
    { label: "写成能直接用的", description: "清单或草稿", doc: "撰写" },
  ],
  deliverable: [
    { label: "一份清单", description: "一条一条，能直接照着做", doc: "一份清单" },
    { label: "一段小结", description: "读一遍就知道发生了什么", doc: "一段小结" },
    { label: "一份草稿", description: "改两个字就能用", doc: "一份草稿" },
  ],
  when: [
    { label: "每次聊完自动跑", description: "你不用记得叫它", doc: "每次沟通结束后自动触发" },
    { label: "想起来就叫它", description: "完全由你发起", doc: "手动触发，由你发起" },
    { label: "每周固定跑一次", description: "固定节奏", doc: "每周定时触发" },
  ],
  workflow: [
    { label: "先把相关材料翻一遍", description: "建立上下文", doc: "检索相关材料，建立上下文" },
    { label: "挑出需要处理的部分", description: "只留该动的", doc: "筛出需要处理的条目" },
    { label: "整理成结果给你", description: "输出交付物", doc: "整理成交付物输出" },
  ],
  boundaries: [
    { label: "不许自己对外发东西", description: "草稿可以，发送要你点头", doc: "禁止自动对外发送，仅生成草稿" },
    { label: "不碰钱和条款", description: "商务的事你自己定", doc: "禁止处理金额与合同条款" },
    { label: "拿不准就先问我", description: "宁可问，也别记错", doc: "置信度不足时先向你确认" },
  ],
  params: [
    { label: "暂时不用调什么", description: "先用默认的跑起来", doc: "本版本不开放可调项" },
    { label: "多久算需要处理", description: "时间阈值，各人不同", doc: "时间阈值：可调" },
    { label: "一次最多给我几条", description: "免得太长你不想看", doc: "单次条目上限：可调" },
  ],
};

/** 造一轮保底提问，用在模型给不出合法选项时。 */
export function fallbackAsk(slot: SlotKey): Ask {
  return {
    slot,
    type: MULTI_SLOTS.has(slot) ? "multi" : "single",
    options: FALLBACK_OPTIONS[slot],
    allowCustom: true,
  };
}

function draftSummary(draft: PRDDraft): string {
  const rows: string[] = [];
  for (const key of SLOT_KEYS) {
    const entry = draft.slots[key];
    if (!entry) continue;
    const value = Array.isArray(entry.value) ? entry.value.join("、") : entry.value;
    rows.push(`- ${key}：${value}`);
  }
  for (const [key, value] of Object.entries(draft.derived)) {
    rows.push(`- （已归纳）${key}：${Array.isArray(value) ? value.join("；") : value}`);
  }
  return rows.length > 0 ? rows.join("\n") : "（还什么都没有）";
}

/** 每轮一次调用的提示词：产品经理的三拍 ＋ 分隔符后的结构化输出。 */
export function buildPmPrompt(messages: ChatMessage[], draft: PRDDraft, turn: number): string {
  const missing = missingSlots(draft);
  const isFirst = turn === 0;

  const lines: string[] = [
    "你是「半人马AI-万象」的产品经理。用户不写代码、也说不清需求，但他认得出选项。",
    "你的活儿：通过给选择题，把他脑子里的东西问出来，同时把一份正式的助手需求文档写出来。",
    "",
    "## 你的回复分两段，用一行 <<<SPEC>>> 隔开",
    "",
    isFirst
      ? "分隔符之前是散文，**两拍**（这是第一轮，用户刚开口，没有东西可回读，不要硬编）："
      : "分隔符之前是散文，**三拍**，每拍之间空一行：",
    ...(isFirst
      ? [
          "1. 一句话说你打算怎么帮他（别复述他刚说的话）",
          "2. 提问：一句，指向下面选定的那个槽位",
        ]
      : [
          "1. 回读：「听下来，你真正要的是…」——把他上一轮的选择翻译成你的理解，说出你听到的言外之意。这是产品经理最值钱的动作。",
          "2. 交代去向：「我把它写进第 N 节「XX」了」——如果你还顺手归纳了某一节，一并说明，并提醒他回头看看对不对。",
          "3. 提问：一句，指向下面选定的那个槽位。",
        ]),
    "",
    "语气：克制、专业、像同事不像客服。不用表情符号，不说「太棒了」「好的呢」。",
    "",
    "## 分隔符之后是 JSON，只输出 JSON 对象本身",
    "",
    '{"patch":{"<槽位>":{"value":"或数组","why":"用户为什么这么选，一句话"}},',
    ' "derive":{"name":"助手名","background":"第1节正文","target_user":"第2节正文","acceptance":["第11节，每条一句"]},',
    ' "ask":{"slot":"<下一个槽位>","type":"single 或 multi","allowCustom":true,',
    '        "options":[{"label":"短标题","description":"两句解释：选它意味着什么、代价是什么","doc":"选了它，PRD 里会写成的那句话","tag":"可选的小标"}]},',
    ' "done":false}',
    "",
    "**硬规则：**",
    "- 分隔符必须原样写成 <<<SPEC>>>，**不要**写成 --- 或 ```——那样会被当成正文漏给用户看。",
    "- ask 里**没有** question 字段。问题只出现在分隔符之前的散文里，JSON 里再写一遍界面上会重复显示。",
    "- options **至少 3 个、不能为空**。每一轮都必须给选项，不许只抛一个开放问题。",
    "- doc 必填，写成正式的产品文档口吻（会原样进 PRD），跟 label 的口语不是一回事。",
    "- patch 写的是**上一轮**用户回答对应的槽位；第一轮没有 patch。",
    "- derive 是你自己归纳的，可以分几轮陆续补。name 尽早定。",
    "- 所有面向用户的文字都用中文，且**不许出现** agent、应用、spec、schema、编译、preset、检索策略 这些词。助手就叫「助手」，记忆库就叫「资料」。",
    "",
    "## 还没聊到的槽位（从里面挑一个问，别重复问已有的）",
    ...missing.map((k) => `- ${k}：${SLOT_BRIEF[k]}`),
    missing.length === 0 ? "（全部聊完了，把 done 设成 true，ask 设成 null）" : "",
    "",
    "## 目前的草稿",
    draftSummary(draft),
    "",
    "## 对话记录",
    ...messages.map((m) => `${m.role === "user" ? "用户" : "产品经理"}：${m.content}`),
    "",
    "产品经理：",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * 解析产品经理的输出。
 *
 * 降级安全：模型忘了写分隔符，整段就当散文显示，ask 为 null——
 * 调用方据此补一轮保底提问，界面不会空。
 */
export function parsePmOutput(raw: string): PmTurn {
  const { prose, spec } = splitProseAndSpec(raw);
  if (spec === null) {
    return { prose: prose.trim(), patch: null, derive: null, ask: null, done: false };
  }

  let parsed: unknown = null;
  try {
    parsed = extractJson(spec);
  } catch {
    return { prose, patch: null, derive: null, ask: null, done: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { prose, patch: null, derive: null, ask: null, done: false };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    prose,
    patch: obj.patch ?? null,
    derive: obj.derive ?? null,
    ask: toAsk(obj.ask),
    done: obj.done === true,
  };
}

function toAsk(raw: unknown): Ask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const slot = typeof obj.slot === "string" ? obj.slot : "";
  if (!(SLOT_KEYS as readonly string[]).includes(slot)) return null;

  const options = Array.isArray(obj.options)
    ? obj.options
        .map((o): AskOption | null => {
          if (typeof o === "string") return o.trim() === "" ? null : { label: o.trim() };
          if (!o || typeof o !== "object") return null;
          const item = o as Record<string, unknown>;
          const label = typeof item.label === "string" ? item.label.trim() : "";
          if (label === "") return null;
          return {
            label,
            description: typeof item.description === "string" ? item.description : undefined,
            doc: typeof item.doc === "string" ? item.doc : undefined,
            tag: typeof item.tag === "string" ? item.tag : undefined,
          };
        })
        .filter((o): o is AskOption => o !== null)
    : [];

  // 选项为空视为不合格——「每轮都有选择项」这条由代码把关，不靠模型自觉。
  if (options.length === 0) return null;

  // 天生多选的槽位由**代码**说了算，不看模型这一轮写了什么。
  //
  // 模型偶尔把 workflow 写成 single，用户就只能选一条——而 runFinalize 会用草稿
  // 覆盖回 AppSpec，于是定义器本来生成的 3-6 步被压成 1 步，「工作手册」这个
  // 产品的核心产物就退化成一句话。这条跟「每轮都得有选项」是同一类兜底。
  const forcedMulti = MULTI_SLOTS.has(slot as SlotKey);

  return {
    slot: slot as SlotKey,
    type: forcedMulti || obj.type === "multi" ? "multi" : "single",
    options,
    allowCustom: obj.allowCustom !== false,
  };
}
