import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../local-ui/renderer/personal-space.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const connected = box => ({ route: "applications", canLaunchApplications: true, account: { accountId: "owner" }, activeDeviceId: box, devices: [{ deviceId: box, name: box }] });
function harness(action, uploadDroppedFiles, tilePositions = [], dom = {}, surface = {}) {
  const events = new Map(), documentEvents = new Map(); let onState;
  const root = { focus() {}, addEventListener: (type, handler) => events.set(type, handler), ...surface };
  const window = { wanxClient: { action, uploadDroppedFiles, onSpaceState: handler => { onState = handler; } } };
  vm.runInNewContext(source, { window, document: { querySelector: selector => dom.nodes?.get(selector) || root, querySelectorAll: selector => selector === ".space-file-row" ? tilePositions.map(offsetTop => ({ offsetTop })) : [], addEventListener: (type, handler) => documentEvents.set(type, handler) , ...dom }, setInterval() {}, setTimeout, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, queueMicrotask, URL, Blob, atob, TextDecoder });
  const space = window.wanxSpace;
  space.bind({ render() {} });
  return { space, emit: value => onState(value), event: (type, value) => events.get(type)(value), keydown: event => documentEvents.get("keydown")(event), pointer: (type, event) => documentEvents.get(type)(event),
    click: (kind, id = "", extra = {}, modifiers = {}) => events.get("click")({ ...modifiers, target: { closest: () => ({ dataset: { action: `space-${kind}`, id, ...extra } }) } }) };
}
const listed = name => ({ items: [{ id: "a".repeat(32), name, kind: "file", size: 10, modified: 0 }], breadcrumbs: [] });
const ok = value => ({ ok: true, value });

test("an early box event clears private content and late results cannot refill the new account", async () => {
  let resolveList, block = false;
  const h = harness(async (action) => {
    if (action === "space.refresh") return ok({ phase: "ready", tasks: [] });
    if (block) return new Promise(resolve => { resolveList = resolve; });
    return ok(listed("owner-secret.txt"));
  });
  h.space.hostState(connected("box-a")); h.space.activate(true); await tick();
  assert.match(h.space.view(), /owner-secret/);
  block = true; const loading = h.click("refresh"); await tick();
  h.emit({ accountId: "new-owner", boxId: "box-b", phase: "idle", tasks: [] });
  assert.doesNotMatch(h.space.view(), /owner-secret/);
  h.space.hostState({ ...connected("box-b"), account: { accountId: "new-owner" }, canLaunchApplications: false });
  resolveList(ok(listed("late-secret.txt"))); await loading;
  assert.doesNotMatch(h.space.view(), /secret/);
});

test("rapid folder navigation ignores the late listing from a previous folder", async () => {
  let resolveFolder;
  const h = harness(async (action, input) => action === "space.refresh" ? ok({ phase: "ready", tasks: [] }) : input.parent ? new Promise(resolve => { resolveFolder = resolve; }) : ok(listed("root-file.txt")));
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  const first = h.click("folder", "a".repeat(32)); await tick();
  await h.click("folder", "");
  resolveFolder(ok(listed("wrong-folder.txt"))); await first;
  assert.match(h.space.view(), /root-file/);
  assert.doesNotMatch(h.space.view(), /wrong-folder/);
});

test("unsupported boxes show the upgrade boundary without file mutation controls", async () => {
  const h = harness(async () => ({ ok: false, code: "SPACE_UPGRADE_REQUIRED" }));
  h.space.hostState(connected("old-box"));
  h.space.activate(true); await tick();
  h.emit({ accountId: "owner", boxId: "old-box", phase: "unsupported", tasks: [] });
  assert.match(h.space.view(), /文件空间需要新版盒端服务/);
  assert.doesNotMatch(h.space.view(), /data-action="space-upload"/);
});

