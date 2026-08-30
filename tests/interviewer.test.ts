import { describe, it, expect } from "vitest";
import { buildPmPrompt, parsePmOutput, fallbackAsk, visiblePart, SEPARATOR } from "../src/definer/interviewer";
import {
  emptyDraft,
  applyPatch,
  applyAnswered,
  missingSlots,
  fillGuesses,
  SLOT_KEYS,
} from "../src/definer/draft";

const SPEC = (obj: unknown) => `${SEPARATOR}\n${JSON.stringify(obj)}`;

describe("parsePmOutput", () => {
  it("分隔符之前是散文，之后是结构", () => {
    const r = parsePmOutput(
      `听下来你要的是别漏事。\n\n我写进第 3 节了。\n\n那你平时翻哪些东西？\n` +
        SPEC({ patch: { goal: { value: "别漏事" } }, ask: { slot: "sources", type: "multi", options: [{ label: "邮件" }] }, done: false }),
    );
    expect(r.prose).toContain("那你平时翻哪些东西？");
    expect(r.prose).not.toContain("{");
    expect(r.ask?.slot).toBe("sources");
    expect(r.ask?.type).toBe("multi");
  });

  it("模型把分隔符写成光秃秃的 --- 时照样解析（它很爱这么干）", () => {
    const r = parsePmOutput(
      `听下来你要的是别漏事。\n\n那你平时翻哪些东西？\n\n---\n\n` +
        JSON.stringify({ patch: { goal: { value: "别漏事" } }, ask: { slot: "sources", options: [{ label: "邮件" }] } }),
    );
    expect(r.prose).toBe("听下来你要的是别漏事。\n\n那你平时翻哪些东西？");
    expect(r.prose).not.toContain("---");
    expect(r.ask?.slot).toBe("sources");
  });

  it("完全没有结构区时整段当散文，ask 为 null（降级安全）", () => {
    const r = parsePmOutput("我就是随便说了两句，没给结构。");
    expect(r.prose).toBe("我就是随便说了两句，没给结构。");
    expect(r.ask).toBeNull();
    expect(r.done).toBe(false);
  });

  it("JSON 坏掉也不炸，散文照常显示", () => {
    const r = parsePmOutput(`问题在这里\n${SEPARATOR}\n{这不是 JSON`);
    expect(r.prose).toBe("问题在这里");
    expect(r.ask).toBeNull();
  });

  it("options 为空视为不合格 —— 每轮必须有选项", () => {
    const r = parsePmOutput(`问\n${SPEC({ ask: { slot: "goal", type: "single", options: [] } })}`);
    expect(r.ask).toBeNull();
  });

  it("槽位名不认识就丢掉 ask，不让模型自创字段", () => {
    const r = parsePmOutput(`问\n${SPEC({ ask: { slot: "不存在的槽", options: [{ label: "x" }] } })}`);
    expect(r.ask).toBeNull();
  });

  it("天生多选的槽位不看模型脸色 —— 它写 single 也按 multi 走", () => {
    // workflow 被压成单选时，用户只能选一条步骤，runFinalize 又用草稿覆盖回
    // AppSpec，工作手册就退化成一句话。这条由代码把关。
    for (const slot of ["sources", "actions", "deliverable", "workflow", "boundaries"]) {
      const r = parsePmOutput(
        `问\n${SPEC({ ask: { slot, type: "single", options: [{ label: "甲" }, { label: "乙" }] } })}`,
      );
      expect(r.ask?.type).toBe("multi");
    }
  });

  it("单选槽位不受影响", () => {
    const r = parsePmOutput(`问\n${SPEC({ ask: { slot: "goal", type: "single", options: [{ label: "甲" }] } })}`);
    expect(r.ask?.type).toBe("single");
  });

  it("裸字符串选项也接受，degrade 成只有 label", () => {
    const r = parsePmOutput(`问\n${SPEC({ ask: { slot: "goal", options: ["甲", "乙"] } })}`);
    expect(r.ask?.options).toEqual([{ label: "甲" }, { label: "乙" }]);
  });

  it("带 doc 的选项完整保留 —— 那是要写进 PRD 的句子", () => {
    const r = parsePmOutput(
      `问\n${SPEC({ ask: { slot: "goal", options: [{ label: "别漏事", description: "承诺不丢", doc: "不遗漏对客户的承诺", tag: "多数人选这个" }] } })}`,
    );
    expect(r.ask?.options[0]).toEqual({
      label: "别漏事",
      description: "承诺不丢",
      doc: "不遗漏对客户的承诺",
      tag: "多数人选这个",
    });
  });
});

describe("visiblePart —— 流式时绝不把结构区漏给界面", () => {
  it("看到标记就截断", () => {
    expect(visiblePart(`问题在这\n${SEPARATOR}\n{"a":1}`, false)).toBe("问题在这");
  });

  it("模型改用 --- 也截得住", () => {
    expect(visiblePart('问题在这\n---\n{"a":1}', false)).toBe("问题在这");
  });

  it("流式中途末尾留一截，半个标记不会漏出去", () => {
    const partial = "问题在这里啊啊啊啊啊啊啊啊啊<<<SP";
    expect(visiblePart(partial, false)).not.toContain("<<<");
  });

  it("final 时把剩下的散文全给出去", () => {
    expect(visiblePart("就这么多", true)).toBe("就这么多");
  });
});

