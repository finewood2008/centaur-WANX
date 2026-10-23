import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../local-ui/renderer/discovery-selection.js", import.meta.url), "utf8");
const candidate = { candidateId: "candidate-1", advertisedName: "Test box" };
const selected = { ...candidate, selectionLeaseId: "fresh-lease", transportHandle: "handle-1" };
const flush = () => new Promise(resolve => setImmediate(resolve));
const timeout = () => Object.assign(new Error("timed out"), { code: "LOCAL_SELECTION_TIMEOUT" });

function fixture(t, { available = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(source, scope);
  const calls = [], attempts = [], views = [], notices = [], selections = [];
  let candidates, settled;
  const transport = {
    requestDeviceFromUserGesture() {
      calls.push(["request"]);
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      attempts.push({ resolve, reject });
      return promise;
    },
    cancelSelection() { calls.push(["cancelSelection"]); },
    dispose() { assert.fail("The selection module must not dispose the shared GATT transport"); },
  };
  const selection = scope.createDiscoverySelection({
    transport: available ? transport : undefined,
    discovery: {
      subscribe(onCandidates, onSettled) {
        candidates = onCandidates; settled = onSettled;
        return () => calls.push(["unsubscribe"]);
      },
      select: (...args) => calls.push(["select", ...args]),
      reselect: (...args) => calls.push(["reselect", ...args]),
      cancel: (...args) => calls.push(["cancel", ...args]),
      forget: (...args) => calls.push(["forget", ...args]),
    },
    onChange(view) { views.push(structuredClone(view)); calls.push(["change"]); },
    onNotice(issue) { notices.push(structuredClone(issue)); },
    onSelected(value) { selections.push(value); },
  });
  t.after(() => selection.dispose());
  return {
    selection, calls, attempts, views, notices, selections,
    get view() { return views.at(-1); },
    candidates(sessionId = "scan-1", values = [candidate]) { candidates({ sessionId, candidates: values }); },
    settled(sessionId = "scan-1") { settled({ sessionId, cancelled: true }); },
    async retain() {
      selection.start();
      candidates({ sessionId: "scan-1", candidates: [candidate] });
      settled({ sessionId: "scan-1", cancelled: true });
      attempts[0].reject(timeout());
      await flush();
    },
  };
}

test("start invokes the chooser in the calling stack and live selection uses the active session", async t => {
  const h = fixture(t);
  h.selection.start();
  assert.deepEqual(h.calls, [["cancelSelection"], ["request"], ["change"]]);
  h.selection.start();
  assert.equal(h.attempts.length, 1);
  h.candidates();
  assert.deepEqual(h.view, { selecting: true, retained: false, candidates: [candidate] });
  assert.deepEqual(h.notices, [null], "candidate updates must not replace other UI notices");
  h.selection.choose(candidate.candidateId);
  assert.deepEqual(h.calls.at(-1), ["select", "scan-1", "candidate-1"]);
  h.attempts[0].resolve(selected);
  await flush();
  assert.deepEqual(h.selections, [selected]);
  assert.deepEqual(h.view, { selecting: false, retained: false, candidates: [] });
});

test("reselection invokes reselect before the fresh chooser in the same stack, retaining the original display", async t => {
  const h = fixture(t);
  await h.retain();
  const before = h.calls.length;
  h.selection.choose("not-in-results");
  assert.equal(h.calls.length, before);
  h.selection.choose(candidate.candidateId);
  assert.deepEqual(h.calls.slice(before), [["reselect", "scan-1", "candidate-1"], ["request"], ["change"]]);
  h.candidates("scan-2", [{ candidateId: "different", advertisedName: "Another box" }]);
  assert.deepEqual(h.view, { selecting: true, retained: true, candidates: [candidate] });
  h.selection.choose(candidate.candidateId);
  assert.equal(h.attempts.length, 2);
  h.attempts[1].resolve(selected);
  await flush();
  assert.deepEqual(h.selections, [selected]);
  t.mock.timers.tick(120000);
  assert.equal(h.notices.some(issue => issue?.kind === "expired"), false);
});

test("settled and a later rejection share the first retention deadline; failed reselection does not extend it", async t => {
  const h = fixture(t);
  h.selection.start(); h.candidates(); h.settled();
  t.mock.timers.tick(30000);
  h.attempts[0].reject(timeout());
  await flush();
  t.mock.timers.tick(30000);
  h.selection.choose(candidate.candidateId);
  h.candidates("scan-2"); h.settled("scan-2");
  h.attempts[1].reject(timeout());
  await flush();
  assert.deepEqual(h.notices.at(-1), { kind: "reselect_failed" });
  assert.deepEqual(h.view, { selecting: false, retained: true, candidates: [candidate] });
  t.mock.timers.tick(59999);
  assert.equal(h.view.retained, true);
  t.mock.timers.tick(1);
  assert.deepEqual(h.notices.at(-1), { kind: "expired" });
  assert.deepEqual(h.view, { selecting: false, retained: false, candidates: [] });
  assert.ok(h.calls.some(call => call[0] === "forget" && call[1] === "scan-1"));
});

for (const outcome of ["resolve", "reject"]) {
  test(`expiry cancels pending reselection and ignores its late ${outcome}`, async t => {
    const h = fixture(t);
    await h.retain();
    t.mock.timers.tick(119999);
    h.selection.choose(candidate.candidateId);
    h.candidates("scan-2");
    const cancels = h.calls.filter(call => call[0] === "cancelSelection").length;
    t.mock.timers.tick(1);
    assert.equal(h.calls.filter(call => call[0] === "cancelSelection").length, cancels + 1);
    assert.deepEqual(h.notices.at(-1), { kind: "expired" });
    const views = h.views.length, notices = h.notices.length;
    h.attempts[1][outcome](outcome === "resolve" ? selected : timeout());
    await flush();
    assert.equal(h.views.length, views);
    assert.equal(h.notices.length, notices);
    assert.deepEqual(h.selections, []);
  });

  test(`reset isolates a new scan from an old chooser's late ${outcome}`, async t => {
    const h = fixture(t);
    h.selection.start(); h.candidates();
    h.selection.reset();
    h.selection.start(); h.candidates("scan-2");
    const views = h.views.length, notices = h.notices.length;
    h.attempts[0][outcome](outcome === "resolve" ? selected : timeout());
    await flush();
    assert.equal(h.views.length, views);
    assert.equal(h.notices.length, notices);
    assert.deepEqual(h.selections, []);
    h.attempts[1].resolve(selected);
    await flush();
    assert.deepEqual(h.selections, [selected]);
  });
}

test("reset removes the old retention timer without ending a new scan", async t => {
  const h = fixture(t);
  await h.retain();
  t.mock.timers.tick(60000);
  h.selection.reset(); h.selection.start(); h.candidates("scan-2");
  t.mock.timers.tick(60000);
  assert.equal(h.view.selecting, true);
  assert.equal(h.notices.some(issue => issue?.kind === "expired"), false);
});

test("dispose unsubscribes once and prevents callbacks or new chooser operations", async t => {
  const h = fixture(t);
  h.selection.start(); h.candidates();
  h.selection.dispose();
  const calls = h.calls.length, views = h.views.length, notices = h.notices.length;
  h.selection.dispose(); h.selection.reset(); h.selection.start(); h.selection.choose(candidate.candidateId);
  h.candidates(); h.settled(); h.attempts[0].resolve(selected);
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(h.calls.length, calls);
  assert.equal(h.views.length, views);
  assert.equal(h.notices.length, notices);
  assert.deepEqual(h.selections, []);
  assert.equal(h.calls.filter(call => call[0] === "unsubscribe").length, 1);
});

for (const [error, expected] of [
  [timeout(), { kind: "empty" }],
  [Object.assign(new Error("chooser canceled"), { name: "NotFoundError" }), { kind: "empty" }],
  [new Error("Bluetooth unavailable"), { kind: "error", message: "Bluetooth unavailable" }],
]) {
  test(`an empty scan reports ${error.name}/${error.message} without retaining results`, async t => {
    const h = fixture(t);
    h.selection.start(); h.candidates("scan-1", []);
    h.attempts[0].reject(error);
    await flush();
    assert.deepEqual(h.notices.at(-1), expected);
    assert.equal(h.view.retained, false);
  });
}

test("missing Bluetooth transport produces the existing unavailable notice intent", t => {
  const h = fixture(t, { available: false });
  h.selection.start();
  assert.deepEqual(h.notices, [{ kind: "unavailable" }]);
  assert.equal(h.attempts.length, 0);
});
