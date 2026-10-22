import { createHash } from 'node:crypto';

export const DIALOGUE_APPLICATION_ID = 'centaurai.wanx.dialogue';
const fail = code => Object.assign(new Error(code), { code });
const id = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw fail('DIALOGUE_INVALID_INPUT');
  return value;
};
const models = value => {
  if (!Array.isArray(value) || !value.length || value.length > 1 || new Set(value).size !== value.length ||
      value.some(v => typeof v !== 'string' || !v || v.length > 256 || /[\x00-\x1f]/.test(v))) throw fail('DIALOGUE_INVALID_INPUT');
  return value;
};

// First-party dialogue uses the selected box's existing account session. No URL,
// provider credentials or caller-selected API path crosses the renderer bridge.
export function createAIDialogue({ client, preferenceStore, onEvent = () => {} }) {
  let closed = false, cached = null, watching = null;
  const requests = new Set();
  let preferenceData = null, preferenceLoad = null, preferenceWrites = Promise.resolve();
  function ownerKey() {
    const state = client.snapshot();
    return createHash('sha256').update(JSON.stringify([state.account.accountId, state.account.clientId, state.connection.deviceId])).digest('hex');
  }
  async function loadPreferences() {
    if (!preferenceStore) return {};
    if (!preferenceLoad) preferenceLoad = Promise.resolve().then(() => preferenceStore.load()).then(value => {
      preferenceData = value?.version === 1 && value.boxes && typeof value.boxes === 'object' && !Array.isArray(value.boxes) ? value.boxes : {};
      return preferenceData;
    }).catch(error => { preferenceLoad = null; throw error; });
    await preferenceLoad;
    return preferenceData;
  }
  async function readPreference(owner) {
    await preferenceWrites;
    const entries = await loadPreferences();
    return Array.isArray(entries[owner]) ? [...entries[owner]] : null;
  }
  async function writePreference(key, owner, modelIds) {
    if (!preferenceStore) throw fail('DIALOGUE_SETTINGS_UNAVAILABLE');
    const work = preferenceWrites.then(async () => {
      const entries = await loadPreferences(); assertScope(key);
      const next = { ...entries };
      if (modelIds === null) delete next[owner]; else next[owner] = [...modelIds];
      await preferenceStore.save({ version: 1, boxes: next });
      preferenceData = next;
      assertScope(key);
    });
    preferenceWrites = work.catch(() => {});
    await work;
  }
  function scope() {
    const s = client.snapshot();
    if (closed || s.account?.phase !== 'authenticated' || s.phase !== 'ready' || !s.connection?.deviceId) return null;
    return createHash('sha256').update(JSON.stringify([s.account.accountId, s.account.clientId, s.connection.deviceId, s.connection.gatewayURL])).digest('hex');
  }
  let currentScope = scope();
  function unwatch() { watching?.controller.abort(); watching = null; }
  function invalidate() {
    unwatch(); for (const controller of requests) controller.abort(); requests.clear(); cached = null;
    onEvent({ type: 'invalidated' });
  }
  const unsubscribe = client.subscribe(() => {
    const next = scope();
    if (next !== currentScope) { currentScope = next; invalidate(); }
  });
  function assertScope(expected) {
    if (!expected || expected !== scope()) throw fail('DIALOGUE_CONTEXT_CHANGED');
  }
  async function connection(key) {
    assertScope(key);
    if (!cached || cached.key !== key) {
      const work = client.applicationConnection(DIALOGUE_APPLICATION_ID, { backendProductId: 'wanx' });
      cached = { key, work };
      void work.catch(() => { if (cached?.work === work) cached = null; });
    }
    const value = await cached.work; assertScope(key); return value;
  }
  async function request(key, path, { method = 'GET', body, stream = false, controller = new AbortController() } = {}) {
    const channel = await connection(key); assertScope(key); requests.add(controller);
    try {
      const response = await channel.request({ path: `/api/dialogue${path}`, method, stream,
        signal: stream ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        headers: { accept: stream ? 'text/event-stream' : 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      assertScope(key);
      if (stream && response.status === 200) return response;
      let value;
      try { value = JSON.parse(response.body.toString('utf8')); } catch { /* Only a sanitized code leaves main. */ }
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 404 && path === '/models') throw fail('DIALOGUE_API_NOT_INSTALLED');
        const code = value?.detail?.code || value?.code;
        throw fail(/^[A-Z_]{2,80}$/.test(code || '') ? code : response.status === 403 ? 'DIALOGUE_ACCESS_DENIED' : 'DIALOGUE_REQUEST_FAILED');
      }
      if (!value || typeof value !== 'object') throw fail('DIALOGUE_INVALID_RESPONSE');
      return value;
    } catch (error) {
      assertScope(key);
      throw error;
    } finally { if (!stream) requests.delete(controller); }
  }
  async function watch(key, sessionId) {
    unwatch();
    const entry = { controller: new AbortController(), key, sessionId }; watching = entry;
    void (async () => {
      try {
        const response = await request(key, `/sessions/${sessionId}/events`, { stream: true, controller: entry.controller });
        const decoder = new TextDecoder(); let buffer = '';
        for await (const chunk of response.body) {
          if (watching !== entry || scope() !== key) return;
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 40_000_000) throw fail('DIALOGUE_STREAM_LIMIT');
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(v => v.startsWith('data:')).map(v => v.slice(5).trimStart()).join('\n');
            if (!data) continue;
            const value = JSON.parse(data);
            if (value.type === 'snapshot' && value.session?.id === sessionId)
              onEvent({ type: 'snapshot', scope: key, session: value.session });
          }
        }
        if (watching === entry && scope() === key) onEvent({ type: 'stream-ended', scope: key, sessionId });
      } catch {
        if (!entry.controller.signal.aborted && watching === entry && scope() === key)
          onEvent({ type: 'stream-error', scope: key, sessionId });
      } finally {
        entry.controller.abort();
        requests.delete(entry.controller);
        if (watching === entry) watching = null;
      }
    })();
    return { scope: key };
  }
  return {
    async action(method, input = {}) {
      const key = scope();
      if (!key) throw fail('BOX_CONNECTION_REQUIRED');
      if (method !== 'load') assertScope(input.scope);
      if (method === 'load') {
        const [catalog, history, visibleModelIds] = await Promise.all([request(key, '/models'), request(key, '/sessions'), readPreference(ownerKey())]);
        assertScope(key);
        return { scope: key, visibleModelIds, models: (catalog.models || []).map(m => Object.fromEntries(['id', 'name', 'provider', 'source', 'is_local'].map(k => [k, m[k]]))),
          capabilities: { model_switch: catalog.capabilities?.model_switch === 1 ? 1 : 0 }, sessions: history.sessions || [] };
      }
      if (method === 'preferences') {
        const owner = ownerKey(), choice = input.modelIds;
        if (choice !== null && (!Array.isArray(choice) || !choice.length || choice.length > 500 ||
            new Set(choice).size !== choice.length || choice.some(value => typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/.test(value)))) throw fail('DIALOGUE_INVALID_MODEL_SELECTION');
        if (choice !== null) {
          const catalog = await request(key, '/models');
          if (choice.some(value => !catalog.models?.some(model => model.id === value))) throw fail('DIALOGUE_INVALID_MODEL_SELECTION');
        }
        await writePreference(key, owner, choice);
        return { scope: key, visibleModelIds: choice === null ? null : [...choice] };
      }
      if (method === 'unwatch') { unwatch(); return { scope: key }; }
      const sessionId = input.sessionId ? id(input.sessionId) : null;
      if (method === 'watch') return watch(key, id(sessionId));
      let value;
      if (method === 'open') value = await request(key, `/sessions/${id(sessionId)}`);
      else if (method === 'send') {
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 ||
            !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId || '')) throw fail('DIALOGUE_INVALID_INPUT');
        const body = { request_id: input.requestId, prompt: input.prompt.trim(), models: models(input.models) };
        // Omit optional models for an unchanged model on older compatible boxes.
        if (sessionId && input.keepModel === true) delete body.models;
        value = await request(key, sessionId ? `/sessions/${sessionId}/answers/${id(input.answerId)}/continue` : '/sessions', { method: 'POST', body });
      } else if (method === 'stop' || method === 'retry') {
        const path = `/sessions/${id(sessionId)}/answers/${id(input.answerId)}/${method}`;
        if (method === 'retry' && !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId || '')) throw fail('DIALOGUE_INVALID_INPUT');
        value = await request(key, path, { method: 'POST', body: method === 'retry' ? { request_id: input.requestId } : undefined });
      } else throw fail('DIALOGUE_INVALID_INPUT');
      return { scope: key, session: value };
    },
    close() { if (closed) return; closed = true; unsubscribe(); invalidate(); },
  };
}