test("local file drops upload into the displayed folder and never upload from trash or another tab", async () => {
  const uploaded = [], file = { name: 'local.bin' };
  const h = harness(async action => ok(action === 'space.refresh' ? { phase: 'ready', tasks: [] } : listed('a.txt')), async (files, input) => { uploaded.push({ files, input }); return ok(); });
  h.space.hostState(connected('box')); h.space.activate(true); await tick();
  const folder = 'b'.repeat(32);
  await h.click('folder', folder);
  let prevented = 0;
  const event = { preventDefault() { prevented++; }, dataTransfer: { types: ['Files'], files: [file] } };
  h.event('dragover', event);
  assert.equal(event.dataTransfer.dropEffect, 'copy');
  await h.event('drop', event);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].files[0], file);
  assert.equal(uploaded[0].input.parent, folder);
  await h.click('recycle');
  h.event('dragover', event);
  assert.equal(event.dataTransfer.dropEffect, 'none');
  await h.event('drop', event);
  await h.click('folder', folder);
  h.space.activate(true, false);
  await h.event('drop', event);
  h.space.activate(false);
  await h.event('drop', event);
  assert.equal(uploaded.length, 1);
  assert.ok(prevented > 0);
});

test("transfer bars show partial progress, verified completion and paused actions", async () => {
  const h = harness(async action => ok(action === 'space.refresh' ? { phase: 'ready', tasks: [] } : listed('a.txt')));
  h.space.hostState(connected('box')); h.space.activate(true); await tick();
  const task = { id: 'a'.repeat(32), name: 'upload.bin', direction: 'upload', phase: 'running', offset: 4, size: 8 };
  h.emit({ accountId: 'owner', boxId: 'box', phase: 'ready', tasks: [task] });
  assert.match(h.space.view(), /<progress class="space-progress" max="100" value="50"/);
  assert.match(h.space.view(), /50%/);
  h.emit({ accountId: 'owner', boxId: 'box', phase: 'ready', tasks: [{ ...task, phase: 'paused' }] });
  assert.match(h.space.view(), /data-command="resume"/);
  h.emit({ accountId: 'owner', boxId: 'box', phase: 'ready', tasks: [{ ...task, phase: 'complete', size: 0, offset: 0 }] });
  assert.match(h.space.view(), /<progress class="space-progress" max="100" value="100"/);
  assert.match(h.space.view(), /已完成/);
});

