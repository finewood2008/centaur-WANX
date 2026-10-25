import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createAIDialogue } from '../shell/ai-dialogue.mjs';

function fixture(options = {}) {
  let state = { phase: 'ready', account: { phase: 'authenticated', accountId: 'synthetic-owner', clientId: 'synthetic-client' }, connection: { deviceId: 'synthetic-box', gatewayURL: 'http://127.0.0.1' } };
  const records=new Map();let recentOpened=null;
  const listeners = new Set(), routes = [], sockets = [], events = [], responses = new Map();
  const history = { thread_id: 'thread-1', messages: [], turn_active: false, hitl_pending: null, artifact_refs: [{ path: 'result.md', agent_id: 'private-default' }] };
  let modelRows = [{ provider_name: 'fixture', model: 'one', name: 'One' }, { provider_name: 'fixture', model: 'two', name: 'Two' }];
  const link = {
    async request(input) {
      routes.push(input);
      if (responses.has(input.path)) return responses.get(input.path)(input);
      let result = {}, status = 200;
      if (input.path === '/api/assistant/profile') result = { agent_id: 'private-default', template_id: 'default', default_model: 'fixture/one' };
      else if(input.path==='/api/assistant/conversations')result={items:[{thread_id:'thread-1',title:'Synthetic'}],recent_conversation_id:recentOpened};
      else if(input.path==='/api/assistant/context/validate'){
        const context=JSON.parse(input.body);if(context.space?.enabled){if(!['all','space','folder'].includes(context.space.selection?.mode)||String(context.space.selection?.folder_id||'').includes('/'))throw Object.assign(Error(),{code:'ASSISTANT_INVALID_INPUT'});context.space.label='Allowed folder';}result={context};
      }
      else if(input.path.startsWith('/api/assistant/conversations/')){
        const opening=input.path.endsWith('/open');const tid=input.path.split('/').at(opening?-2:-1);if(opening)recentOpened=tid;const value=records.get(tid)||{id:tid,active_thread_id:tid,context:{space:{enabled:false},knowledge:{enabled:false,warehouses:[]}},revision:0,versions:[{thread_id:tid,kind:'original'}]};
        if(input.method==='PATCH'){const b=JSON.parse(input.body);if(b.revision!==value.revision)throw Object.assign(Error(),{code:'ASSISTANT_CONVERSATION_CONFLICT'});value.context=b.context||value.context;if(value.context.space?.enabled)value.context.space.label='Allowed folder';value.revision++;records.set(tid,value);}result=value;
      }
      else if (input.path === '/api/providers/resolved') result = modelRows;
      else if (input.path === '/api/preferences') result = {};
      else if (input.path === '/api/providers/active-model') result = { provider_name: 'fixture', model: 'one' };
      else if (input.path === '/api/agents/private-default/threads?limit=10000') result = [{ thread_id: 'thread-1', title: 'Synthetic' }];
      else if (input.path === '/api/dialogue/sessions?limit=10000') result = { sessions: [{ session_id: 'legacy-1', title: 'Legacy synthetic' }] };
      else if (input.path.includes('/history?')) result = history;
      else if (input.path === '/api/agents/private-default/threads' && input.method === 'POST') result = { thread_id: 'thread-1' };
      else if (input.path.startsWith('/api/dialogue/sessions/')) result = { id: 'legacy-1', groups: [] };
      else if (input.path.endsWith('/threads/thread-1') && input.method === 'PATCH') result = {};
      else { status = 404; result = { code: 'NOT_FOUND' }; }
      return { status, headers: {}, body: Buffer.from(JSON.stringify(result)) };
    },
    async openStream({ path }) {
      assert.equal(path, '/api/agents/private-default/chat/ws');
      const socket = new EventEmitter(); socket.readyState = 1; socket.sent = [];
      socket.send = (data, done) => { socket.sent.push(JSON.parse(data)); done?.(); };
      socket.terminate = () => { socket.readyState = 3; socket.emit('close'); };
      sockets.push(socket); return socket;
    },
  };
  const client = { snapshot: () => structuredClone(state), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, applicationConnection: async (id, options) => {
    assert.equal(id, 'centaurai.wanx.dialogue'); assert.deepEqual(options, { backendProductId: 'wanx' }); return link;
  } };
  const service = createAIDialogue({ client, onEvent: event => events.push(event), selectFiles: async () => [], ...options });
  return { service, routes, sockets, events, history, respond(route, handler) { responses.set(route, handler); }, setModels(value) { modelRows = value; }, recoverNetwork(phase) { state.phase = phase; for (const fn of listeners) fn(); }, switchBox() { state.connection.deviceId = 'different-box'; for (const fn of listeners) fn(); } };
}
test('mini handoff keeps trusted attachment metadata and source scope, rejecting stale handles', async () => {
  const sharedUploads = new Map(), f = fixture({sharedUploads}), {scope} = await f.service.action('load');
  sharedUploads.set('uploaded', {key:scope, data:{filename:'synthetic.txt', media_type:'text/plain'}});
  const result = await f.service.action('handoff', {scope, draft:'Synthetic draft', reference:'', attachments:[{handle:'uploaded', name:'forged.html', mediaType:'text/html'}], context:{space:{enabled:true, selection:{mode:'all'}}}});
  assert.equal(result.attachments[0].name, 'synthetic.txt'); assert.equal(result.attachments[0].mediaType, 'text/plain');
  assert.equal(result.context.space.enabled, false);
  await assert.rejects(f.service.action('handoff', {scope, draft:'', reference:'', attachments:[{handle:'forged'}]}), {code:'ASSISTANT_ATTACHMENT_EXPIRED'});
  f.service.close();
});
test('recent conversation follows explicit opens and excludes archived or trashed conversations', async () => {
  const f=fixture();
  f.respond('/api/assistant/conversations',async()=>({status:200,body:Buffer.from(JSON.stringify({items:[{thread_id:'thread-2'},{thread_id:'thread-1'}],recent_conversation_id:'thread-1'}))}));
  const first=await f.service.action('load');assert.equal(first.recentConversationId,'thread-1');
  await f.service.action('open',{scope:first.scope,threadId:'thread-1'});
  assert(!f.routes.some(r=>r.path.endsWith('/open')));
  await f.service.action('open',{scope:first.scope,threadId:'thread-1',trackOpened:true});
  assert(f.routes.some(r=>r.method==='POST'&&r.path==='/api/assistant/conversations/thread-1/open'));
  f.respond('/api/assistant/history',async()=>({status:200,body:Buffer.from('{"entries":{"thread:thread-1":{"status":"trash"}}}')}));
  assert.equal((await f.service.action('load')).recentConversationId,'thread-2');f.service.close();
});

