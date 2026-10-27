import https from 'node:https';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { validateDescriptor } from './management-contract.mjs';
import { signHeartbeat, signRenewal, signRequest, verifyDataResponse, validateRawTarget } from './data-contract.mjs';

const MIB = 1024 * 1024;
const EMPTY_HASH = createHash('sha256').update('').digest('base64url');
const ERROR_CODES = new Set(['LOCAL_DATA_INVALID', 'LOCAL_DATA_REQUIRED', 'LOCAL_DATA_FORBIDDEN',
  'LOCAL_DATA_SESSION_CLOSED', 'LOCAL_DATA_SESSION_EXPIRED', 'LOCAL_DATA_REPLAY',
  'LOCAL_DATA_CONTEXT_CHANGED', 'LOCAL_DATA_BODY_MISMATCH', 'LOCAL_DATA_BODY_TOO_LARGE',
  'LOCAL_DATA_STAGING_UNAVAILABLE', 'LOCAL_DATA_CAPACITY', 'LOCAL_DATA_AUTHORITY_UNAVAILABLE',
  'LOCAL_DATA_CLOCK_ROLLBACK', 'LOCAL_DATA_ROUTE_DENIED', 'LOCAL_DATA_SCOPE_DENIED',
  'LOCAL_DATA_UNAVAILABLE', 'LOCAL_DATA_CAPABILITY_REQUIRED']);
const SELECTORS = Object.freeze({ contentType: 'content-type', range: 'range', ifRange: 'if-range',
  ifMatch: 'if-match', lastEventId: 'last-event-id', agentId: 'x-octop-agent-id',
  dataContext: 'x-wanx-data-context', idempotencyKey: 'idempotency-key',
  webSocketKey: 'sec-websocket-key', webSocketProtocol: 'sec-websocket-protocol',
  spaceLink: 'x-space-link', contentSha256: 'x-content-sha256' });
const TRANSPORT_HEADERS = new Set(['accept', 'accept-language', 'accept-encoding', 'if-none-match', 'if-modified-since']);
const CAPABILITIES = new Set(['identity.read', 'experts.read', 'experts.select', 'http.request', 'chat.stream', 'files.upload']);
// This is only the desktop's transport family allowlist. The box resolves each
// exact route/resource/action against current authority; these names grant none.
const APP_FAMILIES = Object.freeze({
  'wanx-host': ['app-studio', 'semantica', 'personal-space', 'clipboard', 'agents', 'chat', 'dialogue', 'assistant', 'browser', 'notifications', 'platform'],
  'centaurai.wanx.ai-browser': ['agents', 'chat', 'browser'],
  'centaurai.wanx.centaurloop': ['agents', 'chat'],
  'centaurai.wanx.superadvisors': ['agents', 'chat', 'super-advisory'],
  'centaurai.wanx.dialogue': ['dialogue', 'assistant', 'agents', 'chat'],
  'centaurai.wanx.zhijun': ['agents', 'chat'],
  'centaurai.wanx.semantica': ['semantica'],
  'centaurai.wanx.new-media-toolkit': ['agents', 'chat'],
  'centaurai.wanx.huohua-publisher': ['agents', 'chat'],
  'ai.wanx.studio': ['app-studio', 'agents', 'chat', 'browser'],
});
const companyApplication = value => /^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(value);
const failure = (suffix) => { const code = suffix.startsWith('LOCAL_') ? suffix : `LOCAL_DATA_${suffix}`; return Object.assign(new Error(code), { code }); };
const requireValue = (value, suffix = 'INVALID') => { if (!value) throw failure(suffix); };
const id = () => randomBytes(32).toString('base64url');
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const clone = (value) => structuredClone(value);

function requestHeaders(value = {}) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const result = {}, allowed = new Set([...Object.values(SELECTORS), ...TRANSPORT_HEADERS]);
  for (const [name, item] of Object.entries(value)) {
    const key = name.toLowerCase();
    // Credentials and asserted hashes never cross this interface. A caller may
    // not smuggle a duplicate using a different spelling.
    if (['content-length', 'host', 'origin', 'referer', 'connection'].includes(key)) continue;
    requireValue(allowed.has(key) && !Object.hasOwn(result, key), 'FORBIDDEN');
    requireValue(typeof item === 'string' && /^[\x20-\x7e]*$/.test(item) && item.length <= 8192);
    result[key] = item;
  }
  requireValue(Object.entries(result).reduce((n, [k, v]) => n + k.length + v.length, 0) <= 16384);
  return result;
}

function selectorValues(headers) {
  return Object.fromEntries(Object.entries(SELECTORS).map(([field, name]) => [field, headers[name] ?? null]));
}

