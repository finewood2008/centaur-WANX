import { describe, it, expect } from "vitest";
import { renderPrd, rationaleOf } from "../src/prd/render";
import { SECTIONS } from "../src/prd/sections";
import { applyPatch, emptyDraft, fillGuesses } from "../src/definer/draft";

function draft() {
  const { draft: d } = applyPatch(
    emptyDraft(),
    {
      goal: { value: "不漏掉对客户的承诺", why: "漏承诺比漏联系更伤信任" },
      sources: { value: ["客户档案", "往来邮件"] },
      workflow: { value: ["先翻最近的往来", "挑出没兑现的承诺"] },
      when: { value: "每次聊完自动跑" },
    },
    { name: "客户跟进助手", background: "承诺散在各处，靠人脑记。", acceptance: ["能指回真实往来"] },
  );
  return d;
}

const META = { name: "客户跟进助手", turns: 9, date: "2026-08-29" };

describe("renderPrd", () => {
  it("11 节都出现，按序号排", () => {
    const md = renderPrd(draft(), META);
    for (const s of SECTIONS) expect(md).toContain(`## ${s.n}. ${s.zh} ${s.en}`);
  });

  it("确定性：同一草稿永远同一输出", () => {
    expect(renderPrd(draft(), META)).toBe(renderPrd(draft(), META));
  });

  it("没聊到的章节留白而不是消失", () => {
    expect(renderPrd(draft(), META)).toContain("（没聊到，先空着）");
  });

  it("工作流程是有序列表，顺序有意义", () => {
    const md = renderPrd(draft(), META);
    expect(md).toContain("1. 先翻最近的往来");
    expect(md).toContain("2. 挑出没兑现的承诺");
  });

  it("归纳的章节标出来", () => {
    expect(renderPrd(draft(), META)).toContain("由产品经理归纳");
  });

  it("猜出来的章节标「按最佳猜测」", () => {
    expect(renderPrd(fillGuesses(draft()), META)).toContain("按最佳猜测");
  });

  it("判断沉淀作为附录出现，但不混进正文章节", () => {
    const md = renderPrd(draft(), META);
    expect(md).toContain("漏承诺比漏联系更伤信任");
    expect(md.indexOf("你当时是怎么想的")).toBeGreaterThan(md.indexOf("## 11."));
  });
});

describe("rationaleOf", () => {
  it("产品经理归纳的三节和 why 都落在这里，不进 spec", () => {
    const r = rationaleOf(draft());
    expect(r.background).toBe("承诺散在各处，靠人脑记。");
    expect(r.acceptance).toEqual(["能指回真实往来"]);
    expect((r.why as Record<string, string>).goal).toBe("漏承诺比漏联系更伤信任");
  });
});
