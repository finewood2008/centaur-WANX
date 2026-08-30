import { describe, it, expect } from "vitest";
import { buildUiBlueprint, heroKindLabel, heroKindOf } from "../src/compiler/ui";

const spec = (form: string, domain: any = "general", params: any[] = []) =>
  buildUiBlueprint({ domain, delivery: { form, trigger: "manual", output: "memory" }, params });

describe("heroKindOf —— delivery.form 关键词映射(确定性)", () => {
  it("清单/待办/任务/列表 → checklist", () => {
    for (const f of ["一份待办清单", "任务列表", "本周待办", "行动项清单"]) {
      expect(heroKindOf(f)).toBe("checklist");
    }
  });

  it("表格/名单/一览 → table", () => {
    for (const f of ["客户名单", "一张进度表格", "库存一览"]) {
      expect(heroKindOf(f)).toBe("table");
    }
  });

  it("简报/报告/周报… → digest;无命中兜底 digest", () => {
    for (const f of ["每日行业简报", "一份调研报告", "月度总结"]) {
      expect(heroKindOf(f)).toBe("digest");
    }
    expect(heroKindOf("一段随便什么的产出")).toBe("digest");
  });
});

describe("buildUiBlueprint", () => {
  it("domain 只影响措辞:customer_management 说「跟进」", () => {
    const bp = spec("客户跟进清单", "customer_management");
    expect(bp.hero.kind).toBe("checklist");
    expect(bp.hero.title).toContain("跟进");
    expect(bp.hero.empty).toContain("让它跑一次");
  });

  it("side:params 空则不出现,非空才有;顺序固定", () => {
    expect(spec("清单").side).toEqual(["actions", "materials", "schedule", "manual", "runs"]);
    expect(spec("清单", "general", [{ name: "n", type: "string" }]).side).toEqual([
      "actions",
      "materials",
      "params",
      "schedule",
      "manual",
      "runs",
    ]);
  });

  it("同一输入永远同一蓝图(纯函数)", () => {
    const a = spec("每日简报", "research");
    const b = spec("每日简报", "research");
    expect(a).toEqual(b);
  });

  it("形态名给人看", () => {
    expect(heroKindLabel("checklist")).toBe("清单工作台");
    expect(heroKindLabel("digest")).toBe("简报工作台");
  });
});
