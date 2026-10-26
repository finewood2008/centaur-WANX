import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAIDialogue } from '../shell/ai-dialogue.mjs';
import { createAIDialogue as createCloudAssistant } from '../shell/assistant-service.mjs';
import { createSpaceLinkBridge } from '../shell/space-links.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
const connectionId = 'a'.repeat(32);

function fixture() {
  const state = { phase: 'ready', account: { phase: 'signed_out' },
    connection: { authorization: 'local-trust-v1', deviceId: 'box-1', url: 'https://local-box.test/', mode: 'local' },
    dataIdentity: { phase: 'unlocked', profileId: 'profile-1', clientId: 'client-1', generation: 1,
      selected: { boxId: 'box-1', boxKeyThumbprint: 'box-key', ownershipEpoch: 1,
        principalId: 'principal-1', bindingId: 'binding-1', authorizationVersion: 1, sessionId: 'session-1' } } };
  const listeners = new Set(), calls = [], links = [], sockets = [], copies = [], events = [];
  let saved, connect, handler, saveHandler;
  function newLink() {
    const link = { closed: false, close() { this.closed = true; }, async request(input) {
      calls.push(input);
      if (handler) { const value = await handler(input); if (value) return value; }
      if (input.path === '/api/assistant/profile') return response({ agent_id: 'private-agent', default_model: 'fixture/one' });
      if (input.path === '/api/providers/resolved') return response([{ provider_name: 'fixture', model: 'one' }, { provider_name: 'fixture', model: 'two' }]);
      if (input.path === '/api/providers/active-model') return response({ provider_name: 'fixture', model: 'one' });
      if (input.path === '/api/preferences') return response({});
      if (input.path === '/api/assistant/conversations') return response({ items: [{ thread_id: 'thread-1' }] });
      if (input.path === '/api/assistant/history') return response({ entries: {} });
      if (input.path === '/api/dialogue/sessions?limit=10000') return response({ sessions: [] });
      if (input.path === '/api/settings/timezone') return response({ timezone: 'Asia/Shanghai' });
      if (input.path.includes('/history?')) return response({ messages: [], turn_active: false });
      if (input.path.startsWith('/api/assistant/knowledge/sources/')) return response({ sources: [] });
      if (input.path === '/api/_client/space-mcp/connections') return response({ id: connectionId, status: 'active' });
      if (input.path.startsWith('/api/_client/space-mcp?')) return response({ connections: [{ id: connectionId, status: 'active' }], archives: [] });
      throw new Error('Unexpected route: ' + input.path);
    }, async openStream({ path }) {
      assert.equal(path, '/api/agents/private-agent/chat/ws');
      const socket = new EventEmitter(); socket.readyState = 1;
      socket.send = (_frame, done) => done?.();
      socket.terminate = () => { socket.readyState = 3; socket.emit('close'); };
      sockets.push(socket); return socket;
    } };
    links.push(link); return link;
  }
  const client = { snapshot: () => structuredClone(state),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    applicationConnection: (...args) => connect ? connect(...args) : newLink() };
  const store = { load: async () => saved, save: async value => { if (saveHandler) await saveHandler(value); saved = structuredClone(value); } };
  return { client, store, calls, links, sockets, copies, events, newLink,
    get saved() { return saved; },
    change(update) { update(state); for (const listener of listeners) listener(); },
    connectWith(value) { connect = value; }, respondWith(value) { handler = value; }, saveWith(value) { saveHandler = value; },
    assistant() { return createAIDialogue({ client, preferenceStore: store, onEvent: event => events.push(event) }); },
    bridge() { return createSpaceLinkBridge({ client, store, serviceURL: 'https://consumer.test', copyText: async value => copies.push(value), agentHubOptions: { team: true } }); },
  };
}

test('team native assistant works without cloud login while shared cloud scope stays closed', async t => {
  const f = fixture(), service = f.assistant(); t.after(() => service.close());
  const loaded = await service.action('load');
  assert.equal(loaded.agentId, 'private-agent'); assert.equal(loaded.timezone, 'Asia/Shanghai');
  assert.deepEqual(loaded.capabilities, { knowledge: false, space: false, channels: false, attachments: false });
  assert(f.calls.some(call => call.path === '/api/assistant/profile'));
  assert(f.calls.some(call => call.path === '/api/assistant/conversations'));
  const cloud = createCloudAssistant({ client: f.client }); t.after(() => cloud.close());
  await assert.rejects(cloud.action('load'), { code: 'BOX_CONNECTION_REQUIRED' });
});

