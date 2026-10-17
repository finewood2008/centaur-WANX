import test from "node:test";
import assert from "node:assert/strict";
import { parseLink, callTool } from "../shell/space-links-mcp.mjs";
test("MCP disallows external and deceptive URLs; no credential-bearing redirects", () => {
  for (const value of ["https://evil.test", "http://localhost:123/space-links/"+"a".repeat(43),
    "http://127.0.0.1.evil.test:123/space-links/"+"a".repeat(43), "http://user@127.0.0.1:123/space-links/"+"a".repeat(43)]) assert.throws(() => parseLink(value));
});
test("MCP failed writes cancel only their own upload", async () => {
  const calls = [];
  await assert.rejects(callTool("space_write_text", { link: "test", target: "a", text: "small" }, async args => {
    calls.push(args); if (args.action === "write-chunk") throw new Error("disk full"); return {};
  }), /disk full/);
  assert.deepEqual(calls.map(c => c.action), ["begin-write", "write-chunk", "cancel-write"]);
  assert.equal(calls[0].upload_id, calls[2].upload_id);
});
