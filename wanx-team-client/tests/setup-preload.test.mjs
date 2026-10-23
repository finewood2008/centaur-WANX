import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
function harness(rawState = {}, platform = 'darwin') {
  const exposed = {}, calls = [], listeners = new Map();
  vm.runInNewContext(source, { process: { platform }, require: () => ({
    contextBridge: { exposeInMainWorld(name, api) { exposed[name] = api; } },
    ipcRenderer: {
      invoke: async (name, value) => {
        calls.push([name, value]);
        return name === 'wanx-client:get-state' ? rawState : { ok: true, value: { state: 'previewReady' } };
      },
      send: (name, value) => calls.push([name, value]),
      on: (name, fn) => listeners.set(name, fn), removeListener() {},
    },
  }) });
  return { exposed, calls, listeners };
}
test('active preload connects discovery, GATT transport and setup actions', async () => {
  const { exposed, calls } = harness();
  assert.equal(typeof exposed.wanxSetupTransport?.subscribe, 'function');
  assert.equal(exposed.wanxSetupTransport.scanTimeoutMs, 30000);
  assert.equal(harness({}, 'win32').exposed.wanxSetupTransport.scanTimeoutMs, 60000);
  assert.equal(typeof exposed.wanxDiscovery?.select, 'function');
  assert.equal(typeof exposed.wanxSetup?.begin, 'function');
  await exposed.wanxSetup.begin({ candidateId: 'selected' });
  await exposed.wanxSetup.wifi({ ssid: 'office', security: 'open', hidden: false });
  await exposed.wanxSetup.confirmOwnership();
  exposed.wanxDiscovery.select('scan', 'selected');
  assert.deepEqual(calls.map(([name]) => name), ['wanx:setup:begin', 'wanx:setup:wifi', 'wanx:setup:confirmOwnership', 'nexusaos:discovery:select']);
});

test('preload reports the main network readiness separately from authorized devices', async () => {
  const device = { deviceId: 'box-102', displayName: 'CentuarAI-AMD-102', accessState: 'ready' };
  const base = {
    account: { phase: 'authenticated', accountId: 'account-1' },
    phase: 'idle',
    devices: [device],
    connection: null,
  };
  const preparing = harness({ ...base, platform: { phase: 'enrolling' }, network: { phase: 'checking' } });
  const preparingState = await preparing.exposed.wanxClient.getLocalState();
  assert.equal(preparingState.networkReady, false);
  assert.equal(preparingState.availableDevices[0].deviceId, 'box-102');

  const ready = harness({ ...base, platform: { phase: 'ready' }, network: { phase: 'ready' } });
  const readyState = await ready.exposed.wanxClient.getLocalState();
  assert.equal(readyState.networkReady, true);
  assert.equal(readyState.availableDevices[0].deviceId, 'box-102');
});


test('preload only delegates Bluetooth settings opening to its dedicated IPC', async () => {
  const { exposed, calls } = harness();
  await exposed.wanxDiscovery.openBluetoothSettings();
  await exposed.wanxDiscovery.openBluetoothSettings('privacy');
  assert.deepEqual(calls, [
    ['wanx:discovery:open-bluetooth-settings', 'bluetooth'],
    ['wanx:discovery:open-bluetooth-settings', 'privacy'],
  ]);
});

test('password preload restricts change requests to code and password', async () => {
  const { exposed, calls } = harness();
  const input = { username: '13800138000', phone: '13900139000', code: '000001', password: ' password ', token: 'secret' };
  for (const action of ['auth.send-reset-code', 'auth.reset-password', 'auth.send-change-code', 'auth.change-password'])
    assert.equal((await exposed.wanxClient.action(action, input)).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.filter(([name]) => name !== 'wanx-client:get-state'))), [
    ['wanx-client:send-reset-code', { phone: input.username }],
    ['wanx-client:reset-password', { phone: input.username, code: input.code, password: input.password }],
    ['wanx-client:send-change-code', null],
    ['wanx-client:change-password', { code: input.code, password: input.password }],
  ]);
});


test('owner wifi begin preserves selected transport fields and explicit mode through IPC', async () => {
  const { exposed, calls } = harness();
  const selected = { candidateId: 'opaque', transportHandle: 'transport', mode: 'wifi' };
  await exposed.wanxSetup.begin(selected);
  assert.deepEqual(calls, [['wanx:setup:begin', selected]]);
});
