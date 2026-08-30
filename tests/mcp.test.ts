import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { addMcpServer, listMcpServers, removeMcpServer, validateMcpSpec } from "../src/mcp";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wanx-mcp-"));
  file = join(dir, "cordis.patch.yml");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("validateMcpSpec", () => {
  it("stdio 要命令，http 要合法地址", () => {
    expect(validateMcpSpec({ serverName: "github", transport: "stdio", command: "npx" })).toBeNull();
    expect(
      validateMcpSpec({ serverName: "web", transport: "streamable-http", url: "http://127.0.0.1:3000/mcp" }),
    ).toBeNull();
    expect(validateMcpSpec({ serverName: "x", transport: "stdio" })).toContain("命令");
    expect(validateMcpSpec({ serverName: "x", transport: "streamable-http", url: "ftp://x" })).toContain("http");
  });

  it("名称形状保守——它要进工具名 mcp__<server>__ 和行 id", () => {
    for (const bad of ["", "大写X", "UPPER", "a b", "-lead", "a".repeat(33), "../x"]) {
      expect(validateMcpSpec({ serverName: bad, transport: "stdio", command: "x" })).not.toBeNull();
    }
  });
});

describe("add / list / remove", () => {
  it("文件不存在时从空清单开始", async () => {
    expect(await listMcpServers(file)).toEqual([]);
  });

  it("加进去能列出来，写的是 dsh-mcp-client 的 insert 行", async () => {
    await addMcpServer(file, { serverName: "github", transport: "stdio", command: "npx", args: ["-y", "srv"] });
    const list = await listMcpServers(file);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ serverName: "github", transport: "stdio", command: "npx" });

    const raw = load(readFileSync(file, "utf-8")) as any[];
    const row = raw.flatMap((e) => e.insert ?? []).find((r: any) => r.id === "mcp-github");
    expect(row.name).toBe("@deepseek-ai/dsh-mcp-client");
    // 连不上时别拒绝整棵组合树
    expect(row.config.failOnStartupError).toBe(false);
  });

  it("重名拒绝", async () => {
    await addMcpServer(file, { serverName: "github", transport: "stdio", command: "npx" });
    await expect(
      addMcpServer(file, { serverName: "github", transport: "stdio", command: "other" }),
    ).rejects.toThrow(/已经有一个/);
  });

  it("删掉指定的，留下其它的", async () => {
    await addMcpServer(file, { serverName: "a", transport: "stdio", command: "x" });
    await addMcpServer(file, { serverName: "b", transport: "streamable-http", url: "http://h/mcp" });
    await removeMcpServer(file, "a");
    const list = await listMcpServers(file);
    expect(list.map((s) => s.serverName)).toEqual(["b"]);
  });

  it("删不存在的报错，且不写文件", async () => {
    await addMcpServer(file, { serverName: "a", transport: "stdio", command: "x" });
    const before = readFileSync(file, "utf-8");
    await expect(removeMcpServer(file, "nope")).rejects.toThrow(/没有叫/);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("用户手写的其它补丁条目原样保留", async () => {
    writeFileSync(file, "- id: hmr\n  disabled: true\n", "utf-8");
    await addMcpServer(file, { serverName: "a", transport: "stdio", command: "x" });
    await removeMcpServer(file, "a");
    const raw = load(readFileSync(file, "utf-8")) as any[];
    expect(raw).toEqual([{ id: "hmr", disabled: true }]);
  });

  it("解析不了的文件拒绝改动，说人话", async () => {
    writeFileSync(file, "- id: x\n  config: !!js process.env.FOO\n", "utf-8");
    await expect(addMcpServer(file, { serverName: "a", transport: "stdio", command: "x" })).rejects.toThrow(
      /读不懂/,
    );
  });
});