const entry = (id, name, kind = "file", size = 10, modified = 0) => ({ id: id.repeat(32), parent: "", name, kind, size, modified });
function fileTarget(item) {
  const row = item ? { dataset: { entryId: item.id } } : null;
  return { closest: selector => selector === ".space-file-list" ? {} : (selector === "[data-entry-id]" || selector.startsWith("[data-entry-id],")) ? row : null };
}
test("disk browser displays selectable icons, selects without preview, and opens folders on double click", async () => {
  const folder = entry("b", "资料", "folder"), file = entry("a", "readme.txt");
  const calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: input.parent ? [file] : [file, folder], breadcrumbs: input.parent ? [{ id: folder.id, name: folder.name }] : [] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  assert.doesNotMatch(h.space.view(), /page-heading|space-drop-hint|>操作</);
  assert.match(h.space.view(), /搜索当前文件夹/);
  assert.match(h.space.view(), /role="listbox" aria-multiselectable="true" aria-label="当前文件夹图标"/);
  assert.match(h.space.view(), /role="option"/);
  assert.doesNotMatch(h.space.view(), /role="table"|columnheader|space-file-columns/);
  assert.match(h.space.view(), /space-item-icon is-folder/);
  assert.match(h.space.view(), /space-item-icon is-document/);
  await h.click("select", file.id);
  assert.match(h.space.view(), /aria-selected="true"[^>]*data-entry-id="aaaaaaaa/);
  assert.equal(calls.some(([action]) => action === "space.preview"), false);
  await h.event("dblclick", { target: fileTarget(folder) });
  assert.equal(calls.at(-1)[1].parent, folder.id);
  assert.match(h.space.view(), /返回上级文件夹/);
  await h.click("folder", "");
  assert.equal(calls.at(-1)[1].parent, "");
});
test("file and blank-space right clicks offer scoped actions and deletion retains its confirmation", async () => {
  const file = entry("a", 'report.txt'); const calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: [file], breadcrumbs: [] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  let prevented = 0;
  h.event("contextmenu", { target: fileTarget(file), clientX: 10000, clientY: 10000, preventDefault() { prevented++; } });
  assert.match(h.space.view(), /role="menu" aria-label="文件操作"/);
  assert.match(h.space.view(), /下载到电脑…/); assert.match(h.space.view(), /重命名…/); assert.match(h.space.view(), /移动到…/);
  assert.doesNotMatch(h.space.view(), /left:10000px|top:10000px/);
  await h.click("download", file.id); assert.equal(calls.at(-1)[0], "space.download");
  await h.click("trash", file.id);
  assert.match(h.space.view(), /role="dialog"/);
  assert.equal(calls.some(([action]) => action === "space.trash"), false);
  await h.click("dialog-confirm");
  assert.equal(calls.some(([action, input]) => action === "space.trash" && input.id === file.id), true);
  h.event("contextmenu", { target: fileTarget(null), clientX: 50, clientY: 100, preventDefault() { prevented++; } });
  assert.match(h.space.view(), /role="menu" aria-label="文件夹操作"/);
  assert.match(h.space.view(), />上传文件…</); assert.match(h.space.view(), />新建文件夹…</);
  assert.equal(prevented, 2);
});
test("trash right clicks expose recovery and purge without file upload actions, and switching boxes clears menus", async () => {
  const file = entry("a", "deleted.txt");
  const h = harness(async action => ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: [file], breadcrumbs: [] }));
  h.space.hostState(connected("box")); h.space.activate(true); await tick(); await h.click("recycle");
  h.event("contextmenu", { target: fileTarget(file), clientX: 60, clientY: 100, preventDefault() {} });
  const menu = h.space.view().match(/<div class="space-context-menu"[\s\S]*?<\/div>/)[0];
  assert.match(menu, />恢复</); assert.match(menu, />彻底删除…</);
  assert.doesNotMatch(menu, /space-download|space-upload|space-rename/);
  h.space.hostState(connected("other-box"));
  assert.doesNotMatch(h.space.view(), /space-context-menu|deleted.txt/);
});
test("current-folder filtering and sorting keep folders first and escape file metadata", async () => {
  const files = [entry("a", "z.txt", "file", 20), entry("b", "资料", "folder"), entry("c", "a.txt", "file", 5), entry("d", 'unsafe."<img>')];
  const h = harness(async action => ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: files, breadcrumbs: [] }));
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  let html = h.space.view(); assert.ok(html.indexOf('data-entry-id="bbbb') < html.indexOf('data-entry-id="aaaa'));
  assert.doesNotMatch(html, /<img>/); assert.match(html, /&lt;img&gt;/);
  h.event("change", { target: { id: "space-sort", value: "size" } });
  html = h.space.view(); assert.ok(html.indexOf('data-entry-id="cccc') < html.indexOf('data-entry-id="aaaa'));
  await h.click("sort", "", { sort: "size" });
  html = h.space.view(); assert.ok(html.indexOf('data-entry-id="aaaa') < html.indexOf('data-entry-id="cccc'));
  h.event("input", { target: { id: "space-search", value: "z.txt" } });
  html = h.space.view(); assert.match(html, /z.txt/); assert.doesNotMatch(html, /data-entry-id="cccc/);
  assert.match(html, /1 \/ 4 个项目/);
  h.event("input", { target: { id: "space-search", value: "missing" } });
  assert.match(h.space.view(), /没有找到匹配文件/);
});

