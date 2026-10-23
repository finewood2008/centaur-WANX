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
  assert.equal(window.wanxDialogueState.isLocalModel({ name: 'Qwen · 本机', provider: 'Ollama' }), true);
  assert.equal(window.wanxDialogueState.isLocalModel({ name: 'Qwen', provider: '通义千问' }), false);
  const session = { groups: [{ id: 'g1', prompt: 'p1', answers: [{ id: 'a', model: 'm1' }, { id: 'sibling', model: 'm2' }] }, { id: 'g2', parent_answer: 'a', prompt: 'p2', answers: [{ id: 'b', model: 'm3' }] }] };
  assert.deepEqual(Array.from(window.wanxDialogueState.trail(session, 'b'), row => row.answer.id), ['a', 'b']);
  const markup = window.wanxDialogueState.richText('<img src=x onerror="evil()">\n```html\n<script>evil()</script>\n```');
  assert.doesNotMatch(markup, /<img|<script/);
  assert.match(markup, /&lt;script&gt;/);
});

test('compact native UI starts a new conversation on model switch, keeps drafts and clears old accounts', {
  skip: process.env.WANX_TEST_ELECTRON !== '1', timeout: 30000,
}, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'wanx-ai-dialogue-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const { stdout } = await promisify(execFile)(electron, [fileURLToPath(new URL('./support/electron-ai-dialogue.mjs', import.meta.url)), `--user-data-dir=${profile}`], { env, timeout: 25000 });
  assert.match(stdout, /AI_DIALOGUE_UI_PASS/);
});
