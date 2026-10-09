import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrustedMainFrame } from "../shell/ipc-auth.mjs";
test("固定 IPC 只接受本窗口主 frame，拒绝同 URL iframe 和其他网页", () => {
  const contents = {}, url = "file:///synthetic/app/dist/index.html";
  assert.equal(isTrustedMainFrame({ sender: contents, senderFrame: { url, parent: null } }, contents, url), true);
  assert.equal(isTrustedMainFrame({ sender: contents, senderFrame: { url, parent: {} } }, contents, url), false);
  assert.equal(isTrustedMainFrame({ sender: {}, senderFrame: { url, parent: null } }, contents, url), false);
  assert.equal(isTrustedMainFrame({ sender: contents, senderFrame: { url: "https://untrusted.invalid", parent: null } }, contents, url), false);
  assert.equal(isTrustedMainFrame({ sender: contents, senderFrame: null }, contents, url), false);
});