test("arrow keys move horizontally and by the rendered number of icon columns", async () => {
  const files = ["a", "b", "c", "d", "e", "f"].map(id => entry(id, `${id}.txt`));
  const h = harness(async action => ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: files, breadcrumbs: [] }), undefined, [0, 0, 0, 154, 154, 154]);
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("select", files[0].id);
  const press = async (key, expected) => {
    await h.keydown({ key, target: fileTarget(null), preventDefault() {} });
    assert.match(h.space.view(), new RegExp(`aria-selected="true"[^>]*data-entry-id="${expected.id}"`));
  };
  await press("ArrowRight", files[1]);
  await press("ArrowDown", files[4]);
  await press("ArrowLeft", files[3]);
  await press("ArrowUp", files[0]);
  await press("ArrowLeft", files[0]);
});

const selected = html => [...html.matchAll(/aria-selected="true"[^>]*data-entry-id="([a-f0-9]+)"/g)].map(match => match[1]);
test("modifier clicks, shift ranges and select-all retain a group on right click", async () => {
  const files = ["a", "b", "c", "d"].map(id => entry(id, `${id}.txt`));
  const calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: files, breadcrumbs: [] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("select", files[0].id);
  await h.click("select", files[2].id, {}, { metaKey: true });
  assert.deepEqual(selected(h.space.view()), [files[0].id, files[2].id]);
  h.event("contextmenu", { target: fileTarget(files[0]), clientX: 100, clientY: 200, preventDefault() {} });
  assert.deepEqual(selected(h.space.view()), [files[0].id, files[2].id]);
  assert.match(h.space.view(), /下载所选 2 项/);
  await h.click("batch-download");
  assert.equal(calls.at(-1)[0], "space.downloads");
  assert.deepEqual(Array.from(calls.at(-1)[1].ids), [files[0].id, files[2].id]);
  await h.click("select", files[2].id, {}, { ctrlKey: true });
  assert.deepEqual(selected(h.space.view()), [files[0].id]);
  await h.click("select", files[0].id);
  await h.click("select", files[2].id, {}, { shiftKey: true });
  assert.deepEqual(selected(h.space.view()), files.slice(0, 3).map(file => file.id));
  await h.keydown({ key: "a", ctrlKey: true, target: fileTarget(null), preventDefault() {} });
  assert.deepEqual(selected(h.space.view()), files.map(file => file.id));
  h.space.hostState(connected("other-box"));
  assert.equal(selected(h.space.view()).length, 0);
});

test("batch deletion confirms once, retains failed entries and stops if the box changes", async () => {
  let files = [entry("a", "a.txt"), entry("b", "b.txt")], fail = true;
  const calls = [];
  const h = harness(async (action, input) => {
    calls.push([action, input]);
    if (action === "space.refresh") return ok({ phase: "ready", tasks: [] });
    if (action === "space.trash") {
      if (input.id === "b".repeat(32) && fail) return { ok: false, code: "SPACE_STORAGE_UNAVAILABLE" };
      files = files.filter(file => file.id !== input.id); return ok();
    }
    return ok({ items: files, breadcrumbs: [] });
  });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("select", files[0].id); await h.click("select", files[1].id, {}, { ctrlKey: true });
  await h.click("batch-trash");
  assert.match(h.space.view(), /删除所选 2 个项目/);
  assert.equal(calls.filter(([action]) => action === "space.trash").length, 0);
  await h.click("dialog-confirm");
  assert.match(h.space.view(), /已完成 1 项，1 项未完成/);
  assert.deepEqual(selected(h.space.view()), ["b".repeat(32)]);
  fail = false; await h.click("dialog-confirm");
  assert.equal(files.length, 0); assert.doesNotMatch(h.space.view(), /role="dialog"/);

  const requests = []; let late;
  const scoped = harness(async (action, input) => {
    requests.push([action, input]);
    if (action === "space.trash") return new Promise(resolve => { late = resolve; });
    return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: [entry("a", "a"), entry("b", "b")], breadcrumbs: [] });
  });
  scoped.space.hostState(connected("box")); scoped.space.activate(true); await tick();
  await scoped.click("select", "a".repeat(32)); await scoped.click("select", "b".repeat(32), {}, { ctrlKey: true });
  await scoped.click("batch-trash"); const deleting = scoped.click("dialog-confirm"); await tick();
  scoped.space.hostState(connected("new-box")); late(ok()); await deleting;
  assert.equal(requests.filter(([action]) => action === "space.trash").length, 1);
});

