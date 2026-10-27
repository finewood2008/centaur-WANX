import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpaceLinkBridge } from '../shell/space-links.mjs';

const key = 'xg_synthetic_team_warehouse_key_never_a_real_credential';
const timeout = { timeout: 10000 };
async function fixture(t) {
  let accountId = 'account', clientId = 'client', boxId = 'box', signedIn = true, denied = false, local = false, mixedContext = false;
  let pendingSearch;
  const listeners = new Set(), calls = [];
  const client = {
    snapshot: () => ({ phase: 'ready', account: { phase: signedIn ? 'authenticated' : 'signed_out', accountId, clientId },
      connection: { deviceId: boxId, url: 'https://box.invalid/', ...(local ? { authorization: 'local-trust-v1' } : {}) } }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    applicationConnection: async () => {
      const captured = { accountId, clientId, boxId };
      return { context: () => ({ ...captured, user: { id: 7, role: 'user' },
        ...(mixedContext ? { authorization: 'local-trust-v1', principalId: 'local-principal' } : {}) }),
      request: async input => {
        calls.push(input);
        assert.equal(input.headers['X-Xingtu-Key'], key);
        assert.equal(input.headers['x-wanx-data-context'], undefined);
        if (input.path === '/api/semantica/open/v1/search' && pendingSearch) {
          pendingSearch.enter(); await pendingSearch.wait;
        }
        return { status: denied ? 403 : 200, body: Buffer.from(JSON.stringify(denied
          ? { code: 'WAREHOUSE_KEY_REVOKED' } : { id: 'server-authorized-warehouse' })) };
      } };
    },
  };
  const bridge = await createSpaceLinkBridge({ client, identitySecurityEnabled: false, serviceURL: 'https://consumer.invalid',
    store: { load: async () => null, save: async () => assert.fail('MCP must not persist warehouse Keys') } });
  t.after(() => bridge.close());
  const details = await bridge.mcpDetails('starlink'), endpoint = new URL(details.url);
  const rpc = (params, extra = {}, token = key, suffix = '') => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: endpoint.pathname + suffix, method: 'POST',
      headers: { authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.setTimeout(3000, () => request.destroy(Error('MCP_FIXTURE_TIMEOUT')));
    request.on('error', reject);
    request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: params ? 'tools/call' : 'tools/list', ...(params ? { params } : {}) }));
  });
  const change = field => {
    if (field === 'account') accountId = 'other-account';
    if (field === 'client') clientId = 'other-client';
    if (field === 'box') boxId = 'other-box';
    if (field === 'logout') signedIn = false;
    if (field === 'missing-client') clientId = null;
    if (field === 'local') local = true;
    if (field === 'mixed-context') mixedContext = true;
    for (const fn of listeners) fn();
  };
  return { bridge, details, rpc, calls, change, revoke: () => { denied = true; }, holdSearch() {
    let release, enter; const wait = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { enter = resolve; }); pendingSearch = { wait, enter }; return { release, entered };
  } };
}

test('disabled identity security registers authenticated cloud knowledge MCP on loopback and keeps space MCP on the server', timeout, async t => {
  const f = await fixture(t);
  assert.equal(new URL(f.details.url).hostname, '127.0.0.1'); assert.equal(f.details.localOnly, true);
  assert.equal(f.details.authentication, 'Authorization: Bearer <仓库 Key>');
  assert.equal((await f.bridge.mcpDetails('space')).url, 'https://box.invalid/mcp/space');
  assert.equal((await f.rpc()).status, 200);
  assert(f.calls.some(call => call.path === '/api/semantica/open/v1/warehouse'));
  assert.equal((await f.rpc(undefined, { host: 'foreign.invalid' })).status, 403);
  assert.equal((await f.rpc(undefined, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.rpc(undefined, {}, key, '?warehouse=outside')).status, 400);
  assert.equal((await f.rpc(undefined, {}, 'wmcp_' + 'a'.repeat(43))).status, 401);
  f.revoke(); assert.equal((await f.rpc()).status, 403);
  await f.bridge.close(); await assert.rejects(f.rpc());
});

for (const field of ['logout', 'missing-client', 'local', 'mixed-context']) test(`cloud knowledge MCP rejects ${field} before a backend read`, timeout, async t => {
  const f = await fixture(t); f.change(field);
  assert.equal((await f.rpc()).status, 403); assert.equal(f.calls.length, 0);
});

for (const field of ['account', 'client', 'box']) test(`cloud knowledge MCP discards late results after ${field} changes`, timeout, async t => {
  const f = await fixture(t), held = f.holdSearch(); t.after(held.release);
  const pending = f.rpc({ name: 'xingtu_search', arguments: { query: 'allowed query' } });
  await held.entered; f.change(field); held.release();
  const response = await pending;
  assert.equal(response.body.result.isError, true);
  assert.equal(JSON.stringify(response).includes('server-authorized-warehouse'), false);
});
