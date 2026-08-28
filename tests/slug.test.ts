import { describe, it, expect } from "vitest";
import { slugFromName } from "../src/appspec/slug";

describe("slugFromName", () => {
  it("确定性：同一名字同一 slug", () => {
    expect(slugFromName("客户跟进助手")).toBe(slugFromName("客户跟进助手"));
  });

  it("符合 DSH PRESET_ID 约束 /^[a-z0-9][a-z0-9-]*$/", () => {
    expect(slugFromName("客户跟进助手")).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("不同名字不同 slug", () => {
    expect(slugFromName("客户跟进助手")).not.toBe(slugFromName("行业研究简报助手"));
  });
});
