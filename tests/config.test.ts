import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let saved: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wanx-cfg-"));
  saved = process.env.WANXIANG_CONFIG;
  savedKey = process.env.DEEPSEEK_API_KEY;
  process.env.WANXIANG_CONFIG = join(dir, "config.json");
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.WANXIANG_KEY_ORIGIN;
});

afterEach(() => {
  if (saved === undefined) delete process.env.WANXIANG_CONFIG;
  else process.env.WANXIANG_CONFIG = saved;
  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = savedKey;
  delete process.env.WANXIANG_KEY_ORIGIN;
  rmSync(dir, { recursive: true, force: true });
});

import * as c from "../src/config";

describe("config", () => {
  it("没有文件时返回空配置，不抛", () => {
    expect(c.readConfig()).toEqual({});
    expect(c.resolveKey()).toBeUndefined();
    expect(c.keySource()).toBe("none");
  });

  it("写进去能读回来，权限是 0600", () => {
    c.writeConfig({ deepseekApiKey: "sk-abc", model: "deepseek-chat" });
    expect(c.readConfig().deepseekApiKey).toBe("sk-abc");
    expect(c.resolveKey()).toBe("sk-abc");
    expect(c.keySource()).toBe("config");
    expect(statSync(c.configPath()).mode & 0o777).toBe(0o600);
  });

  it("syncKeyEnv：key 来自配置文件时，env 被写上但事实源仍是配置", () => {
    // DSH 的 llm 适配器按 env 名解析凭据，所以必须写 env；
    // 但写完 keySource 不能从此谎报 "env"，否则用户换 key 看不懂为什么没生效。
    c.writeConfig({ deepseekApiKey: "sk-v1" });
    c.syncKeyEnv();
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-v1");
    expect(c.keySource()).toBe("config");
    // 轮换：界面里换了 key，env 里还留着旧值——新 key 必须赢
    c.writeConfig({ deepseekApiKey: "sk-v2" });
    expect(c.resolveKey()).toBe("sk-v2");
    c.syncKeyEnv();
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-v2");
  });

  it("syncKeyEnv：key 真从 shell 来的，env 继续说了算", () => {
    process.env.DEEPSEEK_API_KEY = "sk-shell";
    c.syncKeyEnv();
    c.writeConfig({ deepseekApiKey: "sk-config" });
    expect(c.resolveKey()).toBe("sk-shell");
    expect(c.keySource()).toBe("env");
  });

  it("环境变量优先于配置文件，且能说清来源", () => {
    c.writeConfig({ deepseekApiKey: "sk-from-file" });
    process.env.DEEPSEEK_API_KEY = "sk-from-env";
    expect(c.resolveKey()).toBe("sk-from-env");
    expect(c.keySource()).toBe("env");
  });

  it("写配置是合并不是覆盖", () => {
    c.writeConfig({ deepseekApiKey: "sk-abc" });
    c.writeConfig({ model: "deepseek-reasoner" });
    expect(c.readConfig()).toEqual({ deepseekApiKey: "sk-abc", model: "deepseek-reasoner" });
  });

  it("文件坏了当作空配置，不该让服务起不来", () => {
    c.writeConfig({ deepseekApiKey: "sk-abc" });
    writeFileSync(c.configPath(), "{ 这不是 JSON", "utf-8");
    expect(c.readConfig()).toEqual({});
  });

  it("空字符串不算配置过", () => {
    writeFileSync(c.configPath(), JSON.stringify({ deepseekApiKey: "   " }), "utf-8");
    expect(c.resolveKey()).toBeUndefined();
  });

  it("遮罩保留头尾，中间盖掉，且不等于原文", () => {
    const key = "sk-1234567890abcdefghij";
    const masked = c.maskKey(key);
    expect(masked).not.toBe(key);
    expect(masked.startsWith("sk-123")).toBe(true);
    expect(masked.endsWith("ghij")).toBe(true);
    expect(masked).toContain("•");
  });

  it("短 key 整条盖掉，不泄露任何一位", () => {
    expect(c.maskKey("sk-123")).toBe("••••••");
  });

  it("配置文件里不会留下多余字段", () => {
    c.writeConfig({ deepseekApiKey: "sk-abc" });
    expect(Object.keys(JSON.parse(readFileSync(c.configPath(), "utf-8")))).toEqual(["deepseekApiKey"]);
  });
});
