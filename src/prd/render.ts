import { asList, asText, type PRDDraft } from "../definer/draft";
import { SECTIONS } from "./sections";

export interface RenderMeta {
  /** 助手名 */
  name: string;
  /** 对话轮数 */
  turns: number;
  /** 生成日期，形如 2026-08-29。由调用方传入，保证渲染是纯函数。 */
  date: string;
}

/**
 * 把草稿确定性渲染成人读的 PRD（Markdown）。
 * 纯函数模板填充，不是 LLM 生成——同一份草稿永远渲染出同一份文档。
 */
export function renderPrd(draft: PRDDraft, meta: RenderMeta): string {
  const out: string[] = [
    `# ${meta.name} · 助手需求文档`,
    "",
    `> 半人马AI-万象 · CentaurAI-WanX`,
    "",
    "| | |",
    "|---|---|",
    `| 名称 Name | ${meta.name} |`,
    "| 版本 Version | v1 |",
    `| 定义 Defined | ${meta.date} · 对话 ${meta.turns} 轮 |`,
    "| 状态 Status | 已确认 Confirmed |",
    "",
  ];

  for (const section of SECTIONS) {
    const value = section.slot
      ? draft.slots[section.slot]?.value
      : section.derive
        ? draft.derived[section.derive]
        : undefined;
    const guessed = section.slot ? draft.slots[section.slot]?.guessed === true : false;

    const marks: string[] = [];
    if (section.derive) marks.push("由产品经理归纳");
    if (guessed) marks.push("按最佳猜测");
    const suffix = marks.length > 0 ? `　_（${marks.join("、")}）_` : "";

    out.push(`## ${section.n}. ${section.zh} ${section.en}${suffix}`, "");
    if (value === undefined) {
      out.push("_（没聊到，先空着）_", "");
      continue;
    }
    if (section.list) {
      const items = asList(value);
      out.push(...items.map((x, i) => (section.ordered ? `${i + 1}. ${x}` : `- ${x}`)), "");
    } else {
      out.push(asText(value), "");
    }
  }

  const whys = Object.entries(draft.slots)
    .filter(([, entry]) => entry?.why)
    .map(([key, entry]) => `- ${key}：${entry?.why}`);
  if (whys.length > 0) {
    out.push("---", "", "## 附：你当时是怎么想的", "", ...whys, "");
  }

  return out.join("\n");
}

/**
 * 判断沉淀。开发 PRD §15.3 明写它**写入记忆而非 spec**，
 * 所以这一族（每个槽位的 why ＋ 产品经理归纳的三节）单独落 rationale.yml。
 */
export function rationaleOf(draft: PRDDraft): Record<string, unknown> {
  const why: Record<string, string> = {};
  for (const [key, entry] of Object.entries(draft.slots)) {
    if (entry?.why) why[key] = entry.why;
  }
  return {
    background: draft.derived.background ?? null,
    target_user: draft.derived.target_user ?? null,
    acceptance: draft.derived.acceptance ?? [],
    why,
  };
}
