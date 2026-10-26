import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSpaceLinkBridge } from '../shell/space-links.mjs';
import { createKnowledgeCapabilities } from '../device-trust/knowledge-capabilities.mjs';
import { knowledgeMcpAccess } from '../../wanx-studio/integration/team-client/wanx-mcp-knowledge.mjs';
const warehouseId = '12345678-1234-1234-1234-123456789abc', other = '12345678-1234-1234-1234-123456789abd';
function setup() {
  let now = 1700000000000, version = 1, phase = 'unlocked', principalId = 'first', allowed = true;
  const listeners = new Set(), calls = [], grant = { resourceId: 'team:knowledge:' + warehouseId, actions: ['read'] };
  const client = { snapshot: () => ({ phase: 'ready', connection: { authorization: 'local-trust-v1', deviceId: 'box' }, dataIdentity: {
    phase, profileId: 'profile', clientId: 'client', generation: 1, selected: { boxId: 'box', ownershipEpoch: 1, boxKeyThumbprint: 'pin', principalId, bindingId: 'binding', sessionId: 'session', authorizationVersion: version } } }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, applicationConnection: async () => ({
      context: () => ({ authorization: 'local-trust-v1', dataIdentity: { sessionId: 'session', authorizationVersion: version, principalId, bindingId: 'binding', ownershipEpoch: 1, grants: allowed ? [grant] : [] } }),
      request: async input => { calls.push(input); return { status: allowed ? 200 : 403, body: Buffer.from(JSON.stringify({ id: warehouseId, masked: true })), headers: {} }; },
    }) };
  const registry = createKnowledgeCapabilities({ client, clock: () => now });
  return { client, registry, calls, tick: () => now += 86400001, revoke: () => { allowed = false; version++; }, regrant: () => { allowed = true; version++; },
    change: () => { principalId = 'second'; for (const fn of listeners) fn(); }, lock: () => { phase = 'locked'; for (const fn of listeners) fn(); } };
}
test('explicit local capability is 256-bit, current-session only, finite readonly masked paths and no old cloud/key auth', async () => {
  const f = setup(); const issued = await f.registry.create({ warehouseId, name: 'test agent', days: 30 });
  assert.match(issued.token, /^wmcp_[A-Za-z0-9_-]{43}$/); assert.deepEqual(issued.key.scopes, ['documents', 'graph', 'search', 'evidence']);
  assert.equal(issued.key.expires_at, 1700000000 + 86400);
  await assert.rejects(f.registry.resolve('xg_' + 'a'.repeat(43)), { code: 'MCP_KEY_INVALID' });
  await assert.rejects(f.registry.create({ warehouseId: other, name: 'wrong', days: 1 }), { code: 'TEAM_RESOURCE_APPROVAL_REQUIRED' });
  const access = await knowledgeMcpAccess({ capability: await f.registry.resolve(issued.token) });
  await access.request('/search', { method: 'POST', body: { query: 'masked evidence', limit: 5 } });
  const request = f.calls.at(-1); assert.equal(request.path, '/api/semantica/search');
  assert.equal(request.headers['x-wanx-data-context'], 'team:knowledge:' + warehouseId);
  assert.equal(JSON.stringify(f.calls).includes(issued.token), false); assert.equal(JSON.stringify(f.calls).includes('X-Xingtu-Key'), false);
  await access.request('/graph?limit=100&entity_id=entity_1');
  assert.equal(f.calls.at(-1).path, '/api/semantica/graph?limit=100&entity_id=entity_1');
  await access.request('/evidence/evidence_1');
  assert.equal(f.calls.at(-1).path, '/api/semantica/evidence/evidence_1');
  for (const [path, options] of [['/owner/graph', {}], ['/keys', {}], ['/graph?warehouse_id=' + other, {}], ['/graph?limit=1&limit=2', {}], ['/graph?limit=501', {}], ['/graph?entity_id=..%2Fother', {}], ['/evidence/..%2Fsecret', {}], ['https://evil.invalid/graph', {}], ['/search', { method: 'POST', body: { query: 'x', privacy_mode: 'raw' } }], ['/documents', { method: 'DELETE' }], ['/warehouse?id=' + other, {}]])
    await assert.rejects(access.request(path, options), { code: 'MCP_TOOL_DENIED' });
  f.registry.close();
});
test('expired, locked, switched and revoked capabilities never regain authority after regrant', async () => {
  for (const change of ['tick', 'lock', 'change', 'revoke']) {
    const f = setup(), issued = await f.registry.create({ warehouseId, name: 'temporary', days: 1 });
    f[change](); await assert.rejects(f.registry.resolve(issued.token));
    f.regrant(); await assert.rejects(f.registry.resolve(issued.token)); f.registry.close();
  }
});

test('real loopback MCP enforces Host/Origin, exact tools, live scope and never persists session tokens', async t => {
  const f = setup(), stored = [];
  const bridge = await createSpaceLinkBridge({ client: f.client, knowledgeCapabilities: f.registry,
    serviceURL: 'https://synthetic.invalid', store: { load: async () => null, save: async value => stored.push(structuredClone(value)) } });
  t.after(async () => { await bridge.close(); f.registry.close(); });
  const endpoint = new URL((await bridge.mcpDetails('starlink')).url);
  const issued = await f.registry.create({ warehouseId, name: 'loopback fixture', days: 1 });
  const rpc = (params, extra = {}, token = issued.token, query = '') => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: endpoint.pathname + query, method: 'POST', headers: {
      authorization: 'Bearer ' + token, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra,
    } }, response => { const chunks = []; response.on('data', value => chunks.push(value)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) })); });
    request.on('error', reject); request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }));
  });
  const input = { name: 'xingtu_search', arguments: { query: 'approved masked knowledge', limit: 5 } };
  assert.equal((await rpc(input)).status, 200);
  assert.ok(f.calls.some(call => call.path === '/api/semantica/search'));
  assert.equal((await rpc(input, { host: 'foreign.invalid' })).status, 403);
  assert.equal((await rpc(input, { origin: 'http://127.0.0.1:' + endpoint.port })).status, 403);
  assert.equal((await rpc(input, {}, 'xg_' + 'a'.repeat(43))).status, 403);
  assert.equal((await rpc(input, {}, issued.token, '?warehouse=' + other)).status, 400);
  assert.equal((await rpc({ name: 'owner_graph', arguments: {} })).body.error.message, 'MCP_TOOL_DENIED');
  const before = f.calls.length; f.revoke(); assert.equal((await rpc(input)).status, 403); assert.equal(f.calls.length, before);
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
});
