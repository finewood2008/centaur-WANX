import { createHash, randomUUID } from 'node:crypto';

const APP_NAMES = { 'centaurai.wanx.centaurloop': '半人马环', 'centaurai.wanx.zhijun': '知君', 'centaurai.wanx.dialogue': '众见', 'centaurai.wanx.semantica': '星图', 'centaurai.wanx.superadvisors': '个人议事厅', 'centaurai.wanx.ai-browser': '万象 AI 浏览器', 'centaurai.wanx.new-media-toolkit': '火花' };
const clean = (value, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const digest = value => createHash('sha256').update(value).digest('hex');

// Only trusted main-process events and the selected box's authenticated APIs
// can create notifications. Renderers can mark existing records read, not post.
export async function createNotificationCenter({ client, store, serviceURL, onChanged = () => {} }) {
  let data = { version: 1, accounts: {} }, storageError = false;
  try {
    const saved = await store.load();
    if (saved?.version === 1 && saved.accounts && typeof saved.accounts === 'object') data = saved;
  } catch { storageError = true; }
  let accountKey = null, connectionKey = null, previous = null, closed = false, epoch = 0;
  let socket = null, reconnect = null, ping = null, poll = null, retry = 0, writes = Promise.resolve(), refreshing = null;
  let taskStatus = 'disconnected';
  const keyFor = state => state.account?.phase === 'authenticated' && state.account.accountId
    ? digest(JSON.stringify([serviceURL, state.account.accountId])) : null;
  const bucket = () => accountKey ? data.accounts[accountKey] ||= { items: [], seen: [] } : null;
  const emit = () => { if (!closed) onChanged(); };
  function persist() {
    const value = structuredClone(data);
    writes = writes.then(() => store.save(value)).catch(() => { if (!storageError) { storageError = true; emit(); } });
    return writes;
  }
  function snapshot() {
    const items = structuredClone(bucket()?.items || []);
    return { items, unreadCount: items.filter(row => !row.readAt).length, taskStatus, storageError };
  }
  function add({ key, title, body, category = 'application', deviceId = null, deviceName = '', applicationId = null, createdAt = Date.now() }, deferred = false) {
    const current = bucket();
    if (!current || closed || !clean(title) || !clean(body)) return;
    const id = digest(key);
    if (current.seen.includes(id) || current.items.some(row => row.id === id)) return;
    current.seen.push(id); current.seen = current.seen.slice(-5000);
    current.items.unshift({ id, title: clean(title, 160), body: clean(body), category, deviceId, deviceName: clean(deviceName, 100), applicationId, createdAt, readAt: null });
    current.items.sort((a, b) => b.createdAt - a.createdAt);
    current.items = current.items.slice(0, 500);
    if (!deferred) { void persist(); emit(); }
    return true;
  }
  const currentScope = bound => !closed && bound === connectionKey && Boolean(accountKey);
  function stopSources() {
    clearTimeout(reconnect); clearInterval(ping); clearInterval(poll);
    reconnect = ping = poll = null;
    const old = socket; socket = null; old?.terminate();
  }
  async function connect(bound, generation) {
    if (!currentScope(bound) || generation !== epoch) return;
    try {
      const stream = await client.applicationStream({ path: '/api/notifications/ws' });
      if (!currentScope(bound) || generation !== epoch) { stream.terminate(); return; }
      socket = stream; retry = 0;
      stream.on('message', bytes => {
        if (!currentScope(bound) || generation !== epoch || stream !== socket || bytes.length > 65536) return;
        let frame; try { frame = JSON.parse(bytes.toString()); } catch { return; }
        if (frame?.type !== 'dashboard_push' || !clean(frame.agent_id) || !clean(frame.thread_id) || !clean(frame.text)) return;
        const state = client.snapshot();
        // Legacy pushes have no event ID or replay contract. Identical text can
        // be a later reminder; only stable producer IDs can safely deduplicate.
        add({ key: `push:${state.connection.deviceId}:${clean(frame.event_id, 160) || randomUUID()}`,
          title: clean(frame.agent_name, 80) || '应用任务消息', body: frame.text, category: 'task',
          deviceId: state.connection.deviceId, deviceName: state.connection.name });
      });
      const retryConnection = () => {
        if (!currentScope(bound) || generation !== epoch) return;
        if (socket === stream) { socket = null; clearInterval(ping); }
        scheduleReconnect(bound, generation);
      };
      stream.on('close', retryConnection);
      stream.on('error', () => { stream.terminate(); retryConnection(); });
      ping = setInterval(() => { if (stream === socket && stream.readyState === 1) stream.send(JSON.stringify({ type: 'ping' })); }, 25000);
      ping.unref?.();
    } catch { scheduleReconnect(bound, generation); }
  }
  function scheduleReconnect(bound, generation) {
    if (!currentScope(bound) || generation !== epoch || reconnect) return;
    reconnect = setTimeout(() => { reconnect = null; void connect(bound, generation); }, Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)));
    reconnect.unref?.();
  }
  async function refresh() {
    if (!connectionKey || closed) return snapshot();
    const bound = connectionKey, generation = epoch;
    if (refreshing?.generation === generation) return refreshing.work;
    const state = client.snapshot(), deviceId = state.connection.deviceId, deviceName = state.connection.name;
    const work = (async () => {
      try {
        const response = await client.applicationRequest({ path: '/api/loops', signal: AbortSignal.timeout(12000) });
        if (!currentScope(bound) || generation !== epoch) return snapshot();
        if (response.status !== 200) { taskStatus = response.status === 404 ? 'upgrade-required' : 'unavailable'; emit(); return snapshot(); }
        if (response.body?.length > 2 * 1024 * 1024) throw new Error('NOTIFICATION_RESPONSE_TOO_LARGE');
        const loops = JSON.parse(response.body.toString());
        if (!Array.isArray(loops)) throw new Error('NOTIFICATION_RESPONSE_INVALID');
        taskStatus = 'connected';
        const candidates = [];
        const collect = item => candidates.push({ createdAt: Date.now(), ...item });
        for (const loop of loops) {
          if (!clean(loop.loop_id)) continue;
          const common = { applicationId: 'centaurai.wanx.centaurloop', category: 'task', deviceId, deviceName };
          const name = clean(loop.definition?.name, 100) || '半人马环任务';
          for (const notice of Array.isArray(loop.notifications) ? loop.notifications : []) {
            if (!clean(notice.notification_id) || !clean(notice.message) || notice.status === 'cancelled') continue;
            const createdAt = Number.isFinite(notice.created_at) ? notice.created_at * 1000 : Date.now();
            if (createdAt < Date.now() - 30 * 86400000) continue;
            collect({ ...common, key: `loop:${deviceId}:${notice.notification_id}`, title: name, body: notice.message, createdAt });
          }
          const judgment = loop.pending_judgment;
          if (judgment?.status === 'pending' && clean(judgment.judgment_id)) collect({ ...common,
            key: `judgment:${deviceId}:${judgment.judgment_id}`, title: `${name} · 等待确认`,
            body: clean(judgment.payload?.summary) || '任务需要你的判断或补充信息，请打开半人马环查看。' });
          if (loop.status === 'completed') collect({ ...common, key: `complete:${deviceId}:${loop.loop_id}:${loop.version}:${loop.round_count}`,
            title: `${name} · 已完成`, body: '任务已完成，请打开半人马环查看结果。', createdAt: Number.isFinite(loop.updated_at) ? loop.updated_at * 1000 : Date.now() });
        }
        // Pin the bounded replay set separately from live-event deduplication.
        // A busy stream must not evict read-state for repeatedly polled tasks.
        const rows = candidates.sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
        const current = bucket(), feed = digest(deviceId);
        current.feeds ||= {};
        const previousIds = current.feeds[feed] || [];
        const ids = rows.map(row => digest(row.key));
        const pinned = [...new Set([...previousIds, ...ids])].slice(-5000);
        let changed = JSON.stringify(pinned) !== JSON.stringify(previousIds);
        for (const row of rows.toReversed()) {
          if (!previousIds.includes(digest(row.key))) changed = add(row, true) || changed;
        }
        current.feeds[feed] = pinned;
        if (changed) void persist();
        emit();
      } catch { if (currentScope(bound) && generation === epoch) { taskStatus = 'unavailable'; emit(); } }
      return snapshot();
    })();
    refreshing = { generation, work }; return work.finally(() => { if (refreshing?.work === work) refreshing = null; });
  }
  function sync() {
    const state = client.snapshot(), nextAccount = keyFor(state);
    const nextConnection = nextAccount && state.phase === 'ready' && state.connection?.deviceId
      ? JSON.stringify([nextAccount, state.account.clientId, state.connection.deviceId, state.connection.gatewayURL]) : null;
    const lost = previous?.phase === 'ready' && previous.connection && accountKey === nextAccount && state.phase === 'recovering';
    if (nextAccount !== accountKey || nextConnection !== connectionKey) {
      epoch++; connectionKey = nextConnection; accountKey = nextAccount; stopSources(); retry = 0;
      taskStatus = nextConnection ? 'connecting' : 'disconnected';
      if (nextConnection) {
        void connect(nextConnection, epoch); void refresh();
        poll = setInterval(() => { void refresh(); }, 30000); poll.unref?.();
      }
      emit();
    }
    if (lost) add({ key: `disconnect:${randomUUID()}`, category: 'system', title: '盒子连接中断',
      body: `${previous.connection.name || '盒子'}暂时失去连接，万象正在尝试恢复。`, deviceId: previous.connection.deviceId, deviceName: previous.connection.name });
    previous = structuredClone(state);
  }
  const unsubscribe = client.subscribe(sync); sync();
  return {
    snapshot, refresh,
    async markRead({ id, all = false } = {}) {
      if (!accountKey) throw new Error('ACCOUNT_LOGIN_REQUIRED');
      const rows = all === true ? bucket().items : bucket().items.filter(row => row.id === id);
      if (!rows.length && !all) throw new Error('NOTIFICATION_NOT_FOUND');
      for (const row of rows) row.readAt ||= Date.now();
      await persist(); emit(); return snapshot();
    },
    target(id) {
      if (!accountKey) throw new Error('ACCOUNT_LOGIN_REQUIRED');
      const row = bucket().items.find(item => item.id === id);
      if (!row) throw new Error('NOTIFICATION_NOT_FOUND');
      if (row.deviceId && (client.snapshot().phase !== 'ready' || client.snapshot().connection?.deviceId !== row.deviceId)) throw new Error('NOTIFICATION_BOX_REQUIRED');
      return { applicationId: row.applicationId, category: row.category };
    },
    operation(event) {
      const state = client.snapshot();
      if (event.accountId !== state.account?.accountId || !['installing', 'uninstalling', 'rolling-back'].includes(event.phase) || !['succeeded', 'failed'].includes(event.status)) return;
      const name = APP_NAMES[event.applicationId] || '应用';
      const action = { installing: '安装', uninstalling: '卸载', 'rolling-back': '回退' }[event.phase];
      add({ key: `operation:${randomUUID()}`, title: `${name}${action}${event.status === 'succeeded' ? '完成' : '失败'}`,
        body: event.status === 'succeeded' ? `${name}已${action}完成。` : `${action}未完成，请在应用页查看并重试。`, applicationId: event.applicationId });
    },
    candidate(applicationId, candidate, installed) {
      if (candidate?.status !== 'available' || !installed) return;
      const version = clean(candidate.release?.version, 80);
      if (!version) return;
      add({ key: `app-update:${applicationId}:${version}`, title: `${APP_NAMES[applicationId] || '应用'}有新版本`,
        body: `${version} 版本已可更新，请在应用页查看。`, applicationId });
    },
    update(value) {
      if (!['available', 'downloaded'].includes(value?.phase) || !clean(value.candidate?.releaseId)) return;
      add({ key: `client-update:${value.candidate.releaseId}:${value.phase}`, category: 'system', title: value.phase === 'downloaded' ? '万象更新已下载' : '万象有新版本', body: '请在个人菜单的设置中查看客户端更新。' });
    },
    async close() { if (closed) return; closed = true; epoch++; stopSources(); unsubscribe(); await writes; },
  };
}
