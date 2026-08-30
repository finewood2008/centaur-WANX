import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRevision,
  headRevision,
  listRevisions,
  reconcile,
  revisionsDir,
  sliceOf,
  slicesEqual,
  type RevisionEntry,
} from "../src/revisions";

let appsDir: string;
const slug = "app-test";

const entry = (version: number, steps: string[]): RevisionEntry => ({
  version,
  at: "2026-08-30T00:00:00.000Z",
  kind: "revise",
  note: `第 ${version} 版`,
  steps,
  boundaries: [],
});

beforeEach(() => {
  appsDir = mkdtempSync(join(tmpdir(), "wanx-rev-"));
});

describe("账本 IO", () => {
  it("append → list round-trip,旧→新有序", async () => {
    await appendRevision(appsDir, slug, entry(1, ["一"]));
    await appendRevision(appsDir, slug, entry(2, ["一", "二"]));
    const all = await listRevisions(appsDir, slug);
    expect(all.map((r) => r.version)).toEqual([1, 2]);
    expect(all[1].steps).toEqual(["一", "二"]);
  });

  it("文件名四位零填充,字典序即版本序(两位数不乱序)", async () => {
    for (const v of [1, 2, 10]) await appendRevision(appsDir, slug, entry(v, ["x"]));
    const all = await listRevisions(appsDir, slug);
    expect(all.map((r) => r.version)).toEqual([1, 2, 10]);
  });

  it("坏文件跳过,不挡整个账本", async () => {
    await appendRevision(appsDir, slug, entry(1, ["一"]));
    writeFileSync(join(revisionsDir(appsDir, slug), "0002.yml"), "{{{ 不是 yaml");
    writeFileSync(join(revisionsDir(appsDir, slug), "0003.yml"), "just: a string, no version\n");
    await appendRevision(appsDir, slug, entry(4, ["四"]));
    const all = await listRevisions(appsDir, slug);
    expect(all.map((r) => r.version)).toEqual([1, 4]);
  });

  it("空账本 head 为 null", async () => {
    expect(await headRevision(appsDir, slug)).toBeNull();
  });
});

describe("reconcile —— app.yml 是权威,账本追认现实", () => {
  const spec = { workflow: { steps: ["一", "二"] }, boundaries: ["别越界"] };

  it("无账本 → 合成 v0,不落盘", async () => {
    const { entry: e, synthetic } = await reconcile(appsDir, slug, sliceOf(spec));
    expect(synthetic).toBe(true);
    expect(e.version).toBe(0);
    expect(e.steps).toEqual(["一", "二"]);
    expect(existsSync(revisionsDir(appsDir, slug))).toBe(false);
  });

  it("一致 → 原样返回末条,不追加", async () => {
    await appendRevision(appsDir, slug, { ...entry(1, ["一", "二"]), boundaries: ["别越界"] });
    const { entry: e, synthetic } = await reconcile(appsDir, slug, sliceOf(spec));
    expect(synthetic).toBe(false);
    expect(e.version).toBe(1);
    expect((await listRevisions(appsDir, slug)).length).toBe(1);
  });

  it("不一致(写一半崩了/用户手改)→ 补记一条 external", async () => {
    await appendRevision(appsDir, slug, entry(1, ["旧的样子"]));
    const { entry: e } = await reconcile(appsDir, slug, sliceOf(spec));
    expect(e.kind).toBe("external");
    expect(e.version).toBe(2);
    expect(e.steps).toEqual(["一", "二"]);
    expect((await listRevisions(appsDir, slug)).length).toBe(2);
  });

  it("调教闸占用时(allowWrite:false)只读不写", async () => {
    await appendRevision(appsDir, slug, entry(1, ["旧的样子"]));
    await reconcile(appsDir, slug, sliceOf(spec), { allowWrite: false });
    expect((await listRevisions(appsDir, slug)).length).toBe(1);
  });
});

describe("slicesEqual", () => {
  it("逐条逐字比较", () => {
    expect(slicesEqual({ steps: ["a"], boundaries: [] }, { steps: ["a"], boundaries: [] })).toBe(true);
    expect(slicesEqual({ steps: ["a"], boundaries: [] }, { steps: ["a "], boundaries: [] })).toBe(false);
    expect(slicesEqual({ steps: ["a"], boundaries: ["x"] }, { steps: ["a"], boundaries: [] })).toBe(false);
  });
});