function boundedJson(value, limit) {
  // Bound work before JSON.stringify can allocate an arbitrarily deep/large
  // intermediate string or invoke a caller-controlled getter/toJSON method.
  let budget = Math.min(limit, 16 * MIB);
  const seen = new Set();
  const charge = count => { budget -= count; requireValue(budget >= 0, 'BODY_TOO_LARGE'); };
  function walk(item, depth = 0) {
    requireValue(depth <= 40);
    if (item === null) { charge(4); return; }
    if (typeof item === 'string') { charge(item.length * 6 + 2); return; }
    if (typeof item === 'boolean') { charge(5); return; }
    if (typeof item === 'number') { requireValue(Number.isFinite(item)); charge(32); return; }
    requireValue(item && typeof item === 'object' && !seen.has(item));
    requireValue(Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item)));
    seen.add(item); charge(2);
    if (Array.isArray(item)) {
      requireValue(item.length <= 1000000, 'BODY_TOO_LARGE');
      for (let index = 0; index < item.length; index++) {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        requireValue(property && Object.hasOwn(property, 'value')); charge(1); walk(property.value, depth + 1);
      }
    } else for (const key of Reflect.ownKeys(item)) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      requireValue(typeof key === 'string' && property.enumerable && Object.hasOwn(property, 'value'));
      charge(key.length * 6 + 4); walk(property.value, depth + 1);
    }
    seen.delete(item);
  }
  walk(value); return JSON.stringify(value);
}

function routeLimit(applicationId, rawTarget, method, transport) {
  validateRawTarget(rawTarget);
  requireValue((Object.hasOwn(APP_FAMILIES, applicationId) || companyApplication(applicationId)), 'FORBIDDEN');
  requireValue(typeof rawTarget === 'string' && /^\/(?!\/)[\x21-\x7e]*$/.test(rawTarget)
    && rawTarget.length <= 8192 && !/[\\#]/.test(rawTarget));
  const url = new URL(rawTarget, 'https://local.invalid');
  requireValue(!['token', 'access_token'].some((key) => url.searchParams.has(key)), 'FORBIDDEN');
  requireValue(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method));
  const pathname = rawTarget.split('?')[0];
  const family = /^\/api\/([^/?]+)/.exec(pathname)?.[1];
  const profile = /^\/api\/auth\/me(?:\/avatar)?$/.test(pathname) && ['GET', 'PATCH', 'POST', 'DELETE'].includes(method);
  const assistantMetadata = ['wanx-host', 'centaurai.wanx.dialogue'].includes(applicationId)
    && transport === 'http' && ['GET', 'HEAD'].includes(method)
    && /^(?:\/api\/providers\/(?:resolved|active-model)|\/api\/preferences|\/api\/settings\/timezone)$/.test(pathname);
  const asset = transport === 'http' && ['GET', 'HEAD'].includes(method)
    && (pathname === '/' || /^\/(?:assets|static)\/[A-Za-z0-9_./-]+$/.test(pathname)
      || /^\/(?:favicon\.ico|manifest\.webmanifest|logo\.svg)$/.test(pathname));
  if (companyApplication(applicationId)) {
    const ownRuntime = pathname === `/api/app-studio/apps/${applicationId}/runtime` && method === 'POST';
    const instance = /^\/api\/app-studio\/runtime\/[A-Za-z0-9_-]{1,128}(?:\/(?:invoke|files))?$/.test(pathname) && (method === 'POST' && /\/(?:invoke|files)$/.test(pathname) || method === 'DELETE' && !/\/(?:invoke|files)$/.test(pathname));
    requireValue(transport === 'http' && (pathname === '/api/auth/me' && method === 'GET' || ownRuntime || instance), 'FORBIDDEN');
    return method === 'GET' ? 0 : 100 * MIB;
  }
  const teamManagement = applicationId === 'wanx-host' && transport === 'http' && ((pathname === '/api/admin/applications' && ['GET', 'POST'].includes(method)) || /^\/api\/admin\/applications\/[A-Za-z0-9._-]{1,128}(?:\/(?:deployment|access))?$/.test(pathname) && ['GET', 'PUT'].includes(method));
  requireValue(profile || asset || assistantMetadata || teamManagement || (family && APP_FAMILIES[applicationId].includes(family)), 'FORBIDDEN');
  if (transport === 'websocket') requireValue(method === 'GET' && /(?:\/ws|\/stream|\/terminal)$/.test(pathname), 'FORBIDDEN');
  if (asset || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return 0;
  // Archive exceptions must be explicitly registered. Ordinary routes never
  // inherit the archive's larger limit from a substring or caller header.
  if (method === 'POST' && /^\/api\/agents\/[A-Za-z0-9_-]+\/workspace\/archive$/.test(pathname)) return 200 * MIB;
  return 100 * MIB;
}

function safeResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !key.startsWith('x-centuarai-') && !['set-cookie', 'authorization', 'x-octop-access-token', 'location',
    'x-centuarai-data-proof', 'x-centuarai-gateway-proof', 'proxy-authenticate', 'connection', 'transfer-encoding', 'keep-alive'].includes(key)));
}

// A request receives no HTTP bytes until the actual TLS peer has the saved key.
function pinBeforeWrite(request, pin, pinnedSockets, operation, pinnedByDialer) {
  request.once('socket', (socket) => {
    const verified = () => {
      try {
        if (pinnedSockets.has(socket) || pinnedByDialer?.(socket)) { pinnedSockets.add(socket); operation(); return; }
        const cert = socket.getPeerX509Certificate?.();
        requireValue(cert, 'TLS_PIN_MISMATCH');
        const actual = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest();
        requireValue(timingSafeEqual(actual, pin), 'TLS_PIN_MISMATCH');
        socket.disableRenegotiation?.(); pinnedSockets.add(socket); operation();
      } catch (error) { request.destroy(error); }
    };
    if (socket.encrypted && !socket.connecting && socket._secureEstablished) verified();
    else socket.once('secureConnect', verified);
  });
}

