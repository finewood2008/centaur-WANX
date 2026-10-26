import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const window = {};
vm.runInNewContext(await readFile(new URL('../integration/team-client/ai-dialogue.js', import.meta.url), 'utf8'), { window, URL });
const { markdown, historyMessages, applyFrame, legacyReference, historyItems } = window.wanxAssistantState;

test('Markdown supports working text and code while escaping active content', () => {
  const html = markdown('# Heading\n- First\n- Second\n```js\n<script>alert(1)</script>\n```\n[unsafe](javascript:alert(1))\n<img src=x onerror=alert(1)>\n[docs](https://example.com/)');
  assert(html.includes('<h3>Heading</h3>')); assert(html.includes('<ul>')); assert(html.includes('复制代码'));
  assert(!html.includes('<script>')); assert(!html.includes('<img')); assert(!html.includes('href="javascript:'));
  assert(html.includes('href="https://example.com/"')); assert(html.includes('&lt;script&gt;'));
});

test('streamed answers retain their sent model even when the next model changes', () => {
  const s = { messages: [], active: true, pending: null, runModel: 'fixture/one', sequence: 0 };
  applyFrame(s, { type: 'token', content: 'first' });
  s.selected = 'fixture/two'; applyFrame(s, { type: 'token', content: ' answer' });
  assert.equal(s.messages[0].model, 'fixture/one'); assert.equal(s.messages[0].text, 'first answer');
  applyFrame(s, { type: 'done' }); assert.equal(s.active, false);
  s.runModel = 'fixture/two'; applyFrame(s, { type: 'token', content: 'second' });
  assert.equal(s.messages[1].model, 'fixture/two');
});

test('native history projects per-turn model attribution and tool results', () => {
  const rows = historyMessages([
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'one' }], composer_context: { model: 'fixture/one' } },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
    { id: 'u2', role: 'user', content: 'two', composer_context: { model: 'fixture/two' } },
    { id: 't1', role: 'tool', content: [{ type: 'tool_result', id: 'call-1', name: 'read_file', output: 'synthetic material' }] },
    { id: 'a2', role: 'assistant', content: 'second reply' },
  ]);
  assert.equal(rows.find(m => m.id === 'a1').model, 'fixture/one');
  assert.equal(rows.find(m => m.id === 'a2').model, 'fixture/two');
  assert.equal(rows.find(m => m.role === 'tool').text, 'synthetic material');
});

test('legacy continuation copies only the chosen branch and never mutates the source', () => {
  const session = { title: 'Synthetic legacy', groups: [
    { id: 'g1', prompt: 'Start', answers: [{ id: 'a1', name: 'One', text: 'first' }, { id: 'a2', name: 'Two', text: 'other branch' }] },
    { id: 'g2', parent_answer: 'a1', prompt: 'Continue', answers: [{ id: 'a3', name: 'One', text: 'chosen continuation' }] },
  ] };
  const original = JSON.stringify(session), text = legacyReference(session, 'a3');
  assert(text.includes('来自旧版对话的历史参考')); assert(text.includes('chosen continuation')); assert(!text.includes('other branch'));
  assert.equal(JSON.stringify(session), original);
});

test('history aliases, pins, archive and trash filters never mutate source records', () => {
  const sessions = [{ thread_id: 'one', title: 'Original one', last_active: 1 }, { thread_id: 'two', title: 'Original two', last_active: 2 }];
  const legacy = [{ session_id: 'old', title: 'Original legacy', updated_at: 3 }], original = JSON.stringify([sessions, legacy]);
  const metadata = { 'thread:one': { title: 'Renamed synthetic', pinned: true }, 'thread:two': { status: 'trash' }, 'legacy:old': { status: 'archived' } };
  assert.equal(historyItems(sessions, legacy, metadata, { status: 'active', query: 'SYNTHETIC' })[0].id, 'one');
  assert.equal(historyItems(sessions, legacy, metadata, { status: 'trash' })[0].id, 'two');
  assert.equal(historyItems(sessions, legacy, metadata, { status: 'archived', kind: 'legacy' })[0].id, 'old');
  assert.equal(historyItems(sessions, legacy, metadata)[0].id, 'one');
  assert.equal(historyItems(sessions, legacy, {}, { sort: 'oldest' })[0].id, 'one');
  assert.equal(JSON.stringify([sessions, legacy]), original);
});


test('usage replay replaces a call and preserves latest input separately from turn consumption',()=>{
 const state={messages:[{id:'u',role:'user',text:'q'}],runModel:'fixture/one',sequence:0};
 applyFrame(state,{type:'token',content:'answer'});
 const call={type:'usage',call_id:'call-1',model:'fixture/one',usage:{input_tokens:100,output_tokens:10,total_tokens:110}};
 applyFrame(state,call);applyFrame(state,call);
 applyFrame(state,{...call,call_id:'call-2',usage:{input_tokens:130,output_tokens:20,total_tokens:150}});
 assert.equal(state.messages.at(-1).usage.input_tokens,230);
 assert.equal(state.messages.at(-1).usage.last_input_tokens,130);
 assert.equal(state.messages.at(-1).usage.model_calls,2);
});

test('history pagination rolls up raw calls once and suppresses incomplete leading turns',()=>{
 const {rollupUsage}=window.wanxAssistantState;
 const rows=[{id:'partial',role:'assistant',callUsage:{input_tokens:90}},{id:'user',role:'user'},{id:'tool-call',role:'usage',callUsage:{input_tokens:100,output_tokens:5}},{id:'final',role:'assistant',callUsage:{input_tokens:120,output_tokens:20}}];
 rollupUsage(rows,false);assert.equal(rows[0].usage,undefined);assert.equal(rows.at(-1).usage.input_tokens,220);
 rollupUsage(rows,false);assert.equal(rows.at(-1).usage.input_tokens,220);
});