test("batch moving excludes selected folders and preserves every selected name", async () => {
  const files = [entry("a", "资料", "folder"), entry("b", "b.txt"), entry("c", "目标", "folder")], calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: files, breadcrumbs: [] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("select", files[0].id); await h.click("select", files[1].id, {}, { ctrlKey: true });
  await h.click("batch-move");
  const picker = h.space.view().match(/<div class="space-folder-picker">[\s\S]*?<\/div>/)[0];
  assert.doesNotMatch(picker, /data-id="aaaaaaaa/); assert.match(picker, /data-id="cccccccc/);
  await h.click("move-folder", files[2].id); await h.click("dialog-confirm");
  const moves = calls.filter(([action]) => action === "space.move");
  assert.deepEqual(moves.map(([, input]) => [input.id, input.name, input.parent]), files.slice(0, 2).map(file => [file.id, file.name, files[2].id]));
});

test("blank-area marquee selects intersecting icons and supports additive and canceled drags", async () => {
  const files = [entry("a", "a"), entry("b", "b"), entry("c", "c")];
  const tiles = files.map((file, index) => ({ dataset: { entryId: file.id }, classList: { toggle() {} }, setAttribute() {}, getBoundingClientRect: () => ({ left: 20 + index * 130, top: 20, width: 116, height: 154 }) }));
  const overlay = { style: {}, setAttribute() {}, remove() {} };
  const list = { scrollTop: 0, scrollLeft: 0, focus() {}, append() {}, setPointerCapture() {}, hasPointerCapture: () => false, querySelectorAll: () => tiles, getBoundingClientRect: () => ({ left: 0, top: 0, right: 500, bottom: 400 }) };
  const h = harness(async action => ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: files, breadcrumbs: [] }), undefined, [], { createElement: () => overlay });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  const target = { closest: selector => selector === ".space-file-list" ? list : null };
  const drag = (x, to, modifiers = {}) => {
    return [{ button: 0, pointerId: 1, clientX: x, clientY: 10, target, preventDefault() {}, ...modifiers }, { pointerId: 1, clientX: to, clientY: 190 }];
  };
  let [down, move] = drag(5, 270);
  h.pointer("pointerdown", down); assert.equal(h.space.isSelecting(), true);
  h.pointer("pointermove", move); assert.deepEqual(selected(h.space.view()), files.slice(0, 2).map(file => file.id));
  h.pointer("pointerup", { pointerId: 1 }); assert.equal(h.space.isSelecting(), false);
  [down, move] = drag(278, 410, { shiftKey: true });
  h.pointer("pointerdown", down); h.pointer("pointermove", move);
  assert.equal(selected(h.space.view()).length, 3);
  h.pointer("pointercancel", {});
  assert.deepEqual(selected(h.space.view()), files.slice(0, 2).map(file => file.id));
});

function movePointer(item, x = 30, y = 30) {
  return { target: fileTarget(item), button: 0, pointerId: 7, clientX: x, clientY: y, preventDefault() { this.prevented = true; } };
}
function beginMove(h, item) {
  h.pointer("pointerdown", movePointer(item, 0, 0));
  h.pointer("pointermove", movePointer(item));
}

