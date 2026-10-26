import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { createAssistantChannels } from './assistant-channels.mjs';

export const DIALOGUE_APPLICATION_ID = 'centaurai.wanx.dialogue';
const fail = code => Object.assign(new Error(code), { code });
const identifier = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail('ASSISTANT_INVALID_INPUT');
  return value;
};
const MAX_BYTES = 100 * 1024 * 1024;
const publicModel = m => ({ id: `${m.provider_name}/${m.model}`, name: m.name || m.model,
  provider: m.provider_name, kind: m.provider_kind, input: m.input || ['text'], contextWindow: m.context_window });
const publicUpload = (handle, data, size) => ({ handle, name: data.filename, mediaType: data.media_type, size });

// This service owns the fixed native routes and scoped WebSocket. The renderer
// never supplies an agent, local path, upstream URL, token, or arbitrary API route.
export function createAIDialogue({ client, onEvent = () => {}, selectFiles, saveFile, edition = 'personal', preferenceStore, sharedUploads, resolveDataContext } = {}) {
  let closed = false, channelCache = null, profile = null, watcher = null;
  let catalog = [], generation = 0, configuration = {};
  let preferenceWrites = Promise.resolve(), preferenceMemory = {};
  const conversationCache = new Map(), threadRoots = new Map(), spaceGrants = new Map(), knowledgeGrants = new Map(), fences = new Map();
  const emptyContext = () => ({space:{enabled:false},knowledge:{enabled:false,warehouses:[],data_scope:edition}});
  const rootFor = tid => threadRoots.get(tid) || tid;
  const fence = tid => fences.get(rootFor(tid)) || 0;
  function remember(value) { conversationCache.set(value.id, value); for (const v of value.versions) threadRoots.set(v.thread_id, value.id); return value; }
  async function conversation(key, tid) { return remember(await request(key, '/api/assistant/conversations/' + identifier(rootFor(tid)))); }
  async function setContext(key, tid, delta) {
    const previous = tid ? await conversation(key,tid) : null;
    const context = {...(previous?.context || configuration), ...delta};delete context.model;
    const value = tid ? remember(await request(key, '/api/assistant/conversations/'+previous.id, {method:'PATCH',body:{revision:previous.revision,context}}))
      : {context:(await request(key,'/api/assistant/context/validate',{method:'POST',body:context})).context};
    if(tid) fences.set(rootFor(tid), fence(tid)+1); else configuration=value.context;
    return value;
  }
  async function ensureSpace(key, tid, config) {
    if (!config.space?.enabled) throw fail('SPACE_ACCESS_DENIED');
    const existing = spaceGrants.get(tid), revision = fence(tid);
    let grant;
    try { grant = await request(key, '/api/assistant/space-grant', { method: 'POST', body: { enabled: true,
      ...(existing ? { grant_id: existing.grant_id } : { selection: config.space.selection }), thread_id: tid } }); }
    catch (error) {
      if (error.code !== 'SPACE_ACCESS_DENIED' || revision !== fence(tid)) throw error;
      grant = await request(key, '/api/assistant/space-grant', { method: 'POST', body: { enabled: true, selection: config.space.selection, thread_id: tid } });
    }
    if (revision !== fence(tid)) {
      await request(key, '/api/assistant/space-grant', { method: 'POST', body: { enabled: false, grant_id: grant.grant_id } });
      throw fail('SPACE_ACCESS_DENIED');
    }
    spaceGrants.set(tid, grant);
    return grant;
  }
  async function saveConfiguration(key, delta) {
    const pending = preferenceWrites.catch(() => {}).then(async () => {
      assertScope(key);
      const owner = configurationKey(key);
      const stored = preferenceStore ? await preferenceStore.load() || {} : preferenceMemory;
      assertScope(key);
      const next = { model: delta.model || configuration.model };
      const value = { ...stored, assistantConfigurations: { ...stored.assistantConfigurations, [owner]: next } };
      if (preferenceStore) await preferenceStore.save(value); else preferenceMemory = value;
      assertScope(key); configuration = {...configuration,model:next.model};
    });
    preferenceWrites = pending; return pending;
  }
  async function ensureKnowledge(key, tid, config) {
    if (!config.knowledge?.enabled) throw fail('ASSISTANT_KNOWLEDGE_DENIED');
    const existing = knowledgeGrants.get(tid), revision = fence(tid);
    let grant;
    try { grant = await request(key, '/api/assistant/knowledge-grant', { method: 'POST', body: { enabled: true,
      ...(existing ? { grant_id: existing.grant_id } : { warehouses: config.knowledge.warehouses.map(w => w.id) }), thread_id: tid } }); }
    catch (error) {
      if (error.code !== 'ASSISTANT_KNOWLEDGE_EXPIRED') throw error;
      grant = await request(key, '/api/assistant/knowledge-grant', { method: 'POST', body: { enabled: true, warehouses: config.knowledge.warehouses.map(w => w.id), thread_id: tid } });
    }
    if (revision !== fence(tid)) {
      await request(key, '/api/assistant/knowledge-grant', { method: 'POST', body: { enabled: false, grant_id: grant.grant_id } });
      throw fail('ASSISTANT_KNOWLEDGE_DENIED');
    }
    knowledgeGrants.set(tid, grant);
    return grant;
  }
  const requests = new Set(), uploads = sharedUploads || new Map(), threads = new Set();
  const emit = (key, event) => { if (scope() === key) onEvent({ ...event, scope: key }); };
  function scope() {
    const s = client.snapshot();
    if (closed) return null;
    const context = resolveDataContext?.(s);
    if (context) return context.interactionKey ? createHash('sha256').update(context.interactionKey).digest('hex') : null;
    if (s.account?.phase !== 'authenticated' || !['ready', 'recovering'].includes(s.phase) || !s.connection?.deviceId) return null;
    return createHash('sha256').update(JSON.stringify([s.account.accountId, s.account.clientId, s.connection.deviceId, s.connection.gatewayURL])).digest('hex');
  }
  function configurationKey(key) {
    const context = resolveDataContext?.(client.snapshot());
    return context?.ownerKey ? createHash('sha256').update(context.ownerKey).digest('hex') : key;
  }
  let currentScope = scope();
  const assertScope = key => { if (!key || scope() !== key) throw fail('DIALOGUE_CONTEXT_CHANGED'); };
  const channelLinks = new Map();
  const assistantChannels = createAssistantChannels({request,assertScope,
    base:()=>{if(!profile?.agent_id)throw fail('ASSISTANT_NOT_READY');return '/api/agents/'+identifier(profile.agent_id)+'/channels';},
    cleanup:async(key,route)=>{const link=channelLinks.get(key);if(link)await link.request({path:route,method:'POST',headers:{accept:'application/json'}});}});
  function unwatch() {
    const previous = watcher; watcher = null;
    previous?.socket?.terminate();
  }
  function invalidate() {
    assistantChannels.reset(); channelLinks.clear();
    generation++; unwatch();
    const oldChannel=channelCache, oldGrants=[...spaceGrants.values()].map(g=>['space',g]).concat([...knowledgeGrants.values()].map(g=>['knowledge',g]));
    if(oldChannel) void oldChannel.then(async link=>{try {for(const [kind,g]of oldGrants) await link.request({path:'/api/assistant/'+kind+'-grant',method:'POST',headers:{'content-type':'application/json','x-wanx-data-context':edition},body:JSON.stringify({enabled:false,grant_id:g.grant_id}),signal:AbortSignal.timeout(10000)}).catch(()=>{});} finally {link.close?.();}}).catch(()=>{});
    conversationCache.clear();threadRoots.clear();spaceGrants.clear();knowledgeGrants.clear();fences.clear();
    for (const controller of requests) controller.abort();
    requests.clear(); uploads.clear(); threads.clear(); profile = null; catalog = []; configuration = {}; channelCache = null;
    onEvent({ type: 'invalidated' });
  }
  const unsubscribe = client.subscribe(() => {
    const next = scope();
    if (next !== currentScope) { currentScope = next; invalidate(); }
  });
  async function channel(key) {
    assertScope(key);
    if (!channelCache) {
      const pending = Promise.resolve(client.applicationConnection(DIALOGUE_APPLICATION_ID, { backendProductId: 'wanx' })).then(link => {
        if (channelCache !== pending || scope() !== key) { link.close?.(); throw fail('DIALOGUE_CONTEXT_CHANGED'); }
        return link;
      });
      channelCache = pending;
      void pending.catch(() => { if (channelCache === pending) channelCache = null; });
    }
    const result = await channelCache; assertScope(key); return result;
  }
  async function request(key, route, { method = 'GET', body, headers, stream = false, upload = false, timeout = 30_000 } = {}) {
    const link = await channel(key), controller = new AbortController();
    requests.add(controller); let streaming = false;
    try {
      const response = await link.request({ path: route, method, stream,
        signal: stream ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(upload ? 300_000 : timeout)]),
        headers: { accept: stream ? '*/*' : 'application/json', ...(body && !upload ? { 'content-type': 'application/json' } : {}), ...headers,
          ...(route.startsWith('/api/assistant/knowledge') ? { 'x-wanx-data-context': edition === 'team' ? 'team' : 'personal' } : {}) },
        ...(body ? { body: upload ? body : JSON.stringify(body) } : {}) });
      assertScope(key);
      if (response.status < 200 || response.status >= 300) {
        const bytes = response.body?.[Symbol.asyncIterator] ? await collect(response.body, 65_536) : response.body;
        let data; try { data = JSON.parse(Buffer.from(bytes || '').toString()); } catch { /* sanitized below */ }
        const code = data?.error?.details?.reason || data?.detail?.code || data?.error?.code || data?.code;
        const error = fail(/^[A-Z][A-Z0-9_]{1,80}$/.test(code || '') ? code : response.status === 403 ? 'DIALOGUE_ACCESS_DENIED' : response.status === 413 ? 'ASSISTANT_UPLOAD_TOO_LARGE' : 'ASSISTANT_REQUEST_FAILED');
        error.status = response.status; throw error;
      }
      if (stream) {
        // Keep cancellation attached until the body ends, including HITL SSE.
        streaming = true; response.body.once?.('close', () => { requests.delete(controller);  });
        return response;
      }
      const result = JSON.parse(Buffer.from(response.body || '').toString() || '{}');
      assertScope(key); return result;
    } finally { if (!streaming) { requests.delete(controller);  } }
  }
  async function collect(body, limit = MAX_BYTES) {
    const chunks = []; let size = 0;
    try { for await (const chunk of body) { size += chunk.length; if (size > limit) throw fail('ASSISTANT_FILE_TOO_LARGE'); chunks.push(Buffer.from(chunk)); } }
    finally { body.destroy?.(); }
    return Buffer.concat(chunks);
  }
  function nativePath() { if (!profile) throw fail('ASSISTANT_NOT_READY'); return `/api/agents/${identifier(profile.agent_id)}`; }
  async function listing(key) {
    const result=await request(key,'/api/assistant/conversations');
    if(result.items.some(row=>!row.channel_type)){
      // Older boxes already expose native channel metadata. Keep routing keys in main.
      const native=await optional(key,`${nativePath()}/threads?limit=10000`,[]).catch(()=>{assertScope(key);return [];});
      const origins=new Map(native.map(row=>[row.thread_id,row.channel_type]));
      result.items=result.items.map(row=>({...row,channel_type:row.channel_type||origins.get(row.thread_id)||'unknown'}));
    }
    return result;
  }
  async function history(key, tid, offset = 0) {
    identifier(tid);
    const value = await request(key, `${nativePath()}/threads/${tid}/history?limit=25&offset=${offset}`);
    if (resolveDataContext?.(client.snapshot())) value.knowledge_sources = [];
    else {
      const sources = await optional(key, `/api/assistant/knowledge/sources/${tid}`, { sources: [] }).catch(() => ({ sources: [] }));
      value.knowledge_sources = sources.sources;
    }
    assertScope(key);
    threads.add(tid); return value;
  }
  async function watch(key, tid) {
    identifier(tid);
    if (!threads.has(tid)) await history(key, tid);
    if (watcher?.key === key && watcher.tid === tid && watcher.socket?.readyState === 1) return;
    unwatch();
    const entry = { key, tid, socket: null }; watcher = entry;
    const link = await channel(key);
    const socket = await link.openStream({ path: `${nativePath()}/chat/ws` });
    if (scope() !== key || watcher !== entry) { socket.terminate(); throw fail('DIALOGUE_CONTEXT_CHANGED'); }
    entry.socket = socket;
    socket.on('message', raw => {
      if (watcher !== entry || scope() !== key) return;
      try {
        if (raw.length > 40_000_000) throw fail('ASSISTANT_INVALID_RESPONSE');
        const event = JSON.parse(raw.toString());
        if (event.thread_id && event.thread_id !== tid) return;
        if(event.type==='usage'){const usage={};for(const field of ['input_tokens','output_tokens','total_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','last_input_tokens','model_calls'])if(Number.isFinite(event.usage?.[field])&&event.usage[field]>=0)usage[field]=event.usage[field];emit(key,{type:'assistant-event',threadId:tid,event:{type:'usage',call_id:String(event.call_id||''),model:String(event.model||''),usage}});return;}
        if (['token', 'tool_call_chunk', 'tool_result', 'done', 'error', 'hitl_required', 'attachment', 'turn_status'].includes(event.type))
          emit(key, { type: 'assistant-event', threadId: tid, event });
      } catch { socket.terminate(); }
    });
    socket.on('error', () => {});
    socket.once('close', () => {
      if (watcher !== entry || scope() !== key) return;
      watcher = null; emit(key, { type: 'stream-error', threadId: tid });
    });
    await new Promise((resolve, reject) => socket.send(JSON.stringify({ type: 'subscribe', thread_id: tid }), error => error ? reject(error) : resolve()));
  }
  async function sendFrame(key, tid, frame) {
    await watch(key, tid); assertScope(key);
    const socket = watcher.socket;
    await new Promise((resolve, reject) => socket.send(JSON.stringify(frame), error => error ? reject(fail('ASSISTANT_SEND_UNCERTAIN')) : resolve()));
    assertScope(key);
  }
  async function validateModel(key, ref) {
    if (typeof ref !== 'string') throw fail('MODEL_UNAVAILABLE');
    catalog = (await request(key, '/api/providers/resolved')).map(publicModel);
    if (!catalog.some(m => m.id === ref)) throw fail('MODEL_UNAVAILABLE');
  }
  async function optional(key, route, fallback) {
    try { return await request(key, route); }
    catch (error) { assertScope(key); if (error.status === 404) return fallback; throw error; }
  }
  return {
    async action(method, input = {}) {
      const key = scope();
      if (!key) throw fail('BOX_CONNECTION_REQUIRED');
      if (method !== 'load') assertScope(input.scope);
      if (method.startsWith('channels-')) {
        channelLinks.set(key,await channel(key));
        return {scope:key,...await assistantChannels.action(method,input,key)};
      }
      if(method==='handoff') {
        if(typeof input.draft!=='string'||input.draft.length>32000||typeof input.reference!=='string'||input.reference.length>32000)throw fail('ASSISTANT_INVALID_INPUT');
        const files=input.attachments||[];if(!Array.isArray(files)||files.length>8)throw fail('ASSISTANT_INVALID_INPUT');
        for(const file of files)if(uploads.get(file.handle)?.key!==key)throw fail('ASSISTANT_ATTACHMENT_EXPIRED');
        const cid=input.conversationId?identifier(input.conversationId):null;
        if(cid)await conversation(key,cid);
        return {scope:key,conversationId:cid,draft:input.draft,reference:input.reference,attachments:files.map(f=>publicUpload(f.handle,uploads.get(f.handle).data,f.size||0)),model:input.model,context:{space:configuration.space,knowledge:configuration.knowledge}};
      }
      if (method === 'history-list') {
        const [recent, organization] = await Promise.all([listing(key),optional(key,'/api/assistant/history',{entries:{},unavailable:true})]);
        assertScope(key);
        for(const row of recent.items)threads.add(row.thread_id);
        return {scope:key,sessions:recent.items,organization:organization.entries||{}};
      }
      if (method === 'load') {
        const stored = preferenceStore ? await preferenceStore.load() || {} : preferenceMemory;
        assertScope(key);
        configuration = {...(profile?configuration:emptyContext()), model:stored.assistantConfigurations?.[configurationKey(key)]?.model};
        try { profile = await request(key, '/api/assistant/profile', { method: 'POST' }); }
        catch (error) { if (error.status === 404) throw fail('ASSISTANT_API_NOT_INSTALLED'); throw error; }
        identifier(profile.agent_id);
        const [resolved, prefs, activeModel, recent, legacy, organization, timezone] = await Promise.all([
          request(key, '/api/providers/resolved'), request(key, '/api/preferences'),
          optional(key, '/api/providers/active-model', {}), listing(key),
          optional(key, '/api/dialogue/sessions?limit=10000', { sessions: [] }).catch(error => { assertScope(key); return { sessions: [], unavailable: true }; }),
          optional(key, '/api/assistant/history', { entries: {}, unavailable: true }),
          optional(key, '/api/settings/timezone', { timezone: 'UTC' }),
        ]);
        assertScope(key); catalog = resolved.map(publicModel);
        for (const thread of recent.items) threads.add(thread.thread_id);
        const candidates = [configuration.model, prefs.preferred_model, profile.default_model, activeModel?.provider_name && `${activeModel.provider_name}/${activeModel.model}`];
        const resumable=recent.items.filter(row=>!['archived','trash'].includes(organization.entries?.['thread:'+row.thread_id]?.status));
        const recentConversationId=resumable.find(row=>row.thread_id===recent.recent_conversation_id)?.thread_id||resumable[0]?.thread_id||null;
        return { scope: key, agentId: profile.agent_id, models: catalog, recentConversationId,
          defaultModel: configuration.model || candidates.find(ref => catalog.some(m => m.id === ref)) || catalog[0]?.id || null,
          sessions: recent.items, legacySessions: legacy.sessions || [], legacyUnavailable: legacy.unavailable === true,
          organization: organization.entries, historyManagementAvailable: !organization.unavailable, timezone: timezone.timezone || 'UTC',
          capabilities: resolveDataContext?.(client.snapshot())
            ? { knowledge: false, space: false, channels: false, attachments: false }
            : { knowledge: true, space: true, channels: true, attachments: true }, settings: configuration };
      }
      if (method.startsWith('knowledge-')) {
        const base = '/api/assistant/knowledge';
        if (method === 'knowledge-list') return { scope: key, ...(await request(key, base + '/warehouses')) };
        if (method === 'knowledge-grant') {
          if(typeof input.enabled!=='boolean') throw fail('ASSISTANT_INVALID_INPUT');
          const warehouses=input.enabled ? input.warehouses?.map(id=>({id:identifier(id)})) : [];
          if(input.enabled && (!warehouses?.length || warehouses.length>100)) throw fail('ASSISTANT_INVALID_INPUT');
          const value=await setContext(key,input.threadId,{knowledge:{enabled:input.enabled,warehouses,data_scope:edition}});
          return {scope:key,...value.context.knowledge,conversation:value.id?value:undefined};
        }
        if (method === 'knowledge-evidence') {
          const tid = identifier(input.threadId); if (!threads.has(tid)) await history(key, tid);
          const saved=await conversation(key,tid);
          const grant = await ensureKnowledge(key, tid, saved.context);
          return { scope: key, ...(await request(key, base + '/evidence', { method: 'POST', body: { grant_id: grant.grant_id,
            thread_id: tid, warehouse_id: identifier(input.warehouseId), evidence_id: identifier(input.evidenceId) } })) };
        }
        throw fail('ASSISTANT_INVALID_INPUT');
      }
      if (method === 'release-context') { configuration={...emptyContext(),model:configuration.model}; return {scope:key}; }
      if (method === 'usage') {
        const tid=identifier(input.threadId);if(!threads.has(tid))await history(key,tid);
        const chosen=catalog.find(m=>m.id===input.model), max=chosen?.contextWindow;
        const value=await request(key,`${nativePath()}/threads/${tid}/context-usage${max?'?max_tokens='+max:''}`);
        return {scope:key,...value};
      }
      if (method === 'polish') {
        await validateModel(key,input.model);
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>32000)throw fail('ASSISTANT_INVALID_INPUT');
        return {scope:key,...await request(key,`${nativePath()}/chat/polish`,{method:'POST',body:{text:input.text,default_model:input.model}})};
      }
      if(method==='version-select') {
        const current=await conversation(key,identifier(input.conversationId));
        const value=remember(await request(key,'/api/assistant/conversations/'+current.id,{method:'PATCH',body:{revision:input.revision,active_thread_id:identifier(input.threadId)}}));
        return {scope:key,conversation:value,history:await history(key,value.active_thread_id)};
      }
      if(method==='version') {
        await validateModel(key,input.model);
        const cid=identifier(input.conversationId), source=identifier(input.threadId);
        const value=remember(await request(key,'/api/assistant/conversations/'+cid+'/versions',{method:'POST',body:{revision:input.revision,source_thread_id:source,message_id:input.messageId,kind:input.kind,...(input.kind==='edit'?{text:input.text}:{})}}));
        const content=value.prepared_content;delete value.prepared_content;
        const tid=value.active_thread_id;threads.add(tid);
        let dispatching=false;
        try {
          if(content.some(b=>b.type==='image')&&!catalog.find(m=>m.id===input.model)?.input.includes('image'))throw fail('ASSISTANT_MODEL_NEEDS_IMAGE');
          let turnMcp=[];
          if(value.context.space?.enabled)turnMcp.push((await ensureSpace(key,tid,value.context)).mcp_server);
          if(value.context.knowledge?.enabled)turnMcp.push((await ensureKnowledge(key,tid,value.context)).mcp_server);
          dispatching=true;
          await sendFrame(key,tid,{type:'user_turn',thread_id:tid,model:input.model,mcp_servers:turnMcp,messages:[{role:'user',content}],conversation_mode:'craft'});
          return {scope:key,conversation:value,history:await history(key,tid)};
        } catch(error) {
          if(!dispatching) await request(key,'/api/assistant/conversations/'+cid,{method:'PATCH',body:{revision:value.revision,active_thread_id:source}}).then(remember).catch(()=>{});
          throw error;
        }
      }
      if (method === 'space-list') {
        if (!input.spaceId) {
          const spaces = await request(key, '/api/personal-space/spaces');
          return { scope: key, spaces: spaces.filter(s => !s.trashed).map(s => ({ id: s.id, name: s.name, root: s.root })) };
        }
        const sid = identifier(input.spaceId), parent = input.parent ? identifier(input.parent) : '';
        const result = await request(key, `/api/personal-space/files?space_id=${encodeURIComponent(sid)}&parent=${encodeURIComponent(parent)}`);
        return { scope: key, parent: result.parent, root: result.root, breadcrumbs: result.breadcrumbs,
          folders: result.items.filter(s => s.kind === 'folder').map(s => ({ id: s.id, name: s.name })) };
      }
      if (method === 'space-grant') {
        if(typeof input.enabled!=='boolean')throw fail('ASSISTANT_INVALID_INPUT');
        if(input.enabled){if(!['all','space','folder'].includes(input.selection?.mode))throw fail('ASSISTANT_INVALID_INPUT');if(input.selection.mode!=='all')identifier(input.selection.space_id);if(input.selection.mode==='folder')identifier(input.selection.folder_id);}
        const value=await setContext(key,input.threadId,{space:input.enabled?{enabled:true,selection:input.selection}:{enabled:false}});
        return {scope:key,...value.context.space,conversation:value.id?value:undefined};
      }
      if (method === 'history-update') {
        const operations = ['rename', 'pin', 'unpin', 'archive', 'unarchive', 'trash', 'restore'];
        if (!operations.includes(input.operation) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw fail('ASSISTANT_INVALID_INPUT');
        const items = input.items.map(item => {
          if (!['thread', 'legacy'].includes(item.kind)) throw fail('ASSISTANT_INVALID_INPUT');
          return { kind: item.kind, id: identifier(item.id) };
        });
        if (input.operation === 'rename' && (items.length !== 1 || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 100)) throw fail('ASSISTANT_INVALID_INPUT');
        return { scope: key, ...(await request(key, '/api/assistant/history', { method: 'POST', body: { operation: input.operation, items, ...(input.operation === 'rename' ? { title: input.title.trim() } : {}) } })) };
      }
      if (method === 'history-export') {
        const id = identifier(input.id);
        if (!['thread', 'legacy'].includes(input.kind)) throw fail('ASSISTANT_INVALID_INPUT');
        const data = await request(key, input.kind === 'legacy' ? `/api/dialogue/sessions/${id}` : `${nativePath()}/threads/${id}/history/export`);
        if (!saveFile) throw fail('ASSISTANT_UPLOAD_UNAVAILABLE');
        const filePath = await saveFile(`dialogue-${input.kind}-${id}.json`); assertScope(key);
        if (filePath) await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
        return { scope: key, saved: Boolean(filePath) };
      }
      if (method === 'unwatch') { unwatch(); return { scope: key }; }
      if (method === 'open') {
        let value=await conversation(key,identifier(input.threadId));
        if(input.trackOpened) value=remember(await request(key,'/api/assistant/conversations/'+value.id+'/open',{method:'POST'}));
        return {scope:key,conversation:value,history:await history(key,value.active_thread_id,Number.isInteger(input.offset)&&input.offset>=0?input.offset:0)};
      }
      if (method === 'watch') { await watch(key, identifier(input.threadId)); return { scope: key }; }
      if (method === 'legacy-open') return { scope: key, session: await request(key, `/api/dialogue/sessions/${identifier(input.sessionId)}`) };
      if (method === 'model') {
        await validateModel(key, input.model);
        if (input.threadId) {
          const tid = identifier(input.threadId);
          if (!threads.has(tid)) await history(key, tid);
          await request(key, `${nativePath()}/threads/${tid}`, { method: 'PATCH', body: { model_ref: input.model } });
        }
        if(!input.threadId) await saveConfiguration(key, { model: input.model });
        return { scope: key };
      }
      if (method === 'send') {
        const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
        const handles = input.attachments || [];
        if (prompt.length > 32_000 || !Array.isArray(handles) || handles.length > 8 || new Set(handles).size !== handles.length || !prompt && !handles.length) throw fail('ASSISTANT_INVALID_INPUT');
        const files = handles.map(handle => { const item = uploads.get(handle); if (!item || item.key !== key) throw fail('ASSISTANT_ATTACHMENT_EXPIRED'); return item.data; });
        await validateModel(key, input.model);
        if (files.some(file => file.media_type?.startsWith('image/')) && !catalog.find(m => m.id === input.model)?.input.includes('image')) throw fail('ASSISTANT_MODEL_NEEDS_IMAGE');
        const tid = input.threadId ? identifier(input.threadId) : identifier((await request(key, `${nativePath()}/threads`, { method: 'POST' })).thread_id);
        if (!threads.has(tid)) await history(key, tid);
        let saved=await conversation(key,tid);
        if(!input.threadId) saved=remember(await request(key,'/api/assistant/conversations/'+tid,{method:'PATCH',body:{revision:saved.revision,context:{space:configuration.space,knowledge:configuration.knowledge}}}));
        if(saved.validation_errors?.length)throw fail(saved.validation_errors[0].code);
        const config=saved.context;
        if(input.threadId&&Number.isInteger(input.revision)&&input.revision!==saved.revision)throw fail('ASSISTANT_CONVERSATION_CONFLICT');
        if(input.spaceEnabled&&!config.space?.enabled)throw fail('ASSISTANT_SPACE_SCOPE_REQUIRED');
        if(input.knowledgeEnabled&&!config.knowledge?.enabled)throw fail('ASSISTANT_KNOWLEDGE_DENIED');
        const state = await history(key, tid);
        if (state.turn_active || state.hitl_pending) throw fail('ASSISTANT_TURN_ACTIVE');
        let turnMcp = [];
        if (config.space?.enabled) {
          turnMcp = [(await ensureSpace(key, tid, config)).mcp_server];
        }
        if (config.knowledge?.enabled) turnMcp.push((await ensureKnowledge(key, tid, config)).mcp_server);
        const content = [...(prompt ? [{ type: 'text', text: prompt }] : []), ...files.map(file => file.media_type?.startsWith('image/') ? {
          type: 'image', source: { type: 'url', url: file.url, media_type: file.media_type }, preview_url: file.url, workspace_path: file.workspace_path, filename: file.filename,
        } : { type: 'file', filename: file.filename, media_type: file.media_type, workspace_path: file.workspace_path })];
        emit(key, { type: 'turn-submitting', threadId: tid, model: input.model });
        await sendFrame(key, tid, { type: 'user_turn', thread_id: tid, model: input.model,
          mcp_servers: turnMcp,
          messages: [{ role: 'user', content }], conversation_mode: 'craft' });
        await request(key,'/api/assistant/conversations/'+saved.id+'/open',{method:'POST'}).catch(()=>{});
        return { scope: key, threadId: tid, conversation:saved };
      }
      if (method === 'stop') {
        const tid = identifier(input.threadId);
        await sendFrame(key, tid, { type: 'cancel', thread_id: tid });
        return { scope: key };
      }
      if (method === 'release') { for (const handle of input.handles || []) uploads.delete(handle); return { scope: key }; }
      if (method === 'upload') {
        if (!selectFiles) throw fail('ASSISTANT_UPLOAD_UNAVAILABLE');
        const chosen = await selectFiles(); assertScope(key);
        if (!Array.isArray(chosen) || chosen.length > 8) throw fail('ASSISTANT_TOO_MANY_ATTACHMENTS');
        const files = [];
        for (const filePath of chosen) {
          const info = await stat(filePath); assertScope(key);
          if (!info.isFile() || info.size > MAX_BYTES) throw fail('ASSISTANT_UPLOAD_TOO_LARGE');
          const filename = path.basename(filePath).replace(/[\r\n"\\]/g, '_');
          const boundary = 'wanx-' + randomUUID();
          const body = Readable.from((async function* () {
            yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
            yield* createReadStream(filePath);
            yield Buffer.from(`\r\n--${boundary}--\r\n`);
          })());
          const data = await request(key, `${nativePath()}/upload`, { method: 'POST', body, upload: true,
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
          assertScope(key); const handle = randomUUID(); uploads.set(handle, { key, data });
          files.push(publicUpload(handle, data, info.size));
        }
        return { scope: key, files };
      }
      if (method === 'resume') {
        const tid = identifier(input.threadId), state = await history(key, tid), pending = state.hitl_pending;
        if (!pending || !Array.isArray(input.decisions) || input.decisions.length !== pending.action_requests.length ||
          input.decisions.some(d => !['approve', 'reject', 'respond'].includes(d.type) || d.type === 'respond' && (typeof d.message !== 'string' || !d.message.trim() || d.message.length > 8000))) throw fail('ASSISTANT_INVALID_INPUT');
        unwatch();
        const response = await request(key, `${nativePath()}/chat/hitl/resume`, { method: 'POST', stream: true,
          headers: { accept: 'text/event-stream' }, body: { thread_id: tid, decisions: input.decisions } });
        const turn = generation;
        void (async () => {
          let buffer = ''; const decoder = new TextDecoder();
          try {
            for await (const chunk of response.body) {
              assertScope(key); if (generation !== turn) return;
              buffer += decoder.decode(chunk, { stream: true });
              if (buffer.length > 40_000_000) throw fail('ASSISTANT_INVALID_RESPONSE');
              let match;
              while ((match = /\r?\n\r?\n/.exec(buffer))) {
                const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
                const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                if (data && data !== '[DONE]') emit(key, { type: 'assistant-event', threadId: tid, event: JSON.parse(data) });
              }
            }
            emit(key, { type: 'resume-ended', threadId: tid });
          } catch { emit(key, { type: 'stream-error', threadId: tid }); }
          finally { response.body.destroy?.(); }
        })();
        return { scope: key };
      }
      if (method === 'artifact') {
        const tid = identifier(input.threadId), state = await history(key, tid);
        const refs = state.artifact_refs?.length ? state.artifact_refs : state.artifacts || [];
        const ref = refs.find(item => (typeof item === 'string' ? item : item.path) === input.path && (!item.agent_id || item.agent_id === profile.agent_id));
        if (!ref || typeof input.path !== 'string' || /[\x00-\x1f]/.test(input.path)) throw fail('ASSISTANT_ARTIFACT_DENIED');
        const name = path.basename(input.path);
        if (input.save === true && !saveFile) throw fail('ASSISTANT_SAVE_UNAVAILABLE');
        const destination = input.save === true ? await saveFile(name) : null; assertScope(key);
        if (input.save === true && !destination) return { scope: key, canceled: true };
        const response = await request(key, `${nativePath()}/workspace/download?path=${encodeURIComponent(input.path)}`, { stream: true });
        const bytes = await collect(response.body); assertScope(key);
        const mime = String(response.headers?.['content-type'] || 'application/octet-stream').split(';')[0];
        if (destination) { await writeFile(destination, bytes, { flag: 'w' }); return { scope: key, saved: true, name }; }
        if (/^image\/(?:png|jpeg|webp|gif)$/.test(mime) && bytes.length <= 10_000_000) return { scope: key, name, mime, dataURL: `data:${mime};base64,${bytes.toString('base64')}` };
        const textual = /^text\//.test(mime) || /\.(?:md|txt|json|csv|tsv|py|js|ts|html|css|yaml|yml|log)$/i.test(name);
        return { scope: key, name, mime, ...(textual ? { text: bytes.subarray(0, 500_000).toString('utf8'), truncated: bytes.length > 500_000 } : {}) };
      }
      throw fail('ASSISTANT_INVALID_INPUT');
    },
    close() { if (closed) return; closed = true; unsubscribe(); invalidate(); },
  };
}
