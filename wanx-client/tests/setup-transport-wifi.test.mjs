import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const output = await build({
  entryPoints: [fileURLToPath(new URL('../local-ui/renderer/deviceSetupTransport.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser',
});
const { createDeviceSetupTransport } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
);

function harness() {
  let receive, reply;
  const requests = [];
  const transport = createDeviceSetupTransport({
    bluetooth: {},
    bridge: {
      subscribe(fn) { receive = fn; return () => {}; },
      reply(value) { reply(value); },
      status() {},
    },
    selectionFactory: () => ({ cancelSelection() {} }),
    endpointFactory: () => ({
      async request(id, frame, match, signal) {
        requests.push({ id, frame, match, signal });
        return Uint8Array.from([7, 8, 9]);
      },
      async closeAll() {},
    }),
  });
  return {
    transport, requests,
    request(match, frame = [1, 2, 3]) {
      return new Promise(resolve => {
        reply = resolve;
        receive({ requestId: 'rpc-1', operation: 'request', args: ['connection-1', frame, match] });
      });
    },
  };
}
const match = { requestId: 'c3f64648-5fc6-499c-987f-f021f4b8d3a4', responseMessageType: 'wifi.scan.result' };

test('Wi-Fi scan passes the renderer transport allowlist and reaches GATT', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.request(match), { requestId: 'rpc-1', ok: true, value: [7, 8, 9] });
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0].match, match);
    assert.deepEqual([...h.requests[0].frame], [1, 2, 3]);
  } finally { await h.transport.dispose(); }
});
for (const operation of ['start', 'authorize', 'challenge', 'token', 'receipt']) test(`offline Wi-Fi ${operation} response reaches the bounded GATT relay`, async () => {
  const h = harness();
  try { assert.equal((await h.request({ ...match, responseMessageType: `local.wifi.${operation}.result` })).ok, true); }
  finally { await h.transport.dispose(); }
});

test('Wi-Fi scan support still rejects unknown response types and oversized frames', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.request({ ...match, responseMessageType: 'wifi.unknown.result' }),
      { requestId: 'rpc-1', ok: false, code: 'INVALID_REQUEST' });
    assert.deepEqual(await h.request(match, Array(2049).fill(0)),
      { requestId: 'rpc-1', ok: false, code: 'PROTOCOL_CHANGED' });
    assert.equal(h.requests.length, 0);
  } finally { await h.transport.dispose(); }
});
