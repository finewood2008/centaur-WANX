import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildParamsSection,
  readParamValues,
  validateParamValues,
  writeParamValues,
  type AppParam,
} from "../src/params-store";

const SCHEMA: AppParam[] = [
  { name: "tone", type: "enum", label: "语气", options: ["正式", "轻松"], required: false },
  { name: "count", type: "number", label: "条数", default: 5, required: false },
  { name: "brief", type: "boolean", label: "只要摘要", required: false },
  { name: "since", type: "date", label: "起始日", required: true },
  { name: "watch", type: "list", label: "重点关注", required: false },
  { name: "title", type: "string", label: "标题", required: false },
];

describe("validateParamValues", () => {
  it("六种类型各自的合法值", () => {
    const r = validateParamValues(SCHEMA, {
      tone: "正式",
      count: "7",
      brief: true,
      since: "2026-09-01",
      watch: "客户A\n客户B\n",
      title: " 周报 ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.values).toEqual({
        tone: "正式",
        count: 7,
        brief: true,
        since: "2026-09-01",
        watch: ["客户A", "客户B"],
        title: "周报",
      });
    }
  });

  it("enum 越界拒,错误里带标签", () => {
    const r = validateParamValues(SCHEMA, { tone: "阴阳怪气" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("语气");
  });

  it("number 不是数、date 格式错、boolean 非布尔 → 拒", () => {
    expect(validateParamValues(SCHEMA, { count: "很多" }).ok).toBe(false);
    expect(validateParamValues(SCHEMA, { since: "明天" }).ok).toBe(false);
    expect(validateParamValues(SCHEMA, { brief: "yes" }).ok).toBe(false);
  });

  it("未知参数名丢弃;空字符串=清掉这项", () => {
    const r = validateParamValues(SCHEMA, { hacker: "x", title: "" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values).toEqual({});
  });
});

describe("读写 round-trip", () => {
  it("写进 <slug>/params.yml 再读回来", async () => {
    const appsDir = mkdtempSync(join(tmpdir(), "wanx-params-"));
    await writeParamValues(appsDir, "app-x", { count: 7, watch: ["A"] });
    expect(await readParamValues(appsDir, "app-x")).toEqual({ count: 7, watch: ["A"] });
  });

  it("没有文件时返回空对象", async () => {
    const appsDir = mkdtempSync(join(tmpdir(), "wanx-params-"));
    expect(await readParamValues(appsDir, "app-none")).toEqual({});
  });
});

describe("buildParamsSection —— 任务里的「本次参数」段", () => {
  it("开头声明生效值盖过手册默认值", () => {
    const lines = buildParamsSection(SCHEMA, { tone: "轻松" });
    expect(lines.join("\n")).toContain("以这里的为准");
    expect(lines.join("\n")).toContain("语气：轻松");
  });

  it("没设置的用 default,没 default 的标「未设置」,required 的带提醒", () => {
    const text = buildParamsSection(SCHEMA, {}).join("\n");
    expect(text).toContain("条数：5");
    expect(text).toContain("标题：未设置");
    expect(text).toContain("起始日：（必填，还没设置");
  });

  it("list 与 boolean 的白话渲染", () => {
    const text = buildParamsSection(SCHEMA, { watch: ["A", "B"], brief: false }).join("\n");
    expect(text).toContain("重点关注：A、B");
    expect(text).toContain("只要摘要：关");
  });

  it("无参数声明时整段消失", () => {
    expect(buildParamsSection([], { any: 1 })).toEqual([]);
  });
});
