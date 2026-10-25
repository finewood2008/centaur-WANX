import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

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
export function createAIDialogue({ client, onEvent = () => {}, selectFiles, saveFile } = {}) {
  let closed = false, channelCache = null, profile = null, watcher = null;
  let catalog = [], generation = 0;
  const requests = new Set(), uploads = new Map(), threads = new Set();
  const emit = (key, event) => { if (scope() === key) onEvent({ ...event, scope: key }); };
  function scope() {
    const s = client.snapshot();
    if (closed || s.account?.phase !== 'authenticated' || !['ready', 'recovering'].includes(s.phase) || !s.connection?.deviceId) return null;
    return createHash('sha256').update(JSON.stringify([s.account.accountId, s.account.clientId, s.connection.deviceId, s.connection.gatewayURL])).digest('hex');
  }
  let currentScope = scope();
  const assertScope = key => { if (!key || scope() !== key) throw fail('DIALOGUE_CONTEXT_CHANGED'); };
  function unwatch() {
    const previous = watcher; watcher = null;
    previous?.socket?.terminate();
  }
  function invalidate() {
    generation++; unwatch();
    for (const controller of requests) controller.abort();
    requests.clear(); uploads.clear(); threads.clear(); profile = null; catalog = []; channelCache = null;
    onEvent({ type: 'invalidated' });
  }
  const unsubscribe = client.subscribe(() => {
    const next = scope();
    if (next !== currentScope) { currentScope = next; invalidate(); }
  });
  async function channel(key) {
    assertScope(key);
    if (!channelCache) {
      const pending = Promise.resolve(client.applicationConnection(DIALOGUE_APPLICATION_ID, { backendProductId: 'wanx' }));
      channelCache = pending;
      void pending.catch(() => { if (channelCache === pending) channelCache = null; });
    }
    const result = await channelCache; assertScope(key); return result;
  }
  async function request(key, route, { method = 'GET', body, headers, stream = false, upload = false } = {}) {
    const link = await channel(key), controller = new AbortController();
    requests.add(controller); let streaming = false;
    try {
      const response = await link.request({ path: route, method, stream,
        signal: stream ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(upload ? 300_000 : 30_000)]),
        headers: { accept: stream ? '*/*' : 'application/json', ...(body && !upload ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body ? { body: upload ? body : JSON.stringify(body) } : {}) });
      assertScope(key);
      if (response.status < 200 || response.status >= 300) {
        const bytes = response.body?.[Symbol.asyncIterator] ? await collect(response.body, 65_536) : response.body;
        let data; try { data = JSON.parse(Buffer.from(bytes || '').toString()); } catch { /* sanitized below */ }
        const code = data?.detail?.code || data?.error?.code || data?.code;
        const error = fail(/^[A-Z][A-Z0-9_]{1,80}$/.test(code || '') ? code : response.status === 403 ? 'DIALOGUE_ACCESS_DENIED' : response.status === 413 ? 'ASSISTANT_UPLOAD_TOO_LARGE' : 'ASSISTANT_REQUEST_FAILED');
        error.status = response.status; throw error;
      }
      if (stream) {
        // Keep cancellation attached until the body ends, including HITL SSE.
        streaming = true; response.body.once?.('close', () => requests.delete(controller));
        return response;
      }
      const result = JSON.parse(Buffer.from(response.body || '').toString() || '{}');
      assertScope(key); return result;
    } finally { if (!streaming) requests.delete(controller); }
  }
  async function collect(body, limit = MAX_BYTES) {
    const chunks = []; let size = 0;
    try { for await (const chunk of body) { size += chunk.length; if (size > limit) throw fail('ASSISTANT_FILE_TOO_LARGE'); chunks.push(Buffer.from(chunk)); } }
    finally { body.destroy?.(); }
    return Buffer.concat(chunks);
  }
  function nativePath() { if (!profile) throw fail('ASSISTANT_NOT_READY'); return `/api/agents/${identifier(profile.agent_id)}`; }
  async function history(key, tid, offset = 0) {
    identifier(tid);
    const value = await request(key, `${nativePath()}/threads/${tid}/history?limit=25&offset=${offset}`);
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
      if (method === 'load') {
        try { profile = await request(key, '/api/assistant/profile', { method: 'POST' }); }
        catch (error) { if (error.status === 404) throw fail('ASSISTANT_API_NOT_INSTALLED'); throw error; }
        identifier(profile.agent_id);
        const [resolved, prefs, activeModel, recent, legacy] = await Promise.all([
          request(key, '/api/providers/resolved'), request(key, '/api/preferences'),
          optional(key, '/api/providers/active-model', {}), request(key, `${nativePath()}/threads?limit=100`),
          optional(key, '/api/dialogue/sessions', { sessions: [] }).catch(error => { assertScope(key); return { sessions: [], unavailable: true }; }),
        ]);
        assertScope(key); catalog = resolved.map(publicModel);
        for (const thread of recent) threads.add(thread.thread_id);
        const candidates = [prefs.preferred_model, profile.default_model, activeModel?.provider_name && `${activeModel.provider_name}/${activeModel.model}`];
        return { scope: key, agentId: profile.agent_id, models: catalog,
          defaultModel: candidates.find(ref => catalog.some(m => m.id === ref)) || catalog[0]?.id || null,
          sessions: recent, legacySessions: legacy.sessions || [], legacyUnavailable: legacy.unavailable === true };
      }
      if (method === 'unwatch') { unwatch(); return { scope: key }; }
      if (method === 'open') return { scope: key, history: await history(key, identifier(input.threadId), Number.isInteger(input.offset) && input.offset >= 0 ? input.offset : 0) };
      if (method === 'watch') { await watch(key, identifier(input.threadId)); return { scope: key }; }
      if (method === 'legacy-open') return { scope: key, session: await request(key, `/api/dialogue/sessions/${identifier(input.sessionId)}`) };
      if (method === 'model') {
        await validateModel(key, input.model);
        if (input.threadId) {
          const tid = identifier(input.threadId);
          if (!threads.has(tid)) await history(key, tid);
          await request(key, `${nativePath()}/threads/${tid}`, { method: 'PATCH', body: { model_ref: input.model } });
        }
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
        const state = await history(key, tid);
        if (state.turn_active || state.hitl_pending) throw fail('ASSISTANT_TURN_ACTIVE');
        const content = [...(prompt ? [{ type: 'text', text: prompt }] : []), ...files.map(file => file.media_type?.startsWith('image/') ? {
          type: 'image', source: { type: 'url', url: file.url, media_type: file.media_type }, preview_url: file.url, workspace_path: file.workspace_path, filename: file.filename,
        } : { type: 'file', filename: file.filename, media_type: file.media_type, workspace_path: file.workspace_path })];
        emit(key, { type: 'turn-submitting', threadId: tid, model: input.model });
        await sendFrame(key, tid, { type: 'user_turn', thread_id: tid, model: input.model,
          messages: [{ role: 'user', content }], conversation_mode: 'craft' });
        return { scope: key, threadId: tid };
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
