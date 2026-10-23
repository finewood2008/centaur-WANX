import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { parseLink, callTool, serve } from "../shell/space-links-mcp.mjs";
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

test("Agent MCP advertises directory destinations and observed-version recycle recovery", async t => {
  const input = new PassThrough(), output = new PassThrough();
  const responses = createInterface({ input: output });
  const pending = new Map();
  responses.on("line", line => { const message = JSON.parse(line); pending.get(message.id)(message.result); });
  const calls = [];
  const server = serve({ input, output, enroll: async () => ({ status: "active" }), request: async args => {
    calls.push(args);
    return args.action === "stat" ? { id: "file", version: 7, trashed: 1 } : { ok: true };
  } });
  t.after(() => { server.close(); responses.close(); input.destroy(); output.destroy(); });
  let seq = 0;
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++seq; pending.set(id, resolve); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await rpc("initialize", { clientInfo: { name: "Codex" } });
  assert.match(init.instructions, /owner-approved Agent space/);
  const { tools } = await rpc("tools/list", {});
  const tool = tools.find(tool => tool.name === "space");
  assert.ok(!tool.inputSchema.properties.link);
  assert.match(tool.inputSchema.properties.parent.description, /mkdir.*alias/);
  assert.match(tool.inputSchema.properties.expected.description, /trash returns the updated version/);
  assert.match(tool.description, /stat.*recycled/);
  assert.ok(tools.find(t => t.name === 'clipboard_list'));
  assert.ok(tools.find(t => t.name === 'clipboard_read'));
  assert.ok(!tools.some(t => /^clipboard_(write|delete|pin|manage)$/.test(t.name)));
  assert.match(init.instructions, /read-only shared clipboard/);
  const stat = await rpc("tools/call", { name: "space", arguments: { action: "stat", target: "file" } });
  const entry = JSON.parse(stat.content[0].text);
  await rpc("tools/call", { name: "space", arguments: { action: "restore", target: entry.id, expected: entry.version } });
  assert.deepEqual(calls, [{ action: "stat", target: "file" }, { action: "restore", target: "file", expected: 7 }]);
  await rpc('tools/call', {name:'clipboard_list', arguments:{task_id:'own-task',policy_revision:1}});
  assert.deepEqual(calls.at(-1), {length:1048576,task_id:'own-task',policy_revision:1,action:'clipboard-list'});
  const refused = await rpc('tools/call', {name:'clipboard_delete', arguments:{target:'clip'}});
  assert.equal(refused.isError,true);
});

test('task tools advertise owner-selected synchronization and preserve file binding through text writes',async()=>{
 const calls=[];
 await callTool('space_write_text',{task_id:'task',policy_revision:3,progress:'save result',operation_id:'same-op',text:'x'},async args=>{calls.push(args);return {};});
 assert.equal(calls.length,3);
 for(const call of calls){assert.equal(call.task_id,'task');assert.equal(call.policy_revision,3);assert.equal(call.operation_id,'same-op');assert.equal(call.progress,'save result');}
});
