import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
function harness() {
  const exposed = {}, calls = [], listeners = new Map();
  vm.runInNewContext(source, { require: () => ({
    contextBridge: { exposeInMainWorld(name, api) { exposed[name] = api; } },
    ipcRenderer: {
      invoke: async (name, value) => { calls.push([name, value]); return { ok: true, value: { state: 'previewReady' } }; },
      send: (name, value) => calls.push([name, value]),
      on: (name, fn) => listeners.set(name, fn), removeListener() {},
    },
  }) });
  return { exposed, calls, listeners };
}
test('active preload connects discovery, GATT transport and setup actions', async () => {
  const { exposed, calls } = harness();
  assert.equal(typeof exposed.wanxSetupTransport?.subscribe, 'function');
  assert.equal(typeof exposed.wanxDiscovery?.select, 'function');
  assert.equal(typeof exposed.wanxSetup?.begin, 'function');
  await exposed.wanxSetup.begin({ candidateId: 'selected' });
  await exposed.wanxSetup.wifi({ ssid: 'office', security: 'open', hidden: false });
  await exposed.wanxSetup.confirmOwnership();
  exposed.wanxDiscovery.select('scan', 'selected');
  assert.deepEqual(calls.map(([name]) => name), ['wanx:setup:begin', 'wanx:setup:wifi', 'wanx:setup:confirmOwnership', 'nexusaos:discovery:select']);
});
