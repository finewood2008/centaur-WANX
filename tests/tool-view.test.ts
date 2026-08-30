import { describe, it, expect } from "vitest";
import { genericLabel, labelFromView, makePresenter } from "../src/runtime/tool-view";

describe("labelFromView —— 结构化视图到中文白话", () => {
  it("read/edit 带上文件名", () => {
    expect(
      labelFromView({ card: "generic", kind: "read", title: "Read a", locations: [{ path: "/w/八月客户往来.md" }] }, "read"),
    ).toBe("正在读「八月客户往来.md」");
    expect(
      labelFromView({ card: "generic", kind: "edit", title: "Edit", locations: [{ path: "/w/清单.md" }] }, "edit"),
    ).toBe("正在修改「清单.md」");
  });

  it("diff 卡带上目标文件；terminal 卡不吐命令行", () => {
    expect(labelFromView({ card: "diff", title: "x", diffs: [{ path: "/w/产出.md" }] }, "write"))
      .toBe("正在写「产出.md」");
    expect(labelFromView({ card: "terminal", title: "rm -rf /" }, "bash")).toBe("正在执行操作");
  });

  it("search/fetch 有固定白话", () => {
    expect(labelFromView({ card: "generic", kind: "search", title: "Glob" }, "glob")).toBe("正在翻找资料");
    expect(labelFromView({ card: "generic", kind: "fetch", title: "Fetch" }, "web_fetch")).toBe("正在读取网页");
  });

  it("没有视图时回落到兜底表", () => {
    expect(labelFromView(undefined, "grep")).toBe("正在检索内容");
    expect(labelFromView(null, "todo_write")).toBe("正在梳理步骤");
  });
});

describe("genericLabel —— 第三层兜底绝不吐原始工具名", () => {
  it("MCP 工具用 server 名说话", () => {
    expect(genericLabel("mcp__notion__search_pages")).toBe("正在使用外部能力：notion");
    expect(genericLabel("mcp__my-crm__list")).toBe("正在使用外部能力：my-crm");
  });

  it("认不出的名字一律「正在处理」", () => {
    expect(genericLabel("weird_tool_x")).toBe("正在处理");
    expect(genericLabel("")).toBe("正在处理");
  });
});

describe("makePresenter —— presenter 是第三方代码，坏了不许拖垮流", () => {
  /** 假 ctx：tools.get 可注入任意行为。 */
  const ctxWith = (get: (name: string) => any) => ({ get: (svc: string) => (svc === "tools" ? { get } : undefined) });
  const agent = { ctx: {} };

  it("presentCall 抛异常 → 回落白话，不外抛", () => {
    const p = makePresenter(
      ctxWith(() => ({ presentCall: () => { throw new Error("坏 presenter"); } })),
      agent,
    );
    expect(p.call("read", "{}", "c1").label).toBe("正在读材料");
  });

  it("presentCall 返回视图 → 用结构化字段拼中文", () => {
    const p = makePresenter(
      ctxWith(() => ({
        presentCall: () => ({ card: "generic", kind: "read", title: "Read x", locations: [{ path: "/a/资料.md" }] }),
      })),
      agent,
    );
    expect(p.call("read", '{"path":"/a/资料.md"}', "c1").label).toBe("正在读「资料.md」");
  });

  it("没有 presenter 的 MCP 工具 → server 名白话；入参可展开", () => {
    const p = makePresenter(ctxWith(() => undefined), agent);
    const v = p.call("mcp__notion__search", '{"q":"周报"}', "c2");
    expect(v.label).toBe("正在使用外部能力：notion");
    expect(v.input).toContain("周报");
  });

  it("result：正文取模型面文本；error → ok:false 且失败可读", () => {
    const p = makePresenter(ctxWith(() => undefined), agent);
    const ok = p.result("c1", {
      message: { content: [{ toolCallId: "c1", content: [{ type: "text", text: "结果" }] }] },
    });
    expect(ok).toEqual({ ok: true, text: "结果" });
    const bad = p.result("c2", {
      message: { content: [{ toolCallId: "c2", content: [] }] },
      error: { name: "E", code: "DENIED" },
    });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("DENIED");
  });

  it("模型面 isError（文件不存在、沙箱拒绝这类真实失败）→ ok:false", () => {
    const p = makePresenter(ctxWith(() => undefined), agent);
    const r = p.result("c4", {
      message: {
        content: [{ toolCallId: "c4", isError: true, content: [{ type: "text", text: "没有这个文件" }] }],
      },
    });
    expect(r.ok).toBe(false);
    expect(r.text).toBe("没有这个文件");
  });

  it("超长结果被截断且有标记", () => {
    const p = makePresenter(ctxWith(() => undefined), agent);
    const long = "字".repeat(30_000);
    const r = p.result("c3", {
      message: { content: [{ toolCallId: "c3", content: [{ type: "text", text: long }] }] },
    });
    expect(r.text.length).toBeLessThan(21_000);
    expect(r.text).toContain("截断");
  });
});
