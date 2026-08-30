import type { AppSpec } from "../appspec/schema";

/**
 * 界面蓝图:每个助手的专属工作台长什么样,由 AppSpec 确定性投影出来。
 *
 * **蓝图不落盘。** 它是 app.yml 的纯函数——现算永不过期:调教改了步骤或
 * 交付物,蓝图自动跟新;旧助手零迁移;不存在第二事实源。前端拿到蓝图后
 * 从固定组件库拼装,没有生成代码,没有注入面。
 *
 * 「专属功能」的诚实来源:**最新交付物的结构化呈现 + 按需求编排的组件**。
 * 不虚构助手没有的能力——hero 决定的是「产出以什么工具形态立起来」。
 */

export type HeroKind = "checklist" | "table" | "digest";

export interface UiBlueprint {
  hero: {
    kind: HeroKind;
    /** 主区标题,来自需求语言(不是「最近的产出」这种系统词)。 */
    title: string;
    /** 没跑过时的空态引导——空态即教学。 */
    empty: string;
  };
  /** 侧区组件,按声明裁剪(params 空则不出现)。顺序即渲染顺序。 */
  side: Array<"actions" | "materials" | "params" | "schedule" | "manual" | "runs">;
}

/** delivery.form 的关键词 → 产出的工具形态。命中即止,全不命中落 digest。 */
const HERO_RULES: Array<{ kind: HeroKind; words: string[] }> = [
  { kind: "checklist", words: ["清单", "待办", "任务", "列表", "todo", "行动项"] },
  { kind: "table", words: ["表格", "名单", "一览", "台账", "表 "] },
  { kind: "digest", words: ["简报", "报告", "总结", "摘要", "周报", "日报", "月报", "综述"] },
];

/** domain 只影响措辞,不虚构数据能力。 */
const DOMAIN_NOUN: Record<AppSpec["domain"], string> = {
  customer_management: "跟进",
  research: "调研",
  content: "内容",
  archive: "整理",
  personal_assistant: "安排",
  general: "工作",
};

export function heroKindOf(form: string): HeroKind {
  const f = form.toLowerCase();
  for (const rule of HERO_RULES) {
    if (rule.words.some((w) => f.includes(w))) return rule.kind;
  }
  return "digest";
}

/** 给确认页/工作台用的一句中文形态名。 */
export function heroKindLabel(kind: HeroKind): string {
  return kind === "checklist" ? "清单工作台" : kind === "table" ? "表格工作台" : "简报工作台";
}

export function buildUiBlueprint(spec: Pick<AppSpec, "domain" | "delivery" | "params">): UiBlueprint {
  const kind = heroKindOf(spec.delivery.form);
  const noun = DOMAIN_NOUN[spec.domain] ?? "工作";
  const title =
    kind === "checklist"
      ? `当前的${noun}清单`
      : kind === "table"
        ? `${noun}一览`
        : `最新${noun}简报`;
  const empty =
    kind === "checklist"
      ? `放入资料，按一下「让它跑一次」，这里就会长出你的${noun}清单。`
      : kind === "table"
        ? `放入资料，按一下「让它跑一次」，这里就会出现一张${noun}表。`
        : `放入资料，按一下「让它跑一次」，这里就会出现它写给你的${noun}简报。`;

  const side: UiBlueprint["side"] = ["actions", "materials"];
  if ((spec.params ?? []).length > 0) side.push("params");
  side.push("schedule", "manual", "runs");
  return { hero: { kind, title, empty }, side };
}