test('assistant model choice survives same owner renewal and stays isolated from another local principal', async t => {
  const f = fixture(), service = f.assistant(); t.after(() => service.close());
  const first = await service.action('load');
  await service.action('model', { scope: first.scope, model: 'fixture/two' });
  f.change(state => { state.dataIdentity.selected.sessionId = 'session-2'; });
  const renewed = await service.action('load');
  assert.notEqual(renewed.scope, first.scope); assert.equal(renewed.defaultModel, 'fixture/two');
  assert.equal(Object.keys(f.saved.assistantConfigurations).length, 1);
  await assert.rejects(service.action('model', { scope: first.scope, model: 'fixture/one' }), { code: 'DIALOGUE_CONTEXT_CHANGED' });
  f.change(state => { state.dataIdentity.selected.principalId = 'principal-2'; });
  assert.equal((await service.action('load')).defaultModel, 'fixture/one');
  f.change(state => { state.dataIdentity.phase = 'locked'; state.account = { phase: 'authenticated', accountId: 'cloud-owner' }; });
  await assert.rejects(service.action('load'), { code: 'BOX_CONNECTION_REQUIRED' });
});

test('local assistant history does not query the unavailable cloud knowledge service', async t => {
  const f = fixture(), service = f.assistant(); t.after(() => service.close());
  f.respondWith(input => {
    if (input.path === '/api/assistant/conversations/thread-1') return response({ id: 'thread-1', active_thread_id: 'thread-1', versions: [{ thread_id: 'thread-1' }] });
    if (input.path.startsWith('/api/assistant/knowledge/')) throw Object.assign(new Error('Denied local route'), { code: 'LOCAL_DATA_ROUTE_DENIED' });
  });
  const { scope } = await service.action('load');
  const opened = await service.action('open', { scope, threadId: 'thread-1' });
  assert.deepEqual(opened.history.knowledge_sources, []);
  assert(!f.calls.some(call => call.path.startsWith('/api/assistant/knowledge/')));
});

for (const local of [true, false]) test(`${local ? 'local' : 'cloud'} file spaces honor the native MCP authorization boundary`, async t => {
  const f = fixture();
  if (!local) f.change(state => {
    delete state.dataIdentity; delete state.connection.authorization;
    state.account = { phase: 'authenticated', accountId: 'cloud-owner', clientId: 'cloud-client' };
  });
  f.respondWith(input => {
    if (input.path === '/api/personal-space/spaces') return response([{ id: 'personal' }, { id: 'company' }]);
    if (input.path === '/api/_client/space-mcp/drives') {
      if (local) throw Object.assign(new Error('Denied local route'), { code: 'LOCAL_DATA_ROUTE_DENIED' });
      return response([{ id: connectionId }]);
    }
  });
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const spaces = await bridge.manage('spaces');
  assert.deepEqual(spaces, (local ? ['personal'] : ['personal', connectionId]).map(id => ({ id, connections: [] })));
  assert.equal(f.calls.some(call => call.path === '/api/_client/space-mcp/drives'), !local);
});

for (const field of ['principalId', 'bindingId', 'sessionId', 'authorizationVersion', 'ownershipEpoch', 'boxKeyThumbprint']) {
  test(`assistant revokes native streams when local ${field} changes`, async t => {
    const f = fixture(), service = f.assistant(); t.after(() => service.close());
    const { scope } = await service.action('load');
    await service.action('watch', { scope, threadId: 'thread-1' });
    f.change(state => { const selected = state.dataIdentity.selected; selected[field] = typeof selected[field] === 'number' ? selected[field] + 1 : selected[field] + '-next'; });
    await tick();
    assert.equal(f.sockets[0].readyState, 3); assert.equal(f.links[0].closed, true);
    assert.equal(f.events.at(-1).type, 'invalidated');
    await assert.rejects(service.action('watch', { scope, threadId: 'thread-1' }), { code: 'DIALOGUE_CONTEXT_CHANGED' });
  });
}

