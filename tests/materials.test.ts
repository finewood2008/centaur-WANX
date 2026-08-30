import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteMaterial,
  listMaterials,
  readMaterial,
  safeName,
  saveMaterial,
  MAX_MATERIAL_BYTES,
} from "../src/materials";
import { workspaceDir } from "../src/runs";

let apps: string;
beforeEach(() => {
  apps = mkdtempSync(join(tmpdir(), "wanx-mat-"));
});
afterEach(() => {
  rmSync(apps, { recursive: true, force: true });
});

describe("safeName", () => {
  it("保留中文——用户会用中文起名", () => {
    expect(safeName("八月客户往来")).toBe("八月客户往来.md");
  });

  it("已有扩展名就不再加", () => {
    expect(safeName("记录.txt")).toBe("记录.txt");
    expect(safeName("表格.csv")).toBe("表格.csv");
  });

  it("挡住路径穿越", () => {
    expect(safeName("../../etc/passwd")).toBe("etc passwd.md");
    expect(safeName("a/b/c")).toBe("a b c.md");
  });

  it("挡住隐藏文件和 ..", () => {
    expect(safeName("..")).toBeNull();
    expect(safeName(".")).toBeNull();
    expect(safeName(".ssh")).toBe("ssh.md");
  });

  it("空名字和超长名字拒绝", () => {
    expect(safeName("")).toBeNull();
    expect(safeName("   ")).toBeNull();
    expect(safeName("啊".repeat(100))).toBeNull();
  });

  it("控制字符去掉", () => {
    expect(safeName("记录\u0000甲")).toBe("记录甲.md");
    expect(safeName("记录\n甲")).toBe("记录甲.md");
  });
});

describe("saveMaterial / readMaterial", () => {
  it("存进去能读回来", async () => {
    const m = await saveMaterial(apps, "app-x", "八月往来", "见了张总，答应下周给方案");
    expect(m?.name).toBe("八月往来.md");
    // 读用列表返回的真实名（前端就是这么做的），不是规范化前的名字
    expect(await readMaterial(apps, "app-x", m!.name)).toContain("张总");
  });

  it("落在 workspace 根下——那就是会话的 cwd，助手一睁眼就看得见", async () => {
    await saveMaterial(apps, "app-x", "记录", "x");
    expect(await readMaterial(apps, "app-x", "记录.md")).toBe("x");
    expect(workspaceDir(apps, "app-x")).toBe(join(apps, "app-x", "workspace"));
  });

  it("同名覆盖", async () => {
    await saveMaterial(apps, "app-x", "记录", "旧的");
    const m = await saveMaterial(apps, "app-x", "记录", "新的");
    expect(await readMaterial(apps, "app-x", m!.name)).toBe("新的");
  });

  it("名字非法就不写", async () => {
    expect(await saveMaterial(apps, "app-x", "..", "x")).toBeNull();
  });

  it("超过上限就不写", async () => {
    expect(await saveMaterial(apps, "app-x", "大", "a".repeat(MAX_MATERIAL_BYTES + 1))).toBeNull();
  });

  it("读不存在的返回 null 而不是抛", async () => {
    expect(await readMaterial(apps, "app-x", "没有这个")).toBeNull();
  });

  it("读删按磁盘真实名精确匹配，不再过 safeName（否则删错文件）", async () => {
    // 助手写的 / 手动放的文件可能带两个空格——safeName 会把它合并成另一个名字
    const ws = workspaceDir(apps, "app-x");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "a  b.md"), "两个空格", "utf-8"); // 磁盘真实名
    // listMaterials 原样返回它
    expect((await listMaterials(apps, "app-x")).map((m) => m.name)).toContain("a  b.md");
    // 按列表给的名字精确读得到
    expect(await readMaterial(apps, "app-x", "a  b.md")).toBe("两个空格");
    // safeName("a  b.md")="a b.md"，用旧逻辑会读错——现在读不到
    expect(await readMaterial(apps, "app-x", "a b.md")).toBeNull();
  });

  it("删不存在的如实报 false，不静默成功", async () => {
    expect(await deleteMaterial(apps, "app-x", "根本没有.md")).toBe(false);
  });

  it("读删挡穿越与隐藏文件", async () => {
    for (const bad of ["../x", "a/b", ".hidden", "..", ".dsh"]) {
      expect(await readMaterial(apps, "app-x", bad)).toBeNull();
      expect(await deleteMaterial(apps, "app-x", bad)).toBe(false);
    }
  });

  it("拒绝存 DSH 会当指令的保留名——资料是数据不是指令", async () => {
    for (const name of ["AGENTS.md", "CLAUDE.md", "claude", "SKILL.md"]) {
      expect(await saveMaterial(apps, "app-x", name, "x")).toBeNull();
    }
  });
});

describe("listMaterials", () => {
  it("没有 workspace 时返回空数组", async () => {
    expect(await listMaterials(apps, "app-x")).toEqual([]);
  });

  it("列出资料，按名字排", async () => {
    await saveMaterial(apps, "app-x", "乙", "2");
    await saveMaterial(apps, "app-x", "甲", "1");
    expect((await listMaterials(apps, "app-x")).map((m) => m.name)).toEqual(["甲.md", "乙.md"]);
  });

  it("隐藏目录不算资料——.dsh 装的是工作手册，不是用户给的东西", async () => {
    await saveMaterial(apps, "app-x", "记录", "x");
    const ws = workspaceDir(apps, "app-x");
    mkdirSync(join(ws, ".dsh", "skills", "s"), { recursive: true });
    writeFileSync(join(ws, ".dsh", "skills", "s", "SKILL.md"), "手册", "utf-8");
    expect((await listMaterials(apps, "app-x")).map((m) => m.name)).toEqual(["记录.md"]);
  });

  it("带上大小和修改时间", async () => {
    await saveMaterial(apps, "app-x", "记录", "12345");
    const [m] = await listMaterials(apps, "app-x");
    expect(m.bytes).toBe(5);
    expect(Number.isNaN(Date.parse(m.updatedAt))).toBe(false);
  });
});

describe("deleteMaterial", () => {
  it("删掉之后列表里就没了（用列表返回的真实名删）", async () => {
    const saved = await saveMaterial(apps, "app-x", "记录", "x");
    expect(await deleteMaterial(apps, "app-x", saved!.name)).toBe(true);
    expect(await listMaterials(apps, "app-x")).toEqual([]);
  });

  it("非法名字直接拒绝，不去碰文件系统", async () => {
    expect(await deleteMaterial(apps, "app-x", "..")).toBe(false);
  });
});