test('native assistant uses the private profile and native model catalog; old histories are reads only', async () => {
  const f = fixture(), result = await f.service.action('load');
  assert.equal(result.agentId, 'private-default'); assert.equal(result.defaultModel, 'fixture/one');
  assert.deepEqual(result.models.map(m => m.id), ['fixture/one', 'fixture/two']);
  assert.equal(result.legacySessions[0].session_id, 'legacy-1');
  await f.service.action('legacy-open', { scope: result.scope, sessionId: 'legacy-1' });
  assert(f.routes.filter(r => r.path.startsWith('/api/dialogue')).every(r => r.method === 'GET'));
  await assert.rejects(f.service.action('open', { scope: 'wrong', threadId: 'thread-1' }), { code: 'DIALOGUE_CONTEXT_CHANGED' });
  f.service.close();
});

test('changing models keeps the same thread; a turn is sent once and cancellation is explicit', async () => {
  const f = fixture(), { scope } = await f.service.action('load');
  await f.service.action('model', { scope, threadId: 'thread-1', model: 'fixture/two' });
  const result = await f.service.action('send', { scope, threadId: 'thread-1', model: 'fixture/two', prompt: 'Synthetic next step', attachments: [] });
  assert.equal(result.threadId, 'thread-1');
  assert.equal(f.routes.filter(r => r.path === '/api/agents/private-default/threads' && r.method === 'POST').length, 0);
  const socket = f.sockets.at(-1);
  assert.deepEqual(socket.sent.at(-1).mcp_servers, []);
  assert.equal(socket.sent.filter(frame => frame.type === 'user_turn').length, 1);
  assert.equal(socket.sent.at(-1).model, 'fixture/two');
  assert.equal(socket.sent.at(-1).thread_id, 'thread-1');
  assert(!f.routes.some(r => r.path.includes('/active-model') && r.method !== 'GET'));
  await f.service.action('stop', { scope, threadId: 'thread-1' }); assert.equal(socket.sent.at(-1).type, 'cancel');
  socket.terminate();
  await f.service.action('open', { scope, threadId: 'thread-1' }); await f.service.action('watch', { scope, threadId: 'thread-1' });
  assert.equal(f.sockets.at(-1).sent.filter(frame => frame.type === 'user_turn').length, 0);
  f.service.close();
});

