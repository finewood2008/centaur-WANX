/**
 * PRDDraft —— 对话过程中的唯一事实源。
 *
 * 界面右栏那份 PRD 和最终的 AppSpec 都是它的投影。不允许 PRD 文档变成第二份
 * 事实源，否则必然漂移。草稿由客户端持有、每轮回传，服务端不存会话状态。
 */

/** 要问用户的 9 个槽位。 */
export const SLOT_KEYS = [
  "goal",
  "scope",
  "sources",
  "actions",
  "deliverable",
  "when",
  "workflow",
  "boundaries",
  "params",
] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];

/** 产品经理自己归纳的部分。这些**不进 AppSpec**，只进文档与 rationale.yml。 */
export const DERIVE_KEYS = ["name", "background", "target_user", "acceptance"] as const;
export type DeriveKey = (typeof DERIVE_KEYS)[number];

export type SlotValue = string | string[];

export interface SlotEntry {
  value: SlotValue;
  /** 用户给出的「为什么」。判断沉淀，落 rationale.yml，不进 spec。 */
  why?: string;
  /** 用户没答、由系统按最佳猜测填的。 */
  guessed?: boolean;
}

export interface PRDDraft {
  slots: Partial<Record<SlotKey, SlotEntry>>;
  derived: Partial<Record<DeriveKey, SlotValue>>;
}

export function emptyDraft(): PRDDraft {
  return { slots: {}, derived: {} };
}

const SLOT_SET = new Set<string>(SLOT_KEYS);
const DERIVE_SET = new Set<string>(DERIVE_KEYS);

/** 用户答不出时的兜底，供「够了，就照现在这样造」用。 */
export const SLOT_FALLBACK: Record<SlotKey, SlotValue> = {
  goal: "把这件事盯住，不遗漏",
  scope: "通用",
  sources: ["你的资料"],
  actions: ["搜索", "归纳", "撰写"],
  deliverable: ["一份清单"],
  when: "你叫它才跑",
  workflow: ["先把相关材料翻一遍", "挑出需要处理的部分", "整理成结果给你"],
  boundaries: ["不确定的事先问你，不擅自决定"],
  params: "暂无",
};

/** 把一轮的 patch / derive 合进草稿。未知键直接忽略，不让模型往里塞东西。 */
export function applyPatch(
  draft: PRDDraft,
  patch: unknown,
  derive: unknown,
): { draft: PRDDraft; touched: string[] } {
  const next: PRDDraft = {
    slots: { ...draft.slots },
    derived: { ...draft.derived },
  };
  const touched: string[] = [];

  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    for (const [key, raw] of Object.entries(patch as Record<string, unknown>)) {
      if (!SLOT_SET.has(key)) continue;
      const entry = toSlotEntry(raw);
      if (!entry) continue;
      next.slots[key as SlotKey] = entry;
      touched.push(key);
    }
  }

  if (derive && typeof derive === "object" && !Array.isArray(derive)) {
    for (const [key, raw] of Object.entries(derive as Record<string, unknown>)) {
      if (!DERIVE_SET.has(key)) continue;
      const value = toSlotValue(raw);
      if (value === null) continue;
      next.derived[key as DeriveKey] = value;
      touched.push(key);
    }
  }

  return { draft: next, touched };
}

function toSlotEntry(raw: unknown): SlotEntry | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw) {
    const obj = raw as { value: unknown; why?: unknown };
    const value = toSlotValue(obj.value);
    if (value === null) return null;
    return { value, why: typeof obj.why === "string" ? obj.why : undefined };
  }
  const value = toSlotValue(raw);
  return value === null ? null : { value };
}

function toSlotValue(raw: unknown): SlotValue | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" ? null : t;
  }
  if (Array.isArray(raw)) {
    const items = raw.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return items.length > 0 ? items : null;
  }
  return null;
}

/**
 * 把用户这一轮真实的选择盖回草稿——**盖在模型的改写之上**。
 *
 * 客户端知道用户点了哪几个选项（`answered`），模型只是事后描述这件事。
 * 之前这里只在模型忘了写 patch 时兜底，于是模型写了 patch 就赢：实测用户在
 * workflow 槽位勾了三条步骤，模型把它们揉成一句「提取行动项→推断负责人→…」，
 * 三步变一步，编译出来的工作手册就只剩一行。
 *
 * `draftToIntent` 里写着「用户的选择是权威的，不要改写、不要发挥」——那句话
 * 得在这里就成立，不能只写给定义器看。
 *
 * 模型归纳的 `why` 留着：那是它真正的增量（用户为什么这么选），不是对选择的改写。
 */
export function applyAnswered(
  draft: PRDDraft,
  answered: { slot: SlotKey; value: SlotValue } | null,
): { draft: PRDDraft; touched: string[] } {
  if (!answered) return { draft, touched: [] };
  const why = draft.slots[answered.slot]?.why;
  return applyPatch(draft, { [answered.slot]: { value: answered.value, why } }, null);
}

/** 还没聊到的槽位。`done` 只有在这里为空时才被接受——完整性由代码把关，不交给模型。 */
export function missingSlots(draft: PRDDraft): SlotKey[] {
  return SLOT_KEYS.filter((k) => draft.slots[k] === undefined);
}

/** 把没填的槽位按最佳猜测补上，并标记 guessed。 */
export function fillGuesses(draft: PRDDraft): PRDDraft {
  const next: PRDDraft = { slots: { ...draft.slots }, derived: { ...draft.derived } };
  for (const key of SLOT_KEYS) {
    if (next.slots[key] === undefined) {
      next.slots[key] = { value: SLOT_FALLBACK[key], guessed: true };
    }
  }
  return next;
}

export function asList(value: SlotValue | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function asText(value: SlotValue | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join("、") : value;
}

/**
 * 把草稿摊平成给定义器的意图文本。
 *
 * 比一句 raw intent 结构化得多，`defineAppSpec` 不用再从散文里猜字段——
 * 落地后应该能看到 `repairs` 计数下降。
 */
export function draftToIntent(draft: PRDDraft): string {
  const s = draft.slots;
  const lines = [
    "根据下面这份已经和用户逐条确认过的需求，生成 AppSpec。",
    "用户的选择是权威的，不要改写、不要发挥。",
    "",
    `助手名称：${asText(draft.derived.name) || "未定"}`,
    `它盯着什么：${asText(s.goal?.value)}`,
    `它管哪一摊：${asText(s.scope?.value)}`,
    `它要翻的资料：${asText(s.sources?.value)}`,
    `它会做的事：${asText(s.actions?.value)}`,
    `用户会拿到什么：${asText(s.deliverable?.value)}`,
    `什么时候用它：${asText(s.when?.value)}`,
    `它的工作步骤：${asList(s.workflow?.value).map((x, i) => `${i + 1}. ${x}`).join(" ")}`,
    `它不该做什么：${asList(s.boundaries?.value).join("；")}`,
    `用户想自己调的：${asText(s.params?.value)}`,
  ];
  return lines.join("\n");
}