test("dragging a selected icon moves the entire group, highlights only folders and retains the source during state refresh", async () => {
  const files = [entry("a", "a.txt"), entry("b", "b.txt")], folder = entry("c", "目标", "folder"), calls = [];
  let items = [...files, folder];
  const classes = new Set(), hint = { textContent: "原提示" };
  const row = { dataset: { entryId: folder.id }, classList: { add: c => classes.add(c), remove: c => classes.delete(c) } };
  const target = { closest: selector => (selector === "[data-entry-id]" || selector.startsWith("[data-entry-id],")) ? row : null };
  const h = harness(async (action, input) => {
    calls.push([action, input]);
    if (action === "space.move") items = items.filter(item => item.id !== input.id);
    return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : action === "space.list" ? { items, breadcrumbs: [] } : {});
  }, () => assert.fail("internal moves must not upload"), [], {}, { querySelector: selector => selector === ".space-status-hint" ? hint : null });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("select", files[0].id); await h.click("select", files[1].id, {}, { metaKey: true });
  beginMove(h, files[0]);
  assert.deepEqual(selected(h.space.view()), files.map(item => item.id));
  assert.equal(h.space.isDragging(), true);
  h.emit({ accountId: "owner", boxId: "box", phase: "ready", tasks: [] });
  assert.equal(h.space.isDragging(), true);
  h.pointer("pointermove", movePointer(files[1]));
  assert.equal(classes.has("is-move-target"), false);
  const drop = { ...movePointer(null), target };
  h.pointer("pointermove", drop);
  assert.equal(classes.has("is-move-target"), true);
  assert.match(hint.textContent, /松开将 2 项移到“目标”/);
  await h.pointer("pointerup", drop);
  assert.deepEqual(calls.filter(([action]) => action === "space.move").map(([, input]) => [input.id, input.parent]), files.map(item => [item.id, folder.id]));
  assert.equal(h.space.isDragging(), false); assert.equal(classes.size, 0);
  assert.equal(hint.textContent, "原提示");
  assert.deepEqual(selected(h.space.view()), []);
});

test("dragging an unselected icon selects only that icon and cannot drop on itself, a file or empty space", async () => {
  const file = entry("a", "a.txt"), folder = entry("b", "资料", "folder"), calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: [file, folder], breadcrumbs: [] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick(); await h.click("select", file.id);
  beginMove(h, folder);
  assert.deepEqual(selected(h.space.view()), [folder.id]);
  for (const item of [folder, file, null]) h.pointer("pointermove", movePointer(item));
  await h.pointer("pointerup", movePointer(folder));
  assert.equal(calls.some(([action]) => action === "space.move"), false);
});

test("a group including folders rejects every selected folder as a destination", async () => {
  const items = [entry("a", "a.txt"), entry("b", "父目录", "folder"), entry("c", "其他", "folder")], calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items, breadcrumbs: [] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  for (const item of items) await h.click("select", item.id, {}, { ctrlKey: true });
  beginMove(h, items[0]);
  await h.pointer("pointerup", movePointer(items[1]));
  assert.equal(calls.some(([action]) => action === "space.move"), false);
});

test("path destinations permit returning a group to root but reject the current folder and forged destinations", async () => {
  const file = entry("a", "a.txt"), folder = entry("b", "当前文件夹", "folder"), calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: [file], breadcrumbs: [{ id: folder.id, name: folder.name }] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick(); await h.click("folder", folder.id);
  function pathEvent(id) {
    const button = { dataset: { id } };
    return { ...movePointer(null), target: { closest: selector => selector === '[data-action="space-folder"]' ? button : null } };
  }
  for (const id of [folder.id, "d".repeat(32)]) {
    beginMove(h, file); await h.pointer("pointerup", pathEvent(id));
    assert.equal(calls.some(([action]) => action === "space.move"), false);
  }
  beginMove(h, file); await h.pointer("pointerup", pathEvent(""));
  assert.equal(calls.filter(([action, input]) => action === "space.move" && input.id === file.id && input.parent === "").length, 1);
});