test('account and box changes revoke sockets and reject stale attachment and thread actions', async () => {
  const f = fixture(), { scope } = await f.service.action('load');
  await f.service.action('watch', { scope, threadId: 'thread-1' });
  f.switchBox(); assert.equal(f.sockets[0].readyState, 3); assert.equal(f.events.at(-1).type, 'invalidated');
  await assert.rejects(f.service.action('send', { scope, prompt: 'stale', model: 'fixture/one' }), { code: 'DIALOGUE_CONTEXT_CHANGED' });
  f.service.close();
});

test('unavailable models, running turns, forged upload handles and forged artifacts never dispatch turns', async () => {
  const f = fixture(), { scope } = await f.service.action('load');
  f.setModels([]);
  await assert.rejects(f.service.action('send', { scope, threadId: 'thread-1', prompt: 'keep draft', model: 'fixture/one' }), { code: 'MODEL_UNAVAILABLE' });
  f.setModels([{ provider_name: 'fixture', model: 'one' }]); f.history.turn_active = true;
  await assert.rejects(f.service.action('send', { scope, threadId: 'thread-1', prompt: 'busy', model: 'fixture/one' }), { code: 'ASSISTANT_TURN_ACTIVE' });
  await assert.rejects(f.service.action('send', { scope, threadId: 'thread-1', prompt: 'bad file', model: 'fixture/one', attachments: ['/etc/passwd'] }), { code: 'ASSISTANT_ATTACHMENT_EXPIRED' });
  await assert.rejects(f.service.action('artifact', { scope, threadId: 'thread-1', path: '/etc/passwd' }), { code: 'ASSISTANT_ARTIFACT_DENIED' });
  assert.equal(f.sockets.length, 0); f.service.close();
});


