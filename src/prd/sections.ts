import type { DeriveKey, SlotKey } from "../definer/draft";

/**
 * 助手需求文档的 11 节结构。中英并置——英文是正规文档的排版语汇，
 * 跟「界面上不许出现装饰性大写小标签」不冲突：这是章节名，不是界面装饰。
 *
 * 9 个问到的槽位里只有 8 个各占一节；`scope` 没有自己的章节，它喂第 1、2 节
 * 和文档头的助手名。另外 3 节由产品经理归纳。8 ＋ 3 ＝ 11。
 */
export interface Section {
  n: number;
  id: string;
  zh: string;
  en: string;
  /** 来自用户回答的槽位。 */
  slot?: SlotKey;
  /** 来自产品经理归纳。 */
  derive?: DeriveKey;
  /** 列表型章节渲染成项目符号，否则渲染成段落。 */
  list?: boolean;
  /** 有序列表（工作流程的步骤顺序是有意义的）。 */
  ordered?: boolean;
}

export const SECTIONS: Section[] = [
  { n: 1, id: "background", zh: "背景与问题", en: "Background & Problem", derive: "background" },
  { n: 2, id: "target_user", zh: "目标用户", en: "Target User", derive: "target_user" },
  { n: 3, id: "goal", zh: "目标", en: "Goals", slot: "goal" },
  { n: 4, id: "boundaries", zh: "非目标", en: "Non-Goals", slot: "boundaries", list: true },
  { n: 5, id: "sources", zh: "资料来源", en: "Data Sources", slot: "sources", list: true },
  { n: 6, id: "actions", zh: "功能需求", en: "Functional Requirements", slot: "actions", list: true },
  { n: 7, id: "workflow", zh: "工作流程", en: "Workflow", slot: "workflow", list: true, ordered: true },
  { n: 8, id: "deliverable", zh: "交付物", en: "Deliverables", slot: "deliverable", list: true },
  { n: 9, id: "when", zh: "触发方式", en: "Trigger", slot: "when" },
  { n: 10, id: "params", zh: "可配置项", en: "Parameters", slot: "params", list: true },
  { n: 11, id: "acceptance", zh: "验收标准", en: "Acceptance Criteria", derive: "acceptance", list: true },
];

/** 产品经理归纳的章节号，界面上要挂「由产品经理归纳」的小标。 */
export const PM_SECTION_IDS = SECTIONS.filter((s) => s.derive).map((s) => s.id);