function pinnedTransport({ descriptor, route, guard }) {
  const target = new URL(route?.url || descriptor.baseUrl);
  requireValue(target.protocol === 'https:' && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash);
  const pin = Buffer.from(descriptor.tlsSpkiSha256, 'base64url');
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2, maxCachedSessions: 0, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
  if (route?.agent) agent.createConnection = route.agent.createConnection.bind(route.agent);
  const requests = new Set(), sockets = new Set();
  const pinnedSockets = new WeakSet();
  const pinnedByDialer = route?.agent?.isPinnedSocket
    ? socket => route.agent.isPinnedSocket(socket, descriptor.tlsSpkiSha256) : null;
  let closed = false;
  const live = () => { requireValue(!closed, 'SESSION_CLOSED'); guard(); };

  async function request({ path: rawTarget, method = 'GET', headers = {}, body, signal, stream = false, idleTimeoutMs = 0, maxResponseBytes = 32 * MIB, freshConnection = false }) {
    live();
    return new Promise((resolve, reject) => {
      const dedicated = freshConnection ? new https.Agent({ ...agent.options, keepAlive: false, maxCachedSessions: 0 }) : null;
      if (dedicated && route?.agent) dedicated.createConnection = route.agent.createConnection.bind(route.agent);
      const req = https.request(target, { path: rawTarget, method, headers, agent: dedicated || agent, signal, maxHeaderSize: 32768 });
      requests.add(req);
      let uploadDeadline;
      if (body && typeof body.pipe === 'function') {
        uploadDeadline = setTimeout(() => req.destroy(failure('STAGING_UNAVAILABLE')), 300000); uploadDeadline.unref?.();
        req.once('finish', () => clearTimeout(uploadDeadline));
      }
      let timer = setTimeout(() => req.destroy(failure('TIMEOUT')), 10000);
      timer.unref?.();
      req.once('close', () => { requests.delete(req); clearTimeout(timer); clearTimeout(uploadDeadline); dedicated?.destroy(); if (body && typeof body.destroy === 'function') body.destroy(); });
      req.once('error', reject);
      if (idleTimeoutMs) req.setTimeout(Math.min(idleTimeoutMs, 15000), () => req.destroy(failure('TIMEOUT')));
      req.once('response', (incoming) => {
        clearTimeout(timer);
        try { live(); } catch (error) { incoming.destroy(); reject(error); return; }
        const result = { status: incoming.statusCode || 502, headers: safeResponseHeaders(incoming.headers) };
        if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
          incoming.destroy(); reject(failure('REDIRECT_REFUSED')); return;
        }
        incoming.on('error', reject);
        if (stream) { resolve({ ...result, body: incoming }); return; }
        const chunks = []; let size = 0;
        incoming.on('data', (chunk) => {
          try { live(); size += chunk.length; requireValue(size <= maxResponseBytes, 'BODY_TOO_LARGE'); chunks.push(chunk); }
          catch (error) { incoming.destroy(error); }
        });
        incoming.once('end', () => { try { live(); resolve({ ...result, body: Buffer.concat(chunks) }); } catch (error) { reject(error); } });
      });
      pinBeforeWrite(req, pin, pinnedSockets, () => {
        live(); clearTimeout(timer);
        if (body && typeof body.pipe === 'function') { body.once('error', (error) => req.destroy(error)); body.pipe(req); }
        else req.end(body);
      }, pinnedByDialer);
    });
  }

  return {
    request,
    async control(endpoint, value, options = {}) {
      const bytes = Buffer.from(JSON.stringify(value));
      const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(options.signal ? [options.signal] : [])]);
      const response = await request({ path: `/local-trust/v1/data/${endpoint}`, method: 'POST', body: bytes,
        headers: { 'content-type': 'application/json', accept: 'application/jose', 'content-length': String(bytes.length), 'cache-control': 'no-store' }, maxResponseBytes: 65536, ...options, signal });
      requireValue(response.body.length <= 65536, 'INVALID');
      if (response.status !== 200) {
        let parsed; try { parsed = JSON.parse(response.body); } catch {}
        throw failure(ERROR_CODES.has(parsed?.code) && Object.keys(parsed).length === 1 ? parsed.code : 'FORBIDDEN');
      }
      requireValue(String(response.headers['content-type'] || '').split(';')[0] === 'application/jose');
      return response.body.toString('ascii');
    },
    async openWebSocket({ path: rawTarget, headers, protocols, signal, proofForUpgrade }) {
      live();
      const url = new URL(target); url.protocol = 'wss:';
      let socket;
      const stop = () => socket?.terminate();
      requireValue(!signal?.aborted, 'SESSION_CLOSED');
      socket = new WebSocket(url.origin + rawTarget, protocols, {
        headers, agent, maxPayload: 16 * MIB, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 10000,
        finishRequest(req) {
          requests.add(req); req.once('close', () => requests.delete(req));
          try {
            live();
            const proof = proofForUpgrade(String(req.getHeader('sec-websocket-key')), req.getHeader('sec-websocket-protocol') ?? null);
            req.setHeader('X-Centuarai-Data-Proof', proof);
            pinBeforeWrite(req, pin, pinnedSockets, () => { live(); req.end(); }, pinnedByDialer);
          } catch (error) { req.destroy(error); }
        },
      });
      sockets.add(socket); signal?.addEventListener('abort', stop, { once: true });
      socket.once('close', () => { sockets.delete(socket); signal?.removeEventListener('abort', stop); });
      await new Promise((resolve, reject) => {
        socket.once('open', () => { try { live(); socket.pause(); resolve(); setImmediate(() => { if (socket.readyState === WebSocket.OPEN) socket.resume(); }); } catch (error) { stop(); reject(error); } });
        socket.once('error', reject); socket.once('close', () => reject(failure('SESSION_CLOSED')));
      });
      const send = socket.send.bind(socket);
      socket.send = (data, ...args) => {
        try {
          live();
          const size = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? data?.length ?? 0;
          requireValue(Number.isSafeInteger(size) && size <= 16 * MIB && socket.bufferedAmount + size <= 16 * MIB, 'CAPACITY');
        } catch (error) {
          socket.terminate(); const callback = args.findLast(value => typeof value === 'function');
          if (callback) queueMicrotask(() => callback(error)); return;
        }
        return send(data, ...args);
      };
      return socket;
    },
    close() {
      closed = true;
      for (const req of requests) req.destroy(failure('SESSION_CLOSED'));
      for (const socket of sockets) socket.terminate();
      agent.destroy();
    },
  };
}