test('assistant closes a late derived connection before dispatch after local identity changes', async t => {
  const f = fixture(), pending = deferred(); f.connectWith(() => pending.promise);
  const service = f.assistant(); t.after(() => service.close());
  const load = service.action('load'); await tick();
  f.change(state => { state.dataIdentity.generation++; });
  const link = f.newLink(); pending.resolve(link);
  await assert.rejects(load, { code: 'DIALOGUE_CONTEXT_CHANGED' });
  assert.equal(link.closed, true); assert.equal(f.calls.length, 0);
});

test('assistant aborts an in-flight request and rejects its delayed response on lock', async t => {
  const f = fixture(), pending = deferred();
  f.respondWith(input => input.path === '/api/assistant/profile' ? pending.promise : undefined);
  const service = f.assistant(); t.after(() => service.close());
  const load = service.action('load'); await tick();
  f.change(state => { state.dataIdentity.phase = 'locked'; });
  assert.equal(f.calls[0].signal.aborted, true);
  pending.resolve(response({ agent_id: 'old-private-agent' }));
  await assert.rejects(load, { code: 'DIALOGUE_CONTEXT_CHANGED' });
});

test('server MCP keys survive local session renewal but are hidden from another principal and a locked identity', async t => {
  const f = fixture(), bridge = await f.bridge(); t.after(() => bridge.close());
  const created = await bridge.manage('mcp-issue', { name: 'Local integration' });
  const key = f.saved.spaceMcp[0].credential;
  assert.equal(created.id, connectionId); assert(!JSON.stringify(created).includes(key));
  assert.equal(JSON.parse(f.calls[0].body).destination, 'company');
  f.change(state => { state.dataIdentity.selected.sessionId = 'session-2'; });
  await bridge.manage('mcp-copy', { id: connectionId, kind: 'key' });
  assert.equal(f.copies[0], key); assert.equal(f.saved.spaceMcp.length, 1);
  assert.equal((await bridge.mcpDetails()).url, 'https://local-box.test/mcp/space');
  f.change(state => { state.dataIdentity.selected.principalId = 'principal-2'; });
  assert.equal((await bridge.manage('mcp-state')).connections[0].localKey, false);
  await assert.rejects(bridge.manage('mcp-copy', { id: connectionId, kind: 'key' }), { code: 'MCP_KEY_NOT_ON_THIS_CLIENT' });
  f.change(state => { state.dataIdentity.phase = 'locked'; });
  const before = f.calls.length;
  await assert.rejects(bridge.manage('mcp-state'), { code: 'BOX_CONNECTION_REQUIRED' });
  assert.equal(f.calls.length, before);
});

test('server MCP refuses dispatch through a delayed connection from an earlier local session', async t => {
  const f = fixture(), pending = deferred(); f.connectWith(() => pending.promise);
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const operation = bridge.manage('mcp-state'); await tick();
  f.change(state => { state.dataIdentity.selected.sessionId = 'session-2'; });
  const link = f.newLink(); pending.resolve(link);
  await assert.rejects(operation, { code: 'SPACE_CONTEXT_CHANGED' });
  assert.equal(f.calls.length, 0); assert.equal(link.closed, true);
});

test('MCP credential persistence cannot resume issuance under a renewed local session', async t => {
  const f = fixture(), pending = deferred(); f.saveWith(() => pending.promise);
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const operation = bridge.manage('mcp-issue', { name: 'Pending integration' }); await tick();
  f.change(state => { state.dataIdentity.selected.sessionId = 'session-2'; }); pending.resolve();
  await assert.rejects(operation, { code: 'SPACE_CONTEXT_CHANGED' }); assert.equal(f.calls.length, 0);
  f.saveWith(null);
  await bridge.manage('mcp-issue', { name: 'Pending integration' });
  assert.equal(f.saved.spaceMcp.length, 1); assert.equal(f.calls.length, 1);
});

test('MCP aborts delayed data and rejects it when the local binding is revoked', async t => {
  const f = fixture(), pending = deferred(); f.respondWith(() => pending.promise);
  const bridge = await f.bridge(); t.after(() => bridge.close());
  const operation = bridge.manage('mcp-state'); await tick();
  f.change(state => { state.dataIdentity.selected.authorizationVersion++; });
  assert.equal(f.calls[0].signal.aborted, true);
  pending.resolve(response({ connections: [{ id: 'previous-principal-data' }] }));
  await assert.rejects(operation, { code: 'SPACE_CONTEXT_CHANGED' });
});