test('tool decisions resume through native SSE without dispatching a new user turn', async () => {
  const f = fixture(), { scope } = await f.service.action('load');
  f.history.hitl_pending = { action_requests: [{ name: 'read_file', args: { path: 'synthetic.txt' } }], review_configs: [{ action_name: 'read_file', allowed_decisions: ['approve', 'reject'] }] };
  f.respond('/api/agents/private-default/chat/hitl/resume', async input => {
    const body = JSON.parse(input.body);
    assert.deepEqual(body, { thread_id: 'thread-1', decisions: [{ type: 'approve' }] });
    assert(!Object.hasOwn(body, 'hitl_policy'));
    return { status: 200, headers: {}, body: Readable.from([Buffer.from('data: {"type":"token","content":"resumed"}\n\ndata: {"type":"done"}\n\n')]) };
  });
  await f.service.action('resume', { scope, threadId: 'thread-1', decisions: [{ type: 'approve' }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(f.events.some(e => e.type === 'assistant-event' && e.event.content === 'resumed'));
  assert.equal(f.sockets.length, 0);
  await assert.rejects(f.service.action('resume', { scope, threadId: 'thread-1', decisions: [{ type: 'allow_all' }] }), { code: 'ASSISTANT_INVALID_INPUT' });
  f.service.close();
});


test('temporary network recovery keeps the same owner scope instead of invalidating drafts and staged uploads', async () => {
  const f = fixture(), { scope } = await f.service.action('load');
  f.recoverNetwork('recovering');
  assert(!f.events.some(e => e.type === 'invalidated'));
  f.recoverNetwork('ready');
  const restored = await f.service.action('load'); assert.equal(restored.scope, scope);
  f.service.close();
});

test('space access requires explicit selection, stays in main, and is selected for each enabled turn', async () => {
  const f = fixture(), { scope } = await f.service.action('load');
  await assert.rejects(f.service.action('send', { scope, threadId: 'thread-1', model: 'fixture/one', prompt: 'Synthetic', spaceEnabled: true }), { code: 'ASSISTANT_SPACE_SCOPE_REQUIRED' });
  const grantCalls = [];
  f.respond('/api/assistant/space-grant', async input => {
    const body = JSON.parse(input.body); grantCalls.push(body);
    return { status: 200, body: Buffer.from(JSON.stringify(body.enabled ? { enabled: true, grant_id: 'a'.repeat(32), mcp_server: 'synthetic-space', label: 'Allowed folder', selection: { mode: 'folder', space_id: 'personal', folder_id: 'b'.repeat(32) } } : { enabled: false })) };
  });
  const choice = await f.service.action('space-grant', { scope, threadId:'thread-1',enabled: true, selection: { mode: 'folder', space_id: 'personal', folder_id: 'b'.repeat(32) } });
  assert.equal(choice.label, 'Allowed folder'); assert.equal(choice.grant_id, undefined); assert.equal(choice.mcp_server, undefined);
  await f.service.action('send', { scope, threadId: 'thread-1', model: 'fixture/one', prompt: 'Synthetic', spaceEnabled: true });
  assert.deepEqual(f.sockets.at(-1).sent.at(-1).mcp_servers, ['synthetic-space']);
  assert.equal(grantCalls.at(-1).thread_id, 'thread-1');
  await f.service.action('model', { scope, threadId: 'thread-1', model: 'fixture/two' });
  await f.service.action('send', { scope, threadId: 'thread-1', model: 'fixture/two', prompt: 'Continue', spaceEnabled: true });
  assert.deepEqual(f.sockets.at(-1).sent.at(-1).mcp_servers, ['synthetic-space']);
  await f.service.action('space-grant', { scope,threadId:'thread-1',enabled: false });
  await f.service.action('send', { scope, threadId: 'thread-1', model: 'fixture/two', prompt: 'Without space', spaceEnabled: false });
  assert.deepEqual(f.sockets.at(-1).sent.at(-1).mcp_servers, []);
  await assert.rejects(f.service.action('space-grant', { scope, threadId:'thread-1',enabled: true, selection: { mode: 'folder', space_id: 'personal', folder_id: '../outside' } }), { code: 'ASSISTANT_INVALID_INPUT' });
  f.service.close();
});

for (const edition of ['personal','team']) test(edition + ' persists explicit knowledge settings and combines sources per turn', async () => {
  let saved = null;
  const store = { load: async () => saved, save: async value => { saved = structuredClone(value); } };
  const f = fixture({ edition, preferenceStore: store });
  const { scope } = await f.service.action('load');
  const wid = '11111111-1111-4111-8111-111111111111';
  const respond = value => ({status: 200, headers: {}, body: Buffer.from(JSON.stringify(value))});
  let created = 0;
  f.respond('/api/assistant/space-grant', async input => { const b = JSON.parse(input.body); return respond(b.enabled ? {enabled:true,grant_id:'space-private',mcp_server:'space-tools',selection:{mode:'all'},label:'全部空间'} : {enabled:false}); });
  f.respond('/api/assistant/knowledge-grant', async input => { const b = JSON.parse(input.body); if(b.warehouses) created++; return respond(b.enabled ? {enabled:true,grant_id:'knowledge-private',mcp_server:'knowledge-tools',warehouses:[{id:wid,name:'Synthetic warehouse'}]} : {enabled:false}); });
  await f.service.action('model', { scope, model:'fixture/two' });
  await f.service.action('space-grant', { scope, enabled:true, selection:{mode:'all'},threadId:'thread-1' });
  const choice = await f.service.action('knowledge-grant', { scope, enabled:true, warehouses:[wid],threadId:'thread-1' });
  assert(!JSON.stringify(choice).includes('knowledge-private'));
  assert(f.routes.filter(r=>r.path.startsWith('/api/assistant/knowledge')).every(r=>r.headers['x-wanx-data-context']===edition));
  await f.service.action('send', {scope,threadId:'thread-1',model:'fixture/two',prompt:'synthetic',spaceEnabled:true,knowledgeEnabled:true});
  assert.deepEqual(f.sockets.at(-1).sent.at(-1).mcp_servers,['space-tools','knowledge-tools']);
  await f.service.action('release-context', {scope});
  const loaded = await f.service.action('load');
  assert.equal(loaded.settings.space.enabled,false); assert.equal(loaded.settings.knowledge.enabled,false); assert.equal(loaded.defaultModel,'fixture/two');
  await f.service.action('send', {scope,threadId:'thread-1',model:'fixture/two',prompt:'next',spaceEnabled:true,knowledgeEnabled:true});
  assert.equal(created,1);
  f.service.close();
});

test('revocation while knowledge renewal is pending prevents dispatch', async () => {
  const f = fixture({edition:'team'}), {scope} = await f.service.action('load');
  const wid='11111111-1111-4111-8111-111111111111';
  let release, entered; const waiting=new Promise(r=>entered=r);
  const value={enabled:true,grant_id:'private-grant',mcp_server:'knowledge-tools',warehouses:[{id:wid,name:'Synthetic'}]};
  const response=v=>({status:200,headers:{},body:Buffer.from(JSON.stringify(v))});
  f.respond('/api/assistant/knowledge-grant', async input=>{const b=JSON.parse(input.body);if(b.enabled&&b.grant_id){entered();await new Promise(r=>release=r);}return response(b.enabled?value:{enabled:false});});
  await f.service.action('knowledge-grant',{scope,enabled:true,warehouses:[wid],threadId:'thread-1'});
  await f.service.action('send',{scope,threadId:'thread-1',model:'fixture/one',prompt:'first',knowledgeEnabled:true});
  const sending=f.service.action('send',{scope,threadId:'thread-1',model:'fixture/one',prompt:'synthetic',knowledgeEnabled:true});
  await waiting; await f.service.action('knowledge-grant',{scope,enabled:false,threadId:'thread-1'}); release();
  await assert.rejects(sending,{code:'ASSISTANT_KNOWLEDGE_DENIED'}); assert.equal(f.sockets.at(-1).sent.filter(x=>x.type==='user_turn').length,1); f.service.close();
});


test('conversation sources survive reopening but never initialize another conversation or global preferences', async()=>{
  let saved;
  const f=fixture({preferenceStore:{load:async()=>saved,save:async v=>saved=v}}),{scope}=await f.service.action('load');
  await f.service.action('space-grant',{scope,threadId:'thread-1',enabled:true,selection:{mode:'all'}});
  const opened=await f.service.action('open',{scope,threadId:'thread-1'});
  assert.equal(opened.conversation.context.space.enabled,true);
  await f.service.action('release-context',{scope});
  const other=await f.service.action('open',{scope,threadId:'thread-2'});
  assert.equal(other.conversation.context.space.enabled,false);
  const restored=await f.service.action('open',{scope,threadId:'thread-1'});
  assert.equal(restored.conversation.context.space.enabled,true);
  assert.equal(saved,undefined);
  f.service.close();
});

test('usage forwarding includes counts and call identity but no arbitrary event fields',async()=>{
 const f=fixture(),{scope}=await f.service.action('load');
 await f.service.action('watch',{scope,threadId:'thread-1'});
 f.sockets[0].emit('message',Buffer.from(JSON.stringify({type:'usage',call_id:'call-1',model:'fixture/one',usage:{input_tokens:100,output_tokens:10,api_key:'private'},secret:'private'})));
 const frame=f.events.at(-1).event;
 assert.equal(frame.call_id,'call-1');assert.deepEqual(frame.usage,{input_tokens:100,output_tokens:10});assert(!JSON.stringify(frame).includes('private'));f.service.close();
});
