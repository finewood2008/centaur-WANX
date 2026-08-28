import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli";

describe("parseArgs", () => {
  it("解析意图", () => {
    const { intent } = parseArgs(["帮我跟进客户"]);
    expect(intent).toBe("帮我跟进客户");
  });

  it("解析 --out", () => {
    const { options } = parseArgs(["x", "--out", "/tmp/apps"]);
    expect(options.out).toBe("/tmp/apps");
  });

  it("解析 --no-memory", () => {
    const { options } = parseArgs(["x", "--no-memory"]);
    expect(options.noMemory).toBe(true);
  });

  it("解析 --model 与 --max-repairs", () => {
    const { options } = parseArgs(["x", "--model", "deepseek-v4-pro", "--max-repairs", "5"]);
    expect(options.model).toBe("deepseek-v4-pro");
    expect(options.maxRepairs).toBe(5);
  });

  it("--help 返回空意图", () => {
    const { intent } = parseArgs(["--help"]);
    expect(intent).toBe("");
  });

  it("默认选项", () => {
    const { options } = parseArgs(["x"]);
    expect(options.out).toBe("./wanxiang-apps");
    expect(options.noMemory).toBe(false);
    expect(options.maxRepairs).toBe(3);
  });
});
