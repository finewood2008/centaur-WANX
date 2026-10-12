const http = require('node:http');
const {Readable} = require('node:stream');
const {WebSocket} = require('ws');
const fail = code => Object.assign(new Error(code), {code});

// Main process only: renderer code never receives this credential.
function createHostClient({baseURL, token, timeoutMs = 15000} = {}) {
  let base;
  try { base = new URL(baseURL); } catch { throw fail('HOST_SESSION_MISSING'); }
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !token) throw fail('HOST_SESSION_INVALID');
  let closed = false, invalid = false, watching;
  const active = new Set(), sockets = new Set(), listeners = new Set();
  function invalidate() {
    if (invalid || closed) return;
    invalid = true;
    for (const req of active) req.destroy(fail('HOST_SESSION_EXPIRED'));
    for (const ws of sockets) ws.terminate();
    for (const listener of listeners) listener({code:'HOST_SESSION_EXPIRED'});
  }
  function assertLive() { if (closed || invalid) throw fail('HOST_SESSION_EXPIRED'); }
  function endpoint(path, control = false) {
    if (typeof path !== 'string' || !(control ? path.startsWith('/__wanx/') : path.startsWith('/api/')) || path.includes('\\') || path.includes('#')) throw fail('APPLICATION_PATH_NOT_ALLOWED');
    const value = new URL(path, base);
    if (value.origin !== base.origin || (!control && !value.pathname.startsWith('/api/'))) throw fail('APPLICATION_PATH_NOT_ALLOWED');
    return value;
  }
  function send(path, {method = 'GET', headers, body, signal} = {}, control = false) {
    assertLive();
    const target = endpoint(path, control);
    const outgoing = new Headers(headers);
    outgoing.set('authorization', `Bearer ${token}`);
    for (const key of ['host', 'connection', 'content-length', 'cookie', 'origin']) outgoing.delete(key);
    if (body !== undefined && !Buffer.isBuffer(body) && !(body instanceof Uint8Array) && typeof body !== 'string') {
      body = JSON.stringify(body);
      if (!outgoing.has('content-type')) outgoing.set('content-type', 'application/json');
    }
    return new Promise((resolve, reject) => {
      const req = http.request(target, {method, headers:Object.fromEntries(outgoing), signal, agent:false});
      active.add(req);
      const timer = setTimeout(() => req.destroy(fail('HOST_REQUEST_TIMEOUT')), timeoutMs);
      timer.unref();
      req.once('close', () => { clearTimeout(timer); active.delete(req); });
      req.on('error', error => reject(invalid ? fail('HOST_SESSION_EXPIRED') : error));
      req.once('response', res => {
        clearTimeout(timer);
        const code = res.headers['x-wanx-error'];
        if (code) {
          res.resume();
          if (['HOST_SESSION_EXPIRED', 'HOST_UNAUTHORIZED'].includes(code)) invalidate();
          return reject(fail(code));
        }
        resolve(res);
      });
      req.end(body);
    });
  }
  async function watch() {
    const res = await send('/__wanx/events', {}, true);
    if (res.statusCode !== 200 || !String(res.headers['content-type']).startsWith('text/event-stream')) {
      res.destroy(); invalidate(); throw fail('HOST_SESSION_EXPIRED');
    }
    res.setTimeout(30_000, () => res.destroy());
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) { res.destroy(); return invalidate(); }
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith('data: ')) continue;
        try { if (JSON.parse(frame.slice(6)).type === 'invalidated') invalidate(); }
        catch { invalidate(); }
      }
    });
    res.on('error', invalidate);
    res.once('close', invalidate);
  }
  async function context() {
    if (!watching) watching = watch().catch(error => { invalidate(); throw error; });
    await watching;
    const res = await send('/__wanx/context', {}, true);
    if (res.statusCode !== 200) { res.destroy(); invalidate(); throw fail('HOST_SESSION_EXPIRED'); }
    res.setEncoding('utf8');
    let text = '';
    for await (const chunk of res) {
      text += chunk;
      if (text.length > 65536) { res.destroy(); throw fail('HOST_INVALID_RESPONSE'); }
    }
    assertLive();
    return JSON.parse(text);
  }
  async function request(path, options = {}) {
    const res = await send(path, options);
    const headers = Object.fromEntries(Object.entries(res.headers).filter(([,v]) => v !== undefined).map(([k,v]) => [k,Array.isArray(v)?v.join(', '):v]));
    if ([204, 205, 304].includes(res.statusCode) || options.method === 'HEAD') {
      res.resume(); return new Response(null, {status:res.statusCode, headers});
    }
    return new Response(Readable.toWeb(res), {status:res.statusCode, headers});
  }
  async function openStream(path, {headers, protocols = []} = {}) {
    assertLive();
    const target = endpoint(path); target.protocol = 'ws:';
    const outgoing = new Headers(headers);
    for (const key of ['host', 'cookie', 'origin']) outgoing.delete(key);
    outgoing.set('authorization', `Bearer ${token}`);
    const ws = new WebSocket(target, protocols, {headers:Object.fromEntries(outgoing), handshakeTimeout:timeoutMs, followRedirects:false, perMessageDeflate:false, maxPayload:32*1024*1024});
    sockets.add(ws);
    ws.on('error', () => {});
    ws.once('close', () => sockets.delete(ws));
    ws.once('unexpected-response', (_req, res) => {
      if (['HOST_SESSION_EXPIRED', 'HOST_UNAUTHORIZED'].includes(res.headers['x-wanx-error'])) invalidate();
      res.destroy(); ws.terminate();
    });
    // Return before the handshake: consumers can attach handlers before frame one.
    return ws;
  }
  return Object.freeze({context, request, openStream,
    onSessionInvalidated(listener) {
      listeners.add(listener);
      if (invalid) queueMicrotask(() => { if (listeners.has(listener)) listener({code:'HOST_SESSION_EXPIRED'}); });
      return () => listeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true; listeners.clear();
      for (const req of active) req.destroy();
      for (const ws of sockets) ws.terminate();
    },
  });
}
function fromEnvironment(env = process.env) {
  if (!Object.keys(env).some(key => key.startsWith('WANX_HOST_') && env[key] !== undefined)) return null;
  if (env.WANX_HOST_TRANSPORT !== 'http-v1') throw fail('HOST_PROTOCOL_UNSUPPORTED');
  return createHostClient({baseURL:env.WANX_HOST_BASE_URL, token:env.WANX_HOST_TOKEN});
}
module.exports = {createHostClient, fromEnvironment};