test("canceled, disconnected, switched-box and foreign drags cannot submit moves", async () => {
  const files = [entry("a", "a.txt"), entry("b", "目标", "folder")], calls = [];
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: files, breadcrumbs: [] }); });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.event("drop", { target: fileTarget(files[1]), dataTransfer: { types: ["application/x-wanx-space-move"], getData: () => files[0].id }, preventDefault() {} });
  for (const cancel of [() => h.pointer("pointercancel", {}), () => h.keydown({ key: "Escape" }), () => h.space.hostState({ ...connected("box"), canLaunchApplications: false }), () => h.space.hostState(connected("other")), () => h.space.activate(true, false)]) {
    h.space.hostState(connected("box")); h.space.activate(true, true); await tick();
    beginMove(h, files[0]);
    assert.equal(h.space.isDragging(), true);
    await cancel(); assert.equal(h.space.isDragging(), false);
    await h.pointer("pointerup", movePointer(files[1]));
  }
  assert.equal(calls.some(([action]) => action === "space.move"), false);
  h.space.activate(true, true); await h.click("recycle");
  beginMove(h, files[0]); assert.equal(h.space.isDragging(), false);
});

test("pointer capture uses the folder under the cursor and a short click never begins a move", async () => {
  const file = entry("a", "a.txt"), folder = entry("b", "目标", "folder"), calls = [];
  let hit = fileTarget(folder), captured = false;
  const list = { setPointerCapture() { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture() { captured = false; } };
  const source = { closest: selector => selector === "[data-entry-id]" ? { dataset: { entryId: file.id } } : selector === ".space-file-list" ? list : null };
  const h = harness(async (action, input) => { calls.push([action, input]); return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items: [file, folder], breadcrumbs: [] }); }, undefined, [], { elementFromPoint: () => hit });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  h.pointer("pointerdown", { ...movePointer(file, 0, 0), target: source });
  h.pointer("pointermove", movePointer(file, 2, 2));
  await h.pointer("pointerup", movePointer(file, 2, 2));
  assert.equal(captured, false); assert.equal(calls.some(([action]) => action === "space.move"), false);
  h.pointer("pointerdown", { ...movePointer(file, 0, 0), target: source });
  h.pointer("pointermove", movePointer(file)); assert.equal(captured, true);
  await h.pointer("pointerup", movePointer(file));
  assert.equal(captured, false);
  assert.equal(calls.filter(([action, input]) => action === "space.move" && input.parent === folder.id).length, 1);
});

test("drop moves retain failed items and stop the group when the account changes mid-request", async () => {
  const files = [entry("a", "a.txt"), entry("b", "b.txt")], folder = entry("c", "目标", "folder"), calls = [];
  let items = [...files, folder], switchAccount = false, h;
  h = harness(async (action, input) => {
    calls.push([action, input]);
    if (action === "space.move") {
      if (switchAccount) { h.space.hostState({ ...connected("other"), account: { accountId: "new-owner" } }); return ok({}); }
      if (input.id === files[1].id) return { ok: false, code: "SPACE_INVALID_DESTINATION" };
      items = items.filter(item => item.id !== input.id);
    }
    return ok(action === "space.refresh" ? { phase: "ready", tasks: [] } : { items, breadcrumbs: [] });
  });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("select", files[0].id); await h.click("select", files[1].id, {}, { ctrlKey: true });
  beginMove(h, files[0]); await h.pointer("pointerup", movePointer(folder));
  assert.match(h.space.view(), /已移动 1 项，1 项未完成/);
  assert.deepEqual(selected(h.space.view()), [files[1].id]);
  await new Promise(resolve => setTimeout(resolve, 0));
  items = [...files, folder]; await h.click("refresh");
  await h.click("select", files[0].id); await h.click("select", files[1].id, {}, { ctrlKey: true });
  switchAccount = true; const before = calls.length;
  beginMove(h, files[0]); await h.pointer("pointerup", movePointer(folder));
  assert.equal(calls.slice(before).filter(([action]) => action === "space.move").length, 1);
  assert.doesNotMatch(h.space.view(), /已移动 1 项，1 项未完成/);
});