describe("buildPmPrompt", () => {
  it("第一轮要求两拍，不要求回读", () => {
    const p = buildPmPrompt([{ role: "user", content: "帮我跟进客户" }], emptyDraft(), 0);
    expect(p).toContain("两拍");
    expect(p).not.toContain("三拍");
  });

  it("第二轮起要求三拍", () => {
    const p = buildPmPrompt([{ role: "user", content: "x" }], emptyDraft(), 1);
    expect(p).toContain("三拍");
  });

  it("只列还没聊到的槽位", () => {
    const { draft } = applyPatch(emptyDraft(), { goal: { value: "别漏事" } }, null);
    const p = buildPmPrompt([], draft, 2);
    const missingBlock = p.slice(p.indexOf("## 还没聊到的槽位"), p.indexOf("## 目前的草稿"));
    expect(missingBlock).toContain("- sources：");
    expect(missingBlock).not.toContain("- goal：");
  });

  it("把用词禁令写进提示词", () => {
    const p = buildPmPrompt([], emptyDraft(), 1);
    expect(p).toContain("不许出现");
    expect(p).toContain("preset");
  });
});

describe("fallbackAsk", () => {
  it("每个槽位都有保底选项，且至少 3 个", () => {
    for (const slot of SLOT_KEYS) {
      const ask = fallbackAsk(slot);
      expect(ask.options.length).toBeGreaterThanOrEqual(3);
      expect(ask.allowCustom).toBe(true);
    }
  });

  it("多选槽位给 multi", () => {
    expect(fallbackAsk("sources").type).toBe("multi");
    expect(fallbackAsk("goal").type).toBe("single");
  });
});

describe("draft", () => {
  it("applyPatch 忽略不认识的键", () => {
    const { draft, touched } = applyPatch(emptyDraft(), { goal: { value: "a" }, 乱写: { value: "b" } }, null);
    expect(Object.keys(draft.slots)).toEqual(["goal"]);
    expect(touched).toEqual(["goal"]);
  });

  it("空字符串不算填了", () => {
    const { draft } = applyPatch(emptyDraft(), { goal: { value: "   " } }, null);
    expect(draft.slots.goal).toBeUndefined();
  });

  it("why 被保留（判断沉淀）", () => {
    const { draft } = applyPatch(emptyDraft(), { goal: { value: "a", why: "他怕漏事" } }, null);
    expect(draft.slots.goal?.why).toBe("他怕漏事");
  });

  it("derive 只收白名单里的键", () => {
    const { draft } = applyPatch(emptyDraft(), null, { name: "客户跟进助手", 偷塞: "x" });
    expect(draft.derived).toEqual({ name: "客户跟进助手" });
  });

  it("missingSlots 一开始是全部 9 个", () => {
    expect(missingSlots(emptyDraft())).toHaveLength(9);
  });

  it("fillGuesses 补齐并标记 guessed", () => {
    const filled = fillGuesses(emptyDraft());
    expect(missingSlots(filled)).toHaveLength(0);
    expect(filled.slots.goal?.guessed).toBe(true);
  });

  it("fillGuesses 不覆盖用户已经选过的", () => {
    const { draft } = applyPatch(emptyDraft(), { goal: { value: "我自己说的" } }, null);
    const filled = fillGuesses(draft);
    expect(filled.slots.goal?.value).toBe("我自己说的");
    expect(filled.slots.goal?.guessed).toBeUndefined();
  });

  it("applyAnswered：用户的选择盖过模型的改写", () => {
    // 模型把用户勾的三条步骤揉成了一句
    const { draft: afterModel } = applyPatch(
      emptyDraft(),
      { workflow: { value: "提取行动项→推断负责人→生成清单", why: "他要一步到位" } },
      null,
    );
    const { draft } = applyAnswered(afterModel, {
      slot: "workflow",
      value: ["提取行动项", "推断负责人与截止时间", "生成待办清单"],
    });
    expect(draft.slots.workflow?.value).toEqual([
      "提取行动项",
      "推断负责人与截止时间",
      "生成待办清单",
    ]);
  });

  it("applyAnswered：模型归纳的 why 留着 —— 那是它的增量，不是对选择的改写", () => {
    const { draft: afterModel } = applyPatch(
      emptyDraft(),
      { goal: { value: "模型改写过的", why: "他怕漏事" } },
      null,
    );
    const { draft } = applyAnswered(afterModel, { slot: "goal", value: "用户原话" });
    expect(draft.slots.goal?.value).toBe("用户原话");
    expect(draft.slots.goal?.why).toBe("他怕漏事");
  });

  it("applyAnswered：模型忘了写 patch 时照样落地（原本的兜底不能丢）", () => {
    const { draft } = applyAnswered(emptyDraft(), { slot: "goal", value: "别漏事" });
    expect(draft.slots.goal?.value).toBe("别漏事");
  });

  it("applyAnswered：没有 answered 就原样返回", () => {
    const base = emptyDraft();
    const { draft, touched } = applyAnswered(base, null);
    expect(draft).toBe(base);
    expect(touched).toEqual([]);
  });

  it("原草稿不被就地改写", () => {
    const base = emptyDraft();
    applyPatch(base, { goal: { value: "a" } }, null);
    expect(base.slots.goal).toBeUndefined();
  });
});
