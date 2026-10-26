import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPersonalSpace } from '../shell/personal-space.mjs';
import { createSuperClipboard } from '../shell/super-clipboard.mjs';
import { createAIDialogue } from '../shell/ai-dialogue.mjs';
import { dataOwnerKey } from '../device-trust/data-context.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reply = body => ({ status: 200, body: Buffer.from(JSON.stringify(body)) });
function localState(principalId = 'principal-a', generation = 1) {
  return { phase: 'ready', account: { phase: 'signed_out' },
    connection: { deviceId: 'box-a', authorization: 'local-trust-v1', mode: 'lan' },
    dataIdentity: { phase: 'unlocked', profileId: 'profile-a', clientId: 'client-a', generation,
      selected: { boxId: 'box-a', boxKeyThumbprint: 'box-pin-a', principalId, bindingId: `binding-${principalId}`,
        ownershipEpoch: 1, authorizationVersion: 1, sessionId: `session-${generation}` } } };
}
function clientFixture(respond = () => reply({ protocolVersion: 1 })) {
  let state = localState(); const listeners = new Set();
  return { snapshot: () => structuredClone(state),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update(patch) { state = { ...state, ...patch }; for (const fn of listeners) fn(); },
    lock() { this.update({ dataIdentity: { ...state.dataIdentity, phase: 'locked', generation: state.dataIdentity.generation + 1, selected: null } }); },
    async applicationConnection() { return { context: () => ({}), request: respond }; } };
}
const memoryStore = () => { let value; return { load: async () => structuredClone(value), save: async v => { value = structuredClone(v); } }; };

test('personal space works without cloud login and hides the previous principal immediately', async t => {
  const client = clientFixture();
  const service = await createPersonalSpace({ client, store: memoryStore(), serviceURL: 'cloud-a' });
  t.after(() => service.close());
  await service.refresh(); const first = service.snapshot().scope;
  assert.equal(service.snapshot().overview.protocolVersion, 1);
  client.update({ account: { phase: 'authenticated', accountId: 'another-cloud-account' } });
  assert.equal(service.snapshot().scope, first);
  client.update(localState('principal-b'));
  assert.notEqual(service.snapshot().scope, first);
  assert.equal(service.snapshot().overview, null);
  client.lock();
  assert.equal(service.snapshot().scope, null);
  assert.deepEqual(service.snapshot().tasks, []);
});

test('personal-space response from before lock cannot populate a fresh same-principal session', async t => {
  const held = deferred(), entered = deferred();
  const client = clientFixture(() => { entered.resolve(); return held.promise; });
  const service = await createPersonalSpace({ client, store: memoryStore(), serviceURL: 'cloud' });
  t.after(() => service.close());
  const pending = service.refresh(); await entered.promise;
  client.lock(); client.update(localState('principal-a', 3));
  held.resolve(reply({ protocolVersion: 1, privateData: 'stale' })); await pending;
  assert.equal(service.snapshot().overview, null);
});

test('dialogue preferences follow the local principal and lock aborts late responses', async t => {
  let held, entered;
  const client = clientFixture(input => {
    if (held) { entered.resolve(input.signal); return held.promise; }
    return reply(input.path.endsWith('/models') ? { models: [{ id: 'model-a', name: 'A' }] } : { sessions: [] });
  });
  const service = createAIDialogue({ client, preferenceStore: memoryStore() });
  t.after(() => service.close());
  let value = await service.action('load');
  await service.action('preferences', { scope: value.scope, modelIds: ['model-a'] });
  client.update({ account: { phase: 'authenticated', accountId: 'cloud-b' } });
  assert.deepEqual((await service.action('load')).visibleModelIds, ['model-a']);
  client.update(localState('principal-b'));
  assert.equal((await service.action('load')).visibleModelIds, null);
  client.update(localState('principal-a'));
  value = await service.action('load'); held = deferred(); entered = deferred();
  const pending = service.action('open', { scope: value.scope, sessionId: 'session1' });
  const rejected = assert.rejects(pending, { code: 'DIALOGUE_CONTEXT_CHANGED' });
  const signal = await entered.promise; client.lock();
  assert.equal(signal.aborted, true);
  client.update(localState('principal-a', 3)); held.resolve(reply({ id: 'session1', groups: [] }));
  await rejected;
});

async function clipboardFixture(t, { request, chooseFiles = async () => [] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'local-clipboard-scope-'));
  const client = clientFixture();
  const scope = () => { const owner = dataOwnerKey(client.snapshot(), 'cloud'); return owner ? JSON.stringify([owner, 'box-a']) : null; };
  const service = await createSuperClipboard({ client, directory, deviceName: 'test', serviceURL: 'cloud', store: memoryStore(),
    personalSpace: { snapshot: () => ({ scope: scope() }), clipboardRequest: request || (async () => ({ items: [], usage: {} })) },
    systemClipboard: { read: async () => ({ text: 'test' }) }, chooseFiles, chooseDownload: async () => null });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, service };
}

test('clipboard late reads are aborted and cannot repopulate an unlocked session', async t => {
  const held = deferred(), entered = deferred();
  const { client, service } = await clipboardFixture(t, { request: async (_route, options) => {
    entered.resolve(options.signal); return held.promise;
  } });
  const pending = service.operation('refresh');
  const rejected = assert.rejects(pending, { code: 'SPACE_CONTEXT_CHANGED' });
  const signal = await entered.promise; client.lock();
  assert.equal(signal.aborted, true);
  assert.equal(service.snapshot().scope, null);
  assert.deepEqual(service.snapshot().note.blocks, []);
  client.update(localState('principal-a', 3));
  held.resolve({ items: [{ preview: 'old principal data' }], usage: {} }); await rejected;
  assert.deepEqual(service.snapshot().items, []);
});

test('a native clipboard picker cannot resume after lock and same-principal unlock', async t => {
  const held = deferred();
  const { client, service } = await clipboardFixture(t, { chooseFiles: () => held.promise });
  const pending = service.operation('choose');
  const rejected = assert.rejects(pending, { code: 'SPACE_CONTEXT_CHANGED' });
  client.lock(); client.update(localState('principal-a', 3)); held.resolve([]); await rejected;
  assert.deepEqual(service.snapshot().tasks, []);
});
