import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { installElectronBluetoothPicker } from "@nexusaos/device-discovery-electron/main";

const bundle = await readFile(new URL("../local-ui/renderer/device-setup.bundle.js", import.meta.url), "utf8");
const source = await readFile(new URL("../local-ui/renderer/discovery-selection.js", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const contents = new EventEmitter(), ipcMain = new EventEmitter();
  contents.mainFrame = { url: "file:///setup.html" };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const views = [], notices = [], selected = [], requests = [], sent = [];
  let candidates, settled, browserPending, busyRejections = 0;
  const send = (name, payload) => {
    sent.push([name, payload]);
    queueMicrotask(() => ipcMain.emit(`nexusaos:discovery:${name}`, event, payload));
  };
  contents.send = (name, payload) => queueMicrotask(() => {
    if (name === "nexusaos:discovery:candidates") candidates?.(payload);
    if (name === "nexusaos:discovery:settled") settled?.(payload);
  });
  const disposePicker = installElectronBluetoothPicker({
    webContents: contents, ipcMain, documentUrl: contents.mainFrame.url,
    scanTimeoutMs: 12000, clock: { monotonicMs: () => Date.now() },
  });
  const bluetooth = {
    getAvailability: async () => true,
    requestDevice() {
      if (browserPending) {
        busyRejections++;
        return Promise.reject(new DOMException("Previous chooser still open", "InvalidStateError"));
      }
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const attempt = {
        cancelled: false,
        finish(id) {
          if (browserPending !== attempt) return;
          browserPending = undefined;
          if (id) resolve({ id, name: "Test box" });
          else reject(new DOMException("Chooser cancelled", "NotFoundError"));
        },
      };
      browserPending = attempt;
      requests.push(attempt);
      queueMicrotask(() => contents.emit("select-bluetooth-device", { preventDefault() {} },
        [{ deviceId: "provider-102", deviceName: "Test box" }], id => {
          if (id) attempt.finish(id);
          else attempt.cancelled = true; // Chromium cancellation completes later.
        }));
      return promise;
    },
  };
  const window = { wanxSetupTransport: { subscribe() { return () => {}; }, reply() {}, status() {} } };
  const scope = vm.createContext({
    window, navigator: { bluetooth }, crypto: globalThis.crypto,
    performance: { now: () => Date.now() }, setTimeout, clearTimeout,
    AbortController, DOMException, TextEncoder, TextDecoder, Uint8Array, DataView, ArrayBuffer,
  });
  vm.runInContext(bundle, scope);
  vm.runInContext(source, scope);
  const selection = scope.createDiscoverySelection({
    transport: window.wanxDeviceSetupTransport,
    discovery: {
      subscribe(onCandidates, onSettled) {
        candidates = onCandidates; settled = onSettled;
        return () => { candidates = settled = undefined; };
      },
      select: (sessionId, candidateId) => send("select", { sessionId, candidateId }),
      reselect: (sessionId, candidateId) => send("reselect", { sessionId, candidateId }),
      cancel: sessionId => send("cancel", { sessionId }),
      forget: sessionId => send("forget", { sessionId }),
    },
    onChange(value) { views.push(structuredClone(value)); },
    onNotice(value) { notices.push(structuredClone(value)); },
    onSelected(value) { selected.push(value); },
  });
  t.after(async () => {
    selection.dispose(); disposePicker();
    browserPending?.finish();
    await window.wanxDeviceSetupTransport.dispose();
  });
  return {
    selection, requests, selected, notices, sent,
    get view() { return views.at(-1); },
    get busyRejections() { return busyRejections; },
    async timeout() {
      selection.start(); await flush();
      const candidateId = views.at(-1).candidates[0].candidateId;
      t.mock.timers.tick(12000); await flush();
      return candidateId;
    },
  };
}

test("retained selection waits for the old browser chooser to settle before another user gesture", async t => {
  const h = harness(t), candidateId = await h.timeout();
  assert.equal(h.requests[0].cancelled, true);
  assert.equal(h.view.selecting, true);
  assert.equal(h.view.retained, true);
  h.selection.choose(candidateId);
  assert.equal(h.requests.length, 1, "clicks during cancellation must not open another chooser");
  t.mock.timers.tick(1000);
  h.requests[0].finish(); await flush();
  assert.equal(h.view.selecting, false);
  assert.equal(h.view.retained, true);
  h.selection.choose(candidateId); await flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.busyRejections, 0);
  assert.equal(h.selected.length, 1);
  assert.ok(h.selected[0].selectionLeaseId);
  assert.equal(h.sent.filter(([name]) => name === "reselect").length, 1);
});

test("a chooser that never acknowledges cancellation stops the spinner and blocks overlapping browser requests", async t => {
  const h = harness(t);
  await h.timeout();
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.view.selecting, false);
  assert.equal(h.view.retained, false);
  assert.deepEqual(h.view.candidates, []);
  assert.deepEqual(h.notices.at(-1), { kind: "selection_cancel_failed" });
  h.selection.start(); await flush();
  assert.equal(h.requests.length, 1, "a fresh click must not overlap the unresolved Chromium request");
  assert.equal(h.busyRejections, 0);
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.view.selecting, false);
  h.requests[0].finish("provider-102"); await flush();
  assert.equal(h.selected.length, 0, "a late success from the cancelled chooser carries no authority");
  assert.equal(h.requests.length, 1, "settling cannot silently open a chooser outside a user gesture");
  h.selection.start(); await flush();
  assert.equal(h.requests.length, 2);
  h.selection.choose(h.view.candidates[0].candidateId); await flush();
  assert.equal(h.selected.length, 1, "a new user gesture receives a fresh, usable lease");
});

test("reset while awaiting Chromium cancellation ignores late selection and cancels the settlement deadline", async t => {
  const h = harness(t);
  await h.timeout();
  h.selection.reset();
  const noticeCount = h.notices.length;
  h.requests[0].finish("provider-102"); await flush();
  t.mock.timers.tick(2000); await flush();
  assert.equal(h.notices.length, noticeCount);
  assert.equal(h.selected.length, 0);
  assert.equal(h.view.selecting, false);
  h.selection.start(); await flush();
  h.selection.choose(h.view.candidates[0].candidateId); await flush();
  assert.equal(h.selected.length, 1);
  assert.equal(h.busyRejections, 0);
});