/** Independent main-owned local data authority. No credential or signer escapes. */
export function createLocalDataAccess({ vault, stagingDirectory, protectDirectory, clock = Date.now,
  monotonicClock = () => performance.now(), transportFactory = pinnedTransport } = {}) {
  requireValue(vault && typeof vault.signDataSession === 'function' && typeof vault.signDataSessionIntent === 'function'
    && typeof vault.subscribe === 'function');
  requireValue(typeof stagingDirectory === 'string' && stagingDirectory.length > 0);
  const sessionInternals = new WeakMap();
  const root = path.resolve(stagingDirectory), sessions = new Set(), pending = new Set(), knownBoxes = new Set(), listeners = new Set();
  const launches = new Map();
  let closed = false, reserved = 0, prepared;

  function notify(type, reason = null) {
    for (const listener of listeners) { try { listener(Object.freeze({ type, reason, ...snapshot() })); } catch {} }
  }
  function snapshot() {
    const value = vault.snapshot();
    return { phase: value.locked ? 'locked' : 'unlocked', profileId: value.profile?.profileId || null,
      clientId: value.profile?.clientId || null, generation: value.generation };
  }
  function getAssociation(boxId) {
    requireValue(!closed, 'SESSION_CLOSED');
    requireValue(!vault.snapshot().locked, 'LOCAL_IDENTITY_LOCKED');
    const association = vault.readState().boxes?.[boxId];
    requireValue(association?.bindingId && association?.descriptor, 'REQUIRED');
    knownBoxes.add(boxId);
    return clone(association);
  }
  function listBoxes() {
    if (vault.snapshot().locked) return [...knownBoxes].map((boxId) => ({ boxId, locked: true }));
    const boxes = vault.readState().boxes || {};
    return Object.entries(boxes).filter(([, value]) => value?.bindingId && value?.descriptor).map(([boxId, value]) => {
      knownBoxes.add(boxId);
      return { boxId, locked: false, principalId: value.principalId, bindingId: value.bindingId, role: value.role,
        descriptor: clone(value.descriptor) };
    });
  }
  function invalidate(reason = 'lock') {
    for (const controller of pending) controller.abort();
    for (const session of [...sessions]) session.invalidate(reason);
    notify('invalidated', reason);
  }
  const unsubscribe = vault.subscribe((event) => {
    if (event.type === 'locked') invalidate(event.reason || 'lock');
    else if (event.type === 'state-changed') { listBoxes(); notify('changed'); }
    else notify('changed');
  });

  async function prepareDirectory() {
    if (prepared) return prepared;
    prepared = (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const info = await lstat(root);
      requireValue(info.isDirectory() && !info.isSymbolicLink(), 'STAGING_UNAVAILABLE');
      if (process.platform === 'win32') { requireValue(typeof protectDirectory === 'function', 'STAGING_UNAVAILABLE'); await protectDirectory(root); }
      else requireValue(info.uid === process.getuid() && !(info.mode & 0o077), 'STAGING_UNAVAILABLE');
      // This directory is dedicated to this one main process. Only our random
      // orphan names are removed, never arbitrary caller-selected files.
      for (const name of await readdir(root)) {
        requireValue(/^body-[A-Za-z0-9_-]{43}\.tmp$/.test(name), 'STAGING_UNAVAILABLE');
        const target = path.join(root, name), entry = await lstat(target);
        requireValue(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1, 'STAGING_UNAVAILABLE');
        await unlink(target);
      }
    })().catch((error) => { prepared = null; throw error; });
    return prepared;
  }

  async function stage(body, { applicationId, launchId, limit, signal, guard }) {
    if (body === undefined || body === null) return { bodySha256: EMPTY_HASH, bodyBytes: 0, cleanup() {}, stream: () => undefined };
    let source;
    if (body && typeof body.pipe === 'function') source = body;
    else {
      requireValue(!Buffer.isBuffer(body) || body.length <= limit, 'BODY_TOO_LARGE');
      requireValue(typeof body !== 'string' || Buffer.byteLength(body) <= limit, 'BODY_TOO_LARGE');
      const bytes = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(typeof body === 'string' ? body : boundedJson(body, limit));
      requireValue(bytes.length <= limit, 'BODY_TOO_LARGE');
      if (!bytes.length) return { bodySha256: EMPTY_HASH, bodyBytes: 0, cleanup() {}, stream: () => undefined };
      source = Readable.from([bytes]);
    }
    // IncomingMessage is a stream even for bodyless GET/HEAD. Consume it under
    // the same bounded staging guard; a zero-byte route must reject actual
    // bytes, not the existence of the stream object supplied by the Host.
    requireValue(Number.isSafeInteger(limit) && limit >= 0, 'BODY_TOO_LARGE');
    const scope = `${applicationId}:${launchId}`;
    const usage = launches.get(scope) || { bytes: 0, count: 0 };
    // Unknown length streams reserve the route maximum before opening a file.
    requireValue(usage.count < 2 && usage.bytes + limit <= 400 * MIB && reserved + limit <= 1024 * MIB, 'CAPACITY');
    usage.count++; usage.bytes += limit; launches.set(scope, usage); reserved += limit;
    let handle, file, released = false, absolute, idle;
    const stop = () => source.destroy(failure('SESSION_CLOSED'));
    const cleanup = async () => {
      if (released) return; released = true;
      clearTimeout(absolute); clearTimeout(idle); signal.removeEventListener('abort', stop);
      await handle?.close().catch(() => {}); handle = null;
      if (file) await unlink(file).catch(() => {});
      usage.count--; usage.bytes -= limit; reserved -= limit;
      if (!usage.count) launches.delete(scope);
    };
    try {
      guard(); requireValue(!signal.aborted, 'SESSION_CLOSED');
      await prepareDirectory(); guard();
      file = path.join(root, `body-${id()}.tmp`);
      handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const before = await handle.stat(); requireValue(before.isFile() && before.nlink === 1, 'STAGING_UNAVAILABLE');
      const timeout = () => source.destroy(failure('STAGING_UNAVAILABLE'));
      absolute = setTimeout(timeout, 300000); absolute.unref?.();
      const progress = () => { clearTimeout(idle); idle = setTimeout(timeout, 15000); idle.unref?.(); };
      signal.addEventListener('abort', stop, { once: true }); progress();
      const hash = createHash('sha256'); let length = 0;
      for await (const input of source) {
        guard(); const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
        length += chunk.length; requireValue(length <= limit, 'BODY_TOO_LARGE');
        hash.update(chunk); await handle.writeFile(chunk); progress();
      }
      guard(); clearTimeout(idle); clearTimeout(absolute);
      const after = await handle.stat(), linked = await lstat(file);
      requireValue(after.dev === before.dev && after.ino === before.ino && after.nlink === 1 && after.size === length
        && linked.dev === before.dev && linked.ino === before.ino && !linked.isSymbolicLink(), 'STAGING_UNAVAILABLE');
      return { bodySha256: hash.digest('base64url'), bodyBytes: length, cleanup,
        stream: () => handle.createReadStream({ start: 0, autoClose: false }) };
    } catch (error) { source.destroy(); await cleanup(); throw error; }
  }

  async function connect({ boxId, route, signal, applicationId = 'wanx-host', launchId = id(), capabilities,
    expectedAuthorization, expectedHardExpiry } = {}, renewalSession = null) {
    requireValue((Object.hasOwn(APP_FAMILIES, applicationId) || companyApplication(applicationId)) && validId(launchId), 'FORBIDDEN');
    requireValue(sessions.size < 256 && pending.size < 32, 'CAPACITY');
    requireValue(capabilities === undefined || Array.isArray(capabilities) && new Set(capabilities).size === capabilities.length
      && capabilities.every(value => CAPABILITIES.has(value)), 'FORBIDDEN');
    if (capabilities !== undefined) capabilities = [...capabilities];
    const allowedCapabilities = capabilities === undefined ? null : new Set(capabilities);
    const association = getAssociation(boxId), descriptor = validateDescriptor(association.descriptor), initial = vault.snapshot();
    const boxKeyThumbprint = publicKeyThumbprint(descriptor.boxKey), ownershipEpoch = association.checkpoint?.ownershipEpoch;
    const renewal = renewalSession === null ? null : sessionInternals.get(renewalSession);
    requireValue(renewalSession === null || renewal && renewal.boxId === boxId
      && renewal.applicationId === applicationId && renewal.launchId === launchId, 'FORBIDDEN');
    requireValue(descriptor.boxId === boxId, 'CONTEXT_CHANGED');
    requireValue(Number.isSafeInteger(ownershipEpoch) && ownershipEpoch > 0, 'CONTEXT_CHANGED');
    const controller = new AbortController(); pending.add(controller);
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let stopped = false, stopReason = null, channelKey, transport, heartbeatTimer, watchdog, renewalTimer, sequence = 0, sessionResponse;
    let anchorMs = clock(), anchorMono = monotonicClock(), lastWall = clock();
    const invalidated = new Set(), renewalListeners = new Set(), operations = new Set(), children = new Set();
    const permit = (rawTarget, method, transport) => {
      const limit = routeLimit(applicationId, rawTarget, method, transport);
      if (allowedCapabilities) {
        const pathname = rawTarget.split('?')[0];
        const permitted = pathname === '/api/auth/me' ? method === 'GET' && allowedCapabilities.has('identity.read')
          : allowedCapabilities.has('http.request')
            || (transport === 'websocket' && /^\/api\/(?:chat|dialogue)\//.test(pathname) && allowedCapabilities.has('chat.stream'))
            || (['GET', 'HEAD'].includes(method) && /^\/api\/agents(?:\/|$)/.test(pathname) && allowedCapabilities.has('experts.read'))
            || (method === 'POST' && /^\/api\/agents\/[A-Za-z0-9_-]+\/select$/.test(pathname) && allowedCapabilities.has('experts.select'))
            || (['POST', 'PUT'].includes(method) && /\/uploads(?:\/|$)/.test(pathname) && allowedCapabilities.has('files.upload'));
        requireValue(permitted, 'FORBIDDEN');
      }
      return limit;
    };
    const serverNow = () => Math.floor(anchorMs + monotonicClock() - anchorMono);
    const guard = () => {
      const current = vault.snapshot(), wall = clock();
      requireValue(!closed && !stopped && !combined.aborted && !current.locked
        && current.generation === initial.generation && current.profile?.profileId === initial.profile.profileId, 'SESSION_CLOSED');
      if (!sessionResponse && renewal) renewal.guard();
      requireValue(Number.isSafeInteger(wall) && wall >= lastWall, 'CLOCK_ROLLBACK'); lastWall = wall;
      if (sessionResponse) requireValue(serverNow() < Math.min(sessionResponse.expiresAtMs, sessionResponse.presenceExpiresAtMs), 'SESSION_EXPIRED');
    };
    const stop = (reason = 'user-close') => {
      if (stopped) return;
      stopped = true; stopReason = reason; clearTimeout(heartbeatTimer); clearInterval(watchdog); clearTimeout(renewalTimer);
      channelKey = null; controller.abort();
      for (const operation of operations) operation.abort();
      for (const child of children) child.invalidate(reason);
      transport?.close(); pending.delete(controller); sessions.delete(session);
      for (const listener of invalidated) { try { listener(reason); } catch {} }
      invalidated.clear(); renewalListeners.clear(); notify('changed');
    };
    const syncTime = (body) => { anchorMs = Math.max(serverNow(), body.issuedAtMs); anchorMono = monotonicClock(); };
    const proof = (kind, values) => {
      guard(); const now = serverNow();
      const payload = { schemaVersion: 1, purpose: `centuarai.local-data.${kind}`, boxId,
        sessionId: sessionResponse.sessionId, gatewayGeneration: sessionResponse.gatewayGeneration,
        applicationId, launchId, jti: id(), issuedAtMs: now,
        expiresAtMs: Math.min(now + (kind === 'request' ? 10000 : 3000), sessionResponse.expiresAtMs), ...values };
      return kind === 'heartbeat' ? signHeartbeat(payload, channelKey)
        : kind === 'renewal' ? signRenewal(payload, channelKey) : signRequest(payload, channelKey);
    };
    async function heartbeat() {
      try {
        guard(); const next = ++sequence;
        const result = await transport.control('heartbeat', { proof: proof('heartbeat', { sequence: next }) }, { signal: combined });
        guard(); const response = verifyDataResponse(result, { descriptor, kind: 'heartbeat', nowMs: clock(),
          expected: { sessionId: sessionResponse.sessionId, sequence: next, bindingRevision: sessionResponse.authorization.bindingRevision } });
        sessionResponse.presenceExpiresAtMs = Math.min(response.body.presenceExpiresAtMs, sessionResponse.expiresAtMs);
        sessionResponse.authorization.authorizationVersion = response.body.authorizationVersion;
        syncTime(response.body); guard();
        heartbeatTimer = setTimeout(heartbeat, 1000); heartbeatTimer.unref?.();
      } catch (error) { stop(error.code || 'heartbeat-failed'); }
    }
    const deriveChild = async ({ applicationId: childId, launchId: childLaunch = id(), capabilities: childCapabilities } = {}, expected = {}, renewalSession = null) => {
      guard(); requireValue(applicationId === 'wanx-host' && childId !== 'wanx-host', 'FORBIDDEN');
      const child = await connect({ boxId, route, applicationId: childId, launchId: childLaunch, capabilities: childCapabilities, signal: combined, ...expected }, renewalSession);
      try { guard(); children.add(child); child.onInvalidated(() => children.delete(child)); return child; }
      catch (error) { child.close(); throw error; }
    };
    const session = Object.freeze({
      kind: 'local-trust-v1',
      isLive() { try { guard(); return true; } catch { return false; } },
      context() {
        guard(); const auth = sessionResponse.authorization;
        return { profileId: initial.profile.profileId, clientId: initial.profile.clientId, generation: initial.generation,
          boxId, boxKeyThumbprint, principalId: auth.principalId, bindingId: auth.bindingId, ownershipEpoch: auth.ownershipEpoch,
          authorizationVersion: auth.authorizationVersion, sessionId: sessionResponse.sessionId, applicationId, launchId,
          grants: clone(auth.grants), authorization: 'local-trust-v1', route: route?.mode === 'netbird' ? 'p2p' : 'lan' };
      },
      async request({ path: rawTarget, method = 'GET', headers = {}, body, signal: requestSignal, stream = false, idleTimeoutMs = 0, freshConnection = false } = {}) {
        guard(); requireValue(operations.size < 16, 'CAPACITY'); const limit = permit(rawTarget, method, 'http'), outgoing = requestHeaders(headers);
        requireValue(!outgoing['sec-websocket-key'] && !outgoing['sec-websocket-protocol']);
        const operation = new AbortController(); operations.add(operation);
        const activeSignal = AbortSignal.any([combined, operation.signal, ...(requestSignal ? [requestSignal] : [])]);
        let staged;
        try {
          staged = await stage(body, { applicationId, launchId, limit, signal: activeSignal, guard }); guard();
          if (Object.hasOwn(outgoing, 'x-content-sha256')) outgoing['x-content-sha256'] = Buffer.from(staged.bodySha256, 'base64url').toString('hex');
          const signed = proof('request', { transport: 'http', method, rawTarget, headers: selectorValues(outgoing), bodySha256: staged.bodySha256, bodyBytes: staged.bodyBytes });
          const result = await transport.request({ path: rawTarget, method, headers: { ...outgoing, 'x-centuarai-data-proof': signed,
            'content-length': String(staged.bodyBytes), 'cache-control': 'no-store' }, body: staged.stream(), signal: activeSignal, stream,
            idleTimeoutMs: idleTimeoutMs || (staged.bodyBytes ? 15000 : 0), freshConnection });
          guard();
          if (stream) {
            const cleanup = () => { operations.delete(operation); void staged.cleanup(); };
            result.body.once('close', cleanup); result.body.once('end', cleanup);
          } else { operations.delete(operation); await staged.cleanup(); }
          return { ...result, headers: safeResponseHeaders(result.headers) };
        } catch (error) { operation.abort(); operations.delete(operation); await staged?.cleanup(); throw error; }
      },
      async openWebSocket({ path: rawTarget, headers = {}, protocols = [], signal: requestSignal } = {}) {
        guard(); requireValue(operations.size < 16, 'CAPACITY'); permit(rawTarget, 'GET', 'websocket'); const outgoing = requestHeaders(headers);
        requireValue(!outgoing['sec-websocket-key'] && !outgoing['sec-websocket-protocol']);
        const operation = new AbortController(); operations.add(operation);
        const activeSignal = AbortSignal.any([combined, operation.signal, ...(requestSignal ? [requestSignal] : [])]);
        try {
          const socket = await transport.openWebSocket({ path: rawTarget, headers: outgoing, protocols, signal: activeSignal,
            proofForUpgrade(key, protocol) { return proof('request', { transport: 'websocket', method: 'GET', rawTarget,
              headers: selectorValues({ ...outgoing, 'sec-websocket-key': key, ...(protocol === null ? {} : { 'sec-websocket-protocol': protocol }) }), bodySha256: EMPTY_HASH, bodyBytes: 0 }); } });
          guard(); socket.once('close', () => operations.delete(operation));
          socket.on('message', () => { try { guard(); } catch { socket.terminate(); } });
          return socket;
        } catch (error) { operation.abort(); operations.delete(operation); throw error; }
      },
      deriveApplication: options => deriveChild(options),
      renew({ signal: renewalSignal, parentSession } = {}) {
        guard();
        if (applicationId !== 'wanx-host') {
          const parent = sessionInternals.get(parentSession);
          requireValue(parent && typeof parent.deriveChild === 'function' && parentSession.isLive() && parent.boxId === boxId, 'FORBIDDEN');
          return parent.deriveChild({ applicationId, launchId, capabilities }, {
            expectedAuthorization: clone(sessionResponse.authorization), expectedHardExpiry: sessionResponse.expiresAtMs,
          }, session);
        }
        return connect({ boxId, route, applicationId, launchId, capabilities, signal: renewalSignal,
          expectedAuthorization: clone(sessionResponse.authorization), expectedHardExpiry: sessionResponse.expiresAtMs }, session);
      },
      onRenewalNeeded(listener) {
        requireValue(typeof listener === 'function'); renewalListeners.add(listener);
        if (!stopped && sessionResponse.expiresAtMs - serverNow() <= 15000) queueMicrotask(() => {
          if (!stopped && renewalListeners.has(listener)) listener();
        });
        return () => renewalListeners.delete(listener);
      },
      onInvalidated(listener) {
        requireValue(typeof listener === 'function');
        if (stopped) { listener(stopReason); return () => {}; }
        invalidated.add(listener); return () => invalidated.delete(listener);
      },
      invalidate: stop, close: stop,
    });
    sessionInternals.set(session, { boxId, applicationId, launchId, guard,
      renewalProof: values => proof('renewal', values), ...(applicationId === 'wanx-host' ? { deriveChild } : {}) });
    try {
      guard(); transport = transportFactory({ descriptor, route, guard });
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); channelKey = pair.privateKey;
      const proposedKey = pair.publicKey.export({ format: 'jwk' }), requestId = id();
      const intentNow = clock();
      const challengeJws = await transport.control(renewal ? 'renewal-challenge' : 'session-challenge',
        renewal ? { proof: renewal.renewalProof({ requestId, channelKey: proposedKey }) }
          : { proof: vault.signDataSessionIntent({ schemaVersion: 1, purpose: 'centuarai.local-data.session-intent',
            boxId, boxKeyThumbprint, bindingId: association.bindingId, applicationId, launchId, requestId,
            channelKey: proposedKey, jti: id(), issuedAtMs: intentNow, expiresAtMs: intentNow + 3000 }) }, { signal: combined });
      guard(); const challenge = verifyDataResponse(challengeJws, { descriptor, kind: 'session-challenge', nowMs: clock() }).body;
      anchorMs = challenge.issuedAtMs; anchorMono = monotonicClock();
      const now = serverNow();
      const accessProof = vault.signDataSession({ schemaVersion: 1, purpose: 'centuarai.local-data.session', boxId,
        boxKeyThumbprint, ownershipEpoch,
        principalId: association.principalId, bindingId: association.bindingId, clientId: initial.profile.clientId,
        gatewayGeneration: challenge.gatewayGeneration, challenge: challenge.challenge, requestId,
        issuedAtMs: now, expiresAtMs: Math.min(now + 30000, challenge.expiresAtMs), applicationId, launchId,
        channelKey: proposedKey });
      guard();
      const sessionJws = await transport.control(renewal ? 'renewals' : 'sessions', { accessProof }, { signal: combined }); guard();
      const response = verifyDataResponse(sessionJws, { descriptor, kind: 'session', nowMs: clock(),
        expected: { gatewayGeneration: challenge.gatewayGeneration, applicationId, launchId, channelKeyThumbprint: publicKeyThumbprint(pair.publicKey.export({ format: 'jwk' })) } });
      const auth = response.body.authorization;
      requireValue(auth.boxId === boxId && auth.boxKeyThumbprint === boxKeyThumbprint
        && auth.principalId === association.principalId && auth.bindingId === association.bindingId
        && auth.clientId === initial.profile.clientId
        && auth.ownershipEpoch === ownershipEpoch, 'CONTEXT_CHANGED');
      if (expectedAuthorization) {
        requireValue(['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'principalId', 'clientId', 'bindingId',
          'bindingRevision', 'principalSecurityVersion', 'grantExpiresAtMs'].every(field => auth[field] === expectedAuthorization[field])
          && JSON.stringify(auth.grants) === JSON.stringify(expectedAuthorization.grants)
          && response.body.expiresAtMs > expectedHardExpiry, 'CONTEXT_CHANGED');
      }
      sessionResponse = clone(response.body); anchorMs = sessionResponse.issuedAtMs; anchorMono = monotonicClock(); guard();
      pending.delete(controller); sessions.add(session);
      combined.addEventListener('abort', () => stop('lock'), { once: true });
      heartbeatTimer = setTimeout(heartbeat, 1000); heartbeatTimer.unref?.();
      watchdog = setInterval(() => { try { guard(); } catch (error) { stop(error.code); } }, 100); watchdog.unref?.();
      if (applicationId === 'wanx-host') {
        renewalTimer = setTimeout(() => { for (const listener of renewalListeners) { try { listener(); } catch {} } },
          Math.max(0, sessionResponse.expiresAtMs - serverNow() - 15000)); renewalTimer.unref?.();
      }
      notify('changed'); return session;
    } catch (error) { stop(error.code || 'connection-failed'); throw error; }
  }
  async function ensureBackupNamespace(input) {
    const fields = ['profileId', 'boxId', 'boxKeyThumbprint', 'principalId', 'bindingId', 'ownershipEpoch'];
    requireValue(input !== null && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype
      && fields.every(field => Object.hasOwn(input, field))
      && Reflect.ownKeys(input).every(field => (fields.includes(field) || field === 'signal')
        && Object.hasOwn(Object.getOwnPropertyDescriptor(input, field), 'value')), 'INVALID');
    requireValue(input.signal === undefined || input.signal instanceof AbortSignal, 'INVALID');
    const expected = Object.fromEntries(fields.map(field => [field, input[field]]));
    const initial = vault.snapshot();
    const check = () => {
      const current = vault.snapshot();
      requireValue(!closed && !input.signal?.aborted && !current.locked, 'SESSION_CLOSED');
      requireValue(current.generation === initial.generation && current.profile?.profileId === expected.profileId,
        'CONTEXT_CHANGED');
      const association = getAssociation(expected.boxId);
      requireValue(association.descriptor.boxId === expected.boxId
        && publicKeyThumbprint(association.descriptor.boxKey) === expected.boxKeyThumbprint
        && association.principalId === expected.principalId && association.bindingId === expected.bindingId
        && association.checkpoint?.ownershipEpoch === expected.ownershipEpoch, 'CONTEXT_CHANGED');
    };
    check();
    let session;
    try {
      // This fixed main-process operation only creates the current native
      // namespace through ordinary authorized reads. It never selects a UI
      // connection, imports a UID, or accepts caller paths/credentials.
      session = await connect({ boxId: expected.boxId, signal: input.signal });
      check();
      requireValue(fields.every(field => session.context()[field] === expected[field]), 'CONTEXT_CHANGED');
      for (const target of ['/api/personal-space/overview', '/api/clipboard/v1']) {
        check();
        const result = await session.request({ path: target, method: 'GET', signal: input.signal });
        check();
        requireValue(result.status >= 200 && result.status < 300,
          result.status === 401 || result.status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
      }
      return Object.freeze(expected);
    } finally { session?.close(); }
  }
  return Object.freeze({ snapshot, listBoxes, getAssociation, connect: options => connect(options), ensureBackupNamespace, invalidate,
    isProtectedBox: (boxId) => knownBoxes.has(boxId),
    subscribe(listener) { requireValue(typeof listener === 'function'); listeners.add(listener); return () => listeners.delete(listener); },
    close() { if (closed) return; closed = true; invalidate('closed'); unsubscribe(); listeners.clear(); },
  });
}
