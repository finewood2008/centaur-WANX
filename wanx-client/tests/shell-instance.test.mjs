import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { claimSingleInstance } from "../shell/instance.mjs";

test("second app process quits without initializing a shared network identity", () => {
  const app = new EventEmitter();
  let quits = 0;
  let starts = 0;
  app.requestSingleInstanceLock = () => false;
  app.quit = () => quits++;
  if (claimSingleInstance(app, () => undefined)) starts++;
  assert.equal(quits, 1);
  assert.equal(starts, 0);
  assert.equal(app.listenerCount("second-instance"), 0);
});

test("repeat launch restores and focuses the existing window; early events are safe", () => {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.quit = () => assert.fail("first instance should not quit");
  let control;
  assert.equal(
    claimSingleInstance(app, () => control),
    true,
  );
  app.emit("second-instance");
  const calls = [];
  control = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  app.emit("second-instance");
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  control.isDestroyed = () => true;
  app.emit("second-instance");
  assert.equal(calls.length, 3);
});


test("explicit terminal arguments are handled without showing a management entry", () => {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  let shown = 0, commands = 0;
  claimSingleInstance(app, () => ({ isDestroyed: () => false, isMinimized: () => false, show() { shown++; }, focus() {} }), argv => {
    if (!argv?.includes('--wanx-console')) return false;
    commands++; return true;
  });
  app.emit('second-instance', {}, ['wanx', '--wanx-console']);
  assert.equal(commands, 1); assert.equal(shown, 0);
  app.emit('second-instance', {}, ['wanx']);
  assert.equal(shown, 1);
});
