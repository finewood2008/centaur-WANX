import { randomUUID } from 'node:crypto';

const channel = 'wanx:local-wifi:transport';
const failure = code => Object.assign(new Error(code), { code });
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const bytes = (value, max) => {
  if (!Array.isArray(value) || !value.length || value.length > max ||
    value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw failure('PROTOCOL_CHANGED');
  return Uint8Array.from(value);
};
export function validateWifiCandidate(value) {
  const keys = ['candidateId', 'transport', 'transportHandle', 'selectionLeaseId', 'advertisedName',
    'rssi', 'firstSeenMonotonicMs', 'lastSeenMonotonicMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key)) || value.transport !== 'ble-gatt' ||
    !['candidateId', 'transportHandle', 'selectionLeaseId'].every(key => token(value[key])) ||
    typeof value.advertisedName !== 'string' || value.advertisedName.length > 64 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value.advertisedName) ||
    !(value.rssi === null || (Number.isFinite(value.rssi) && value.rssi <= 0)) ||
    !Number.isFinite(value.firstSeenMonotonicMs) || value.firstSeenMonotonicMs < 0 ||
    !Number.isFinite(value.lastSeenMonotonicMs) || value.lastSeenMonotonicMs < value.firstSeenMonotonicMs)
    throw failure('LOCAL_TRUST_INVALID_INPUT');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

// The isolated local window owns GATT handles only. All frames, session keys and
// authorization decisions are created by the main-owned coordinator.
export function createOfflineWifiTransport({ ipcMain, timeoutMs = 10000 }) {
  let attachment, generation = 0, disposed = false;
  const pending = new Map(), late = new Map();
  const pruneLate = () => { for (const [id, item] of late) if (performance.now() >= item.expiresAt) late.delete(id); };
  const trusted = (event, target) => target && !disposed && event.sender === target.contents &&
    event.senderFrame === target.contents.mainFrame && event.senderFrame?.url === target.url &&
    !target.contents.isDestroyed?.();
  const send = (target, operation, args, requestId = randomUUID()) => {
    if (target && !target.contents.isDestroyed?.() && target.contents.mainFrame?.url === target.url)
      target.contents.send(channel, { requestId, operation, args });
  };
  const rpc = (operation, args, signal, expected = generation) => {
    pruneLate();
    const target = attachment;
    if (disposed || !target || expected !== generation || target.contents.isDestroyed?.() ||
      target.contents.mainFrame?.url !== target.url) return Promise.reject(failure('LOCAL_TRUST_CONTEXT_CHANGED'));
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (pending.size >= 16) return Promise.reject(failure('LOCAL_TRUST_BUSY'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error && operation === 'connect') {
          if (late.size >= 16) late.delete(late.keys().next().value);
          late.set(requestId, { target, expiresAt: performance.now() + 30000 });
          send(target, 'cancelConnect', [requestId]);
        }
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => finish(failure(operation === 'request'
        ? 'GATT_FRAGMENT_INCOMPLETE' : 'LOCAL_CONNECT_TIMEOUT')), operation === 'request' ? 35000 : timeoutMs);
      pending.set(requestId, { target, finish });
      signal?.addEventListener('abort', abort, { once: true });
      try { send(target, operation, args, requestId); }
      catch { finish(failure('LOCAL_TRANSPORT_DISCONNECTED')); }
    });
  };
  const receive = (event, input) => {
    if (!input || typeof input !== 'object' || !token(input.requestId) || typeof input.ok !== 'boolean') return;
    pruneLate();
    const old = late.get(input.requestId);
    if (old && trusted(event, old.target)) {
      late.delete(input.requestId);
      if (input.ok && token(input.value)) send(old.target, 'close', [input.value]);
      return;
    }
    const item = pending.get(input.requestId);
    if (!item || !trusted(event, item.target)) return;
    try { if (Buffer.byteLength(JSON.stringify(input)) > 16384) throw failure('PROTOCOL_CHANGED'); }
    catch { item.finish(failure('PROTOCOL_CHANGED')); return; }
    const code = typeof input.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(input.code)
      ? input.code : 'LOCAL_TRANSPORT_DISCONNECTED';
    item.finish(input.ok ? null : failure(code), input.value);
  };
  ipcMain.on(`${channel}-result`, receive);
  function invalidate() {
    generation++;
    for (const item of [...pending.values()]) item.finish(failure('LOCAL_TRUST_CONTEXT_CHANGED'));
    send(attachment, 'closeAll', []);
  }
  return {
    attach(contents, url) {
      if (disposed) throw failure('LOCAL_TRUST_CONTEXT_CHANGED');
      if (attachment) invalidate();
      attachment = { contents, url };
    },
    invalidate,
    detach(contents) { if (attachment?.contents === contents) { invalidate(); attachment = undefined; } },
    async connect(candidate, signal) {
      const selected = validateWifiCandidate(candidate), expected = generation;
      const id = await rpc('connect', [selected], signal, expected);
      if (!token(id)) throw failure('PROTOCOL_CHANGED');
      let closed = false;
      const active = () => {
        if (closed || expected !== generation || disposed) throw failure('LOCAL_TRUST_CONTEXT_CHANGED');
      };
      if (expected !== generation || signal?.aborted) {
        send(attachment, 'close', [id]);
        signal?.throwIfAborted(); active();
      }
      return {
        kind: 'ble-gatt', capabilities: { statusNotifications: false },
        async readDeviceInfo(caller) { active(); return bytes(await rpc('readDeviceInfo', [id], caller, expected), 512); },
        async request(frame, match, caller) {
          active();
          if (!(frame instanceof Uint8Array) || !frame.length || frame.length > 2048) throw failure('PROTOCOL_CHANGED');
          return bytes(await rpc('request', [id, Array.from(frame), match], caller, expected), 2048);
        },
        async close() { if (!closed) { closed = true; if (expected === generation) send(attachment, 'close', [id]); } },
      };
    },
    dispose() { if (disposed) return; invalidate(); disposed = true; attachment = undefined; late.clear(); ipcMain.removeListener(`${channel}-result`, receive); },
  };
}