test("Agent link creation, expiry, management and stale account results", async () => {
  const calls = [], file = { ...entry("a", "report.txt"), version: 2, previous_digest: "old" };
  const links = [{ id: "b".repeat(32), name: file.name, root: file.id, kind: "file", url: "http://127.0.0.1:123/space-links/"+"x".repeat(43), expires: null }];
  const h = harness(async (action, input) => {
    calls.push([action, input]);
    if (action === "space.refresh") return ok({ phase: "ready", tasks: [] });
    if (action === "space.list") return ok({ items: [file], breadcrumbs: [] });
    if (action === "space.links-list") return ok(links);
    if (action === "space.links-revoke") { links[0].revoked = 1; return ok(); }
    return ok({});
  });
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("link-create", file.id);
  assert.match(h.space.view(), /持有此链接的本机程序可读写/);
  h.event("change", { target: { id: "space-link-expiry", value: "7" } });
  await h.click("link-save");
  const create = calls.find(([a]) => a === "space.links-create")[1];
  assert.equal(create.root, file.id);
  assert.ok(create.expires > Date.now()/1000 + 6*86400);
  assert.match(h.space.view(), /MCP 接入配置|最近使用/);
  await h.click("link-revoke", links[0].id);
  assert.match(h.space.view(), /已撤销/);
  assert.doesNotMatch(h.space.view(), /http:\/\/127/);
  h.space.hostState({ ...connected("box"), account: { accountId: "other" } });
  assert.doesNotMatch(h.space.view(), /space-links\/x/);
});
test("restore previous file version submits the observed revision", async () => {
  const calls = [], file = { ...entry("a", "report.txt"), version: 4, previous_digest: "old" };
  const h = harness(async (action,input) => { calls.push([action,input]); return ok(action === "space.refresh" ? { phase:"ready",tasks:[] } : { items:[file],breadcrumbs:[] }); });
  h.space.hostState(connected("box"));h.space.activate(true);await tick();
  await h.click("previous",file.id);assert.match(h.space.view(),/当前版本将成为可恢复的上一版本/);
  await h.click("dialog-confirm");
  assert.equal(JSON.stringify(calls.find(([a])=>a==="space.restore-version")[1]),JSON.stringify({ id:file.id, expected:4 }));
});


test("name editor retains its node through broadcasts and does not submit during IME", async () => {
  const calls = [], notice = {}, input = {dataset: {editorKey: "mkdir:new"}, focus() {}, value: ""};
  const h = harness(async (action, value) => { calls.push([action, value]); return ok(action === "space.refresh" ? {phase:"ready",tasks:[]} : listed("one")); }, undefined, [], {nodes: new Map([["#space-name", input], ["[data-space-dialog-error]", notice]])});
  h.space.hostState(connected("box")); h.space.activate(true); await tick();
  await h.click("mkdir");
  h.event("compositionstart", {target:{id:"space-name"}});
  h.event("input", {target:{id:"space-name",value:"项目"}});
  h.emit({accountId:"owner",boxId:"box",phase:"ready",tasks:[]});
  assert.equal(h.space.retainEditor(), true);
  await h.keydown({key:"Escape",isComposing:true});
  h.event("submit", {target:{dataset:{form:"space"}},preventDefault(){}}); await tick();
  assert.equal(calls.some(([action])=>action==="space.mkdir"), false);
  h.event("compositionend", {target:{id:"space-name",value:"项目资料"}});
  h.event("submit", {target:{dataset:{form:"space"}},preventDefault(){}}); await tick();
  assert.equal(calls.find(([action])=>action==="space.mkdir")[1].name, "项目资料");
  assert.equal(h.space.retainEditor(), false);
});
