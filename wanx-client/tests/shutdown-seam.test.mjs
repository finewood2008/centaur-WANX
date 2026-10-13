import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { registerShutdown } from '../shell/shutdown.mjs';

function quit(app) {
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  return prevented;
}

test('repeated Host quit waits for application cleanup before accepting exit', async () => {
  const app = new EventEmitter();
  let release, calls = 0, hostClosed = 0, accepted = 0;
  app.quit = () => { if (!quit(app)) accepted++; };
  registerShutdown({ app,
    closeApplications: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    closeHost: async () => { hostClosed++; }, onError: assert.fail,
  });
  assert.equal(quit(app), true);
  await setImmediate();
  assert.equal(quit(app), true);
  assert.equal(calls, 1);
  assert.equal(hostClosed, 0);
  release(); await setImmediate();
  assert.equal(hostClosed, 1);
  assert.equal(accepted, 1);
});

test('failed application cleanup reports failure and allows a quit retry', async () => {
  const app = new EventEmitter(), errors = [];
  let fail = true, accepted = 0, hostClosed = 0;
  app.quit = () => { if (!quit(app)) accepted++; };
  registerShutdown({ app,
    closeApplications: async () => { if (fail) throw new Error('APPLICATION_STOP_FAILED'); },
    closeHost: async () => { hostClosed++; }, onError: e => errors.push(e.message),
  });
  quit(app); await setImmediate();
  assert.deepEqual(errors, ['APPLICATION_STOP_FAILED']);
  assert.equal(accepted, 0); assert.equal(hostClosed, 0);
  fail = false;
  quit(app); await setImmediate();
  assert.equal(accepted, 1); assert.equal(hostClosed, 1);
});
