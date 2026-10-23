import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAIDialogue } from '../shell/ai-dialogue.mjs';

function fixture(preferenceStore) {
  let state = { account: { phase: 'authenticated', accountId: 'a', clientId: 'pc' }, phase: 'ready', connection: { deviceId: 'box-a', gatewayURL: 'http://127.0.0.1:1234' } };
  const listeners = new Set(), calls = [], events = [];
  let respond = input => ({ status: 200, body: Buffer.from(JSON.stringify(input.path.endsWith('/models') ? { models: [{ id: 'a', name: 'DeepSeek', provider: 'deepseek', api_key: 'private' }, { id: 'b', name: 'Claude', provider: 'anthropic' }], capabilities: { model_switch: 1 } } : input.path.endsWith('/sessions') && input.method === 'GET' ? { sessions: [] } : { id: 'session1', revision: 1, groups: [] })) });
  const client = { snapshot: () => structuredClone(state), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, applicationConnection: async (id, options) => { calls.push({ id, options }); return { request: async input => { calls.push(input); return respond(input); } }; } };
  const service = createAIDialogue({ client, preferenceStore, onEvent: value => events.push(value) });
  return { service, calls, events, setResponse(fn) { respond = fn; }, update(patch) { state = { ...state, ...patch }; for (const fn of listeners) fn(); } };
}
test('AI dialogue exposes only public models and constructs fixed scoped requests', async t => {
  const h = fixture(); t.after(() => h.service.close());
  const loaded = await h.service.action('load');
  assert.equal(loaded.models[0].api_key, undefined);
  assert.equal(loaded.capabilities.model_switch, 1);
  await h.service.action('send', { scope: loaded.scope, sessionId: 'session1', answerId: 'answer1', prompt: '继续', models: ['a'], keepModel: true, requestId: '1234567890abcdef' });
  const last = h.calls.at(-1);
  assert.equal(last.path, '/api/dialogue/sessions/session1/answers/answer1/continue');
  assert.deepEqual(JSON.parse(last.body), { request_id: '1234567890abcdef', prompt: '继续' });
  assert.deepEqual(h.calls[0], { id: 'centaurai.wanx.dialogue', options: { backendProductId: 'wanx' } });
  await assert.rejects(h.service.action('send', { scope: loaded.scope, models: ['a'], prompt: 'x', requestId: 'short' }), /DIALOGUE_INVALID_INPUT/);
});
test('switching accounts or boxes aborts old requests and rejects stale writes', async t => {
  const h = fixture(); t.after(() => h.service.close());
  const loaded = await h.service.action('load');
  let finish;
  h.setResponse(input => new Promise(resolve => { finish = () => resolve({ status: 200, body: Buffer.from('{}') }); }));
  const pending = h.service.action('open', { scope: loaded.scope, sessionId: 'session1' });
  await new Promise(resolve => setImmediate(resolve));
  const signal = h.calls.at(-1).signal;
  h.update({ connection: { deviceId: 'box-b', gatewayURL: 'http://127.0.0.1:1235' } });
  assert.equal(signal.aborted, true); finish();
  await assert.rejects(pending, /DIALOGUE_CONTEXT_CHANGED/);
  await assert.rejects(h.service.action('send', { scope: loaded.scope }), /DIALOGUE_CONTEXT_CHANGED/);
  assert.equal(h.events.at(-1).type, 'invalidated');
});
test('watching streams snapshots without dispatching generation requests', async t => {
  const h = fixture(); t.after(() => h.service.close());
  const loaded = await h.service.action('load');
  h.setResponse(() => ({ status: 200, body: Readable.from([Buffer.from('data: {"type":"snapshot","session":{"id":"session1","revision":2,"groups":[]}}\r'), Buffer.from('\n\r'), Buffer.from('\n')]) }));
  await h.service.action('watch', { scope: loaded.scope, sessionId: 'session1' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(h.events.some(e => e.type === 'snapshot' && e.session.revision === 2));
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
});

function preferenceStore() {
  let value = null;
  return { load: async () => structuredClone(value), save: async next => { value = structuredClone(next); } };
}
test('model display choices survive restart and stay isolated by account and box', async t => {
  const store = preferenceStore(), a = fixture(store);
  t.after(() => a.service.close());
  let value = await a.service.action('load');
  assert.equal(value.visibleModelIds, null);
  await a.service.action('preferences', { scope: value.scope, modelIds: ['b'] });
  const restarted = fixture(store); t.after(() => restarted.service.close());
  value = await restarted.service.action('load');
  assert.deepEqual(value.visibleModelIds, ['b']);
  restarted.update({ connection: { deviceId: 'box-b', gatewayURL: 'http://127.0.0.1:4321' } });
  value = await restarted.service.action('load');
  assert.equal(value.visibleModelIds, null);
  await restarted.service.action('preferences', { scope: value.scope, modelIds: ['a'] });
  restarted.update({ connection: { deviceId: 'box-a', gatewayURL: 'http://127.0.0.1:9999' } });
  value = await restarted.service.action('load');
  assert.deepEqual(value.visibleModelIds, ['b'], 'gateway port changes must preserve preferences');
  restarted.update({ account: { phase: 'authenticated', accountId: 'other', clientId: 'pc' } });
  value = await restarted.service.action('load');
  assert.equal(value.visibleModelIds, null, 'another account inherited preferences');
});
test('display settings reject invalid model choices and restore the automatic default', async t => {
  const h = fixture(preferenceStore()); t.after(() => h.service.close());
  let value = await h.service.action('load');
  for (const modelIds of [[], ['missing'], ['a', 'a'], ['a', '<script>']]) {
    await assert.rejects(h.service.action('preferences', { scope: value.scope, modelIds }), /DIALOGUE_INVALID_MODEL_SELECTION/);
  }
  await h.service.action('preferences', { scope: value.scope, modelIds: ['a'] });
  value = await h.service.action('load'); assert.deepEqual(value.visibleModelIds, ['a']);
  await h.service.action('preferences', { scope: value.scope, modelIds: null });
  value = await h.service.action('load'); assert.equal(value.visibleModelIds, null);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0, 'display settings must not change the box');
});
test('failed saves preserve prior choices and stale scopes cannot save for another box', async t => {
  let stored = null, rejectSave = false;
  const store = { load: async () => structuredClone(stored), save: async value => { if (rejectSave) throw new Error('SECURE_STORAGE_WRITE_FAILED'); stored = structuredClone(value); } };
  const h = fixture(store); t.after(() => h.service.close());
  const value = await h.service.action('load');
  await h.service.action('preferences', { scope: value.scope, modelIds: ['b'] });
  rejectSave = true;
  await assert.rejects(h.service.action('preferences', { scope: value.scope, modelIds: ['a'] }), /SECURE_STORAGE_WRITE_FAILED/);
  assert.deepEqual((await h.service.action('load')).visibleModelIds, ['b']);
  h.update({ connection: { deviceId: 'box-b', gatewayURL: 'http://127.0.0.1:9876' } });
  await assert.rejects(h.service.action('preferences', { scope: value.scope, modelIds: ['a'] }), /DIALOGUE_CONTEXT_CHANGED/);
  assert.equal((await h.service.action('load')).visibleModelIds, null);
});

test('client dialogue sends cannot request multiple models', async t => {
  const h = fixture(); t.after(() => h.service.close());
  const loaded = await h.service.action('load');
  await assert.rejects(h.service.action('send', { scope: loaded.scope, prompt: 'test', models: ['a','b'], requestId: 'single-model-request-01' }), /DIALOGUE_INVALID_INPUT/);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
});
