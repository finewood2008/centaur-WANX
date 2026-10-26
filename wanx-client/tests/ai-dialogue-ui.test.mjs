import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import electron from 'electron';
const source = await readFile(new URL('../local-ui/renderer/ai-dialogue.js', import.meta.url), 'utf8');

test('dialogue transcript follows only chosen ancestors and generated content stays text', () => {
  const window = {}; vm.runInNewContext(source, { window });
  assert.equal(window.wanxDialogueState.isLocalModel({ name: 'Qwen', is_local: true }), true);
  assert.equal(window.wanxDialogueState.isLocalModel({ name: 'Qwen', is_local: false }), false);
  assert.equal(window.wanxDialogueState.isLocalModel({ name: 'Qwen · 本机', provider: 'Ollama' }), false);
  assert.equal(window.wanxDialogueState.isLocalModel({ name: 'Qwen', provider: '通义千问' }), false);
  const session = { groups: [{ id: 'g1', prompt: 'p1', answers: [{ id: 'a', model: 'm1' }, { id: 'sibling', model: 'm2' }] }, { id: 'g2', parent_answer: 'a', prompt: 'p2', answers: [{ id: 'b', model: 'm3' }] }] };
  assert.deepEqual(Array.from(window.wanxDialogueState.trail(session, 'b'), row => row.answer.id), ['a', 'b']);
  const markup = window.wanxDialogueState.richText('<img src=x onerror="evil()">\n```html\n<script>evil()</script>\n```');
  assert.doesNotMatch(markup, /<img|<script/);
  assert.match(markup, /&lt;script&gt;/);
});

test('native assistant follows local device identity independently of cloud login and clears locked contexts', async () => {
  const window = {}; vm.runInNewContext(source, { window, clearTimeout });
  const calls = [];
  let loads = 0;
  const view = window.createAIDialogueView({ request: async (action, input) => {
    calls.push({ action, input });
    return { ok: true, value: action === 'dialogue.load' ? {
      scope: `local-scope-${++loads}`, models: [], sessions: [], legacySessions: [],
    } : {} };
  } });
  const local = {
    phase: 'ready', canLaunchApplications: true, activeDeviceId: 'local-box',
    account: { phase: 'signed_out' }, dataIdentity: { profileId: 'local-profile' },
    dataContextId: 'local-generation-1', connection: { deviceId: 'local-box' },
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  view.hostState(local);
  view.visible(true);
  await flush();
  assert.equal(loads, 1, 'trusted local devices can open the assistant without cloud login');
  view.hostState({ ...local, account: { phase: 'authenticated', accountId: 'cloud-account' } });
  await flush();
  assert.equal(loads, 1, 'signing into billing does not replace the local assistant context');
  view.hostState({ ...local, dataContextId: 'local-generation-2' });
  await flush();
  assert.equal(loads, 2);
  assert.equal(calls.find(call => call.action === 'dialogue.unwatch').input.scope, 'local-scope-1');
  const locked = { ...local, dataContextId: null, canLaunchApplications: false,
    account: { phase: 'authenticated', accountId: 'cloud-account' } };
  view.hostState(locked);
  await flush();
  assert.deepEqual(calls.filter(call => call.action === 'dialogue.unwatch').map(call => call.input.scope), ['local-scope-1', 'local-scope-2']);
  view.hostState({ ...locked, canLaunchApplications: true });
  view.visible(false);
  view.visible(true);
  await flush();
  assert.equal(loads, 2, 'a cloud account cannot open a locked local identity');
  view.hostState({ ...local, dataContextId: 'local-generation-3', canLaunchApplications: false });
  await flush();
  assert.equal(loads, 2, 'connection authorization remains required for local identities');
  view.hostState({ ...local, dataContextId: 'local-generation-3' });
  await flush();
  assert.equal(loads, 3, 'unlocking starts a fresh assistant context');
});

test('native assistant keeps its conversation on model switch, keeps drafts and clears old accounts', {
  skip: process.env.WANX_TEST_ELECTRON !== '1', timeout: 30000,
}, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'wanx-ai-dialogue-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(electron, [fileURLToPath(new URL('./support/electron-ai-dialogue.mjs', import.meta.url)), `--user-data-dir=${profile}`], { env, timeout: 25000 });
  assert.match(stdout, /AI_DIALOGUE_UI_PASS/);
});
