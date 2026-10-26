import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createApplicationSession } from "../app-host/session.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { createHostClient, fromEnvironment } from "../host-sdk/index.cjs";
import { setTimeout as delay } from "node:timers/promises";

const openSession = (connection, options = {}) => createApplicationSession({
  hostApplicationId: "wanx-host", applicationId: "test.application",
  installPath: path.join(os.tmpdir(), "wanx-session", "test.application"),
  createConnection: () => connection, ...options,
});

async function fixture(t, handler) {
  const box = http.createServer(handler);
  box.listen(0, "127.0.0.1");
  await once(box, "listening");
  const upstream = await createDashboardGateway({
    targetURL: `http://127.0.0.1:${box.address().port}`,
    session: { getToken: () => "box-secret", close() {} },
  });
  let live = true, phase = "ready";
  const listeners = new Set();
  const connection = {
    context() {
      if (!live) throw Object.assign(new Error("NETWORK_CHANGED"), { code: "NETWORK_CHANGED" });
      return { boxId: "102", user: { id: 4 }, connection: phase };
    },
    request: (input) => upstream.request(input),
    openStream: (input) => upstream.openWebSocket(input),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const session = await openSession(connection);
  const client = fromEnvironment(session.environment);
  const url = session.environment.WANX_HOST_BASE_URL, token = session.environment.WANX_HOST_TOKEN;
  t.after(async () => {
    client.close(); await session.close(); await upstream.close();
    box.closeAllConnections(); await new Promise(r => box.close(r));
  });
  return { box, session, url, token, client, change(value) { if (value === "invalid") live = false; else phase = value; for (const fn of listeners) fn(); } };
}

for (const ending of ['cancel', 'switch', 'host close', 'client close', 'source error']) {
test(`unfinished upload stops at both ends on ${ending}`, {timeout:3000}, async t => {
  let started, disconnected;
  const received = new Promise(resolve => {started = resolve;});
  const closed = new Promise(resolve => {disconnected = resolve;});
  const f = await fixture(t, (req, res) => {
    if (req.url !== '/api/upload') return res.end('{}');
    req.once('data', started);
    req.once('close', () => disconnected(req.complete));
  });
  await f.client.context();
  const source = new Readable({read() { this.push(Buffer.alloc(65536)); this._read = () => {}; }});
  t.after(() => source.destroy());
  const sourceClosed = new Promise(resolve => source.once('close', resolve));
  const controller = new AbortController();
  const request = f.client.request('/api/upload', {method:'POST', body:source, signal:controller.signal});
  const rejected = assert.rejects(request, ending === 'cancel' ? {name:'AbortError'} : undefined);
  await received;
  const invalidated = ending === 'switch' ? expired(f.client) : null;
  if (ending === 'cancel') controller.abort();
  else if (ending === 'switch') f.change('invalid');
  else if (ending === 'host close') await f.session.close();
  else if (ending === 'client close') f.client.close();
  else source.destroy(new Error('file read failed'));
  await rejected;
  await sourceClosed;
  assert.equal(await closed, false, 'the unfinished box upload must be disconnected');
  if (invalidated) {
    await invalidated;
    await assert.rejects(f.client.request('/api/test'), {code:'HOST_SESSION_EXPIRED'});
  }
  if (ending === 'cancel' || ending === 'source error') assert.equal((await f.client.request('/api/test')).status, 200);
});
}

for (const status of [413, 401]) {
test(`box ${status} during upload stops the Web stream and preserves response semantics`, {timeout:3000}, async t => {
  let calls = 0, cancelled;
  const stopped = new Promise(resolve => {cancelled = resolve;});
  const f = await fixture(t, (req, res) => {
    calls++;
    req.once('data', () => {
      res.writeHead(status, {'content-type':'application/json'});
      res.end(JSON.stringify({code:'BOX_UPLOAD_LIMIT', message:'business limit'}));
    });
  });
  await f.client.context();
  const body = new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(65536));},
    cancel() {cancelled();},
  });
  const request = f.client.request('/api/upload', {method:'POST', body});
  if (status === 413) {
    const response = await request;
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {code:'BOX_UPLOAD_LIMIT', message:'business limit'});
    assert.equal((await f.client.context()).boxId, '102');
  } else {
    await assert.rejects(request, {code:'HOST_SESSION_EXPIRED'});
    await assert.rejects(f.client.request('/api/test'), {code:'HOST_SESSION_EXPIRED'});
  }
  await stopped;
  assert.equal(calls, 1, 'uploads must never be replayed');
});
}

test("Host HTTP preserves business paths, JSON and binary; box credentials stay in the Host", async t => {
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.url, "/api/echo?q=hello");
    assert.equal(req.headers.authorization, "Bearer box-secret");
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(201, { "content-type": req.headers["content-type"], "set-cookie": "secret=box", "x-octop-access-token": "box-secret" });
    for await (const part of req) res.write(part);
    res.end();
  });
  assert.equal((await f.client.context()).boxId, "102");
  const response = await f.client.request("/api/echo?q=hello", { method: "POST", body: { hello: "盒子" } });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { hello: "盒子" });
  assert.equal(response.headers.get("set-cookie"), null);
  const bytes = Buffer.from([0, 255, 128, 10]);
  const binary = await f.client.request("/api/echo?q=hello", { method: "POST", headers: { "content-type": "application/octet-stream", cookie: "fake=1" }, body: bytes });
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), bytes);
  const typed = await f.client.request("/api/echo?q=hello", {method:"POST", headers:{'content-type':'application/octet-stream'}, body:new Uint8Array([0, 255, 17])});
  assert.deepEqual(new Uint8Array(await typed.arrayBuffer()), new Uint8Array([0, 255, 17]));
  const text = await f.client.request("/api/echo?q=hello", {method:"POST", headers:{'content-type':'text/plain'}, body:'原始字符串'});
  assert.equal(await text.text(), '原始字符串');
});

const expired = client => new Promise(resolve => client.onSessionInvalidated(resolve));

test('Host streams SSE incrementally and revokes open responses on a box switch', {timeout:3000}, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, {'content-type':'text/event-stream'}); res.write('data: first\n\n'); });
  await f.client.context();
  const response = await f.client.request('/api/events');
  const reader = response.body.getReader();
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: first\n\n');
  const invalidated = expired(f.client);
  f.change('invalid');
  assert.equal((await invalidated).code, 'HOST_SESSION_EXPIRED');
  await assert.rejects(reader.read());
  await assert.rejects(f.client.request('/api/anything'), {code:'HOST_SESSION_EXPIRED'});
  const raw = await fetch(f.url + '/api/anything', {headers:{authorization:`Bearer ${f.token}`}});
  assert.equal(raw.status, 401);
  assert.equal(raw.headers.get('x-wanx-error'), 'HOST_SESSION_EXPIRED');
});

test('Host WebSocket preserves the first frame and binary duplex, then closes on invalidation', {timeout:3000}, async t => {
  const {WebSocketServer} = await import('ws');
  const f = await fixture(t, (_req,res) => res.end());
  const wss = new WebSocketServer({server:f.box});
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'Bearer box-secret');
    assert.equal(new URL(req.url, 'http://box').searchParams.get('token'), 'box-secret');
    ws.send('first');
    ws.on('message', (data, binary) => ws.send(data, {binary}));
  });
  t.after(() => wss.close());
  await f.client.context();
  const ws = await f.client.openStream('/api/agents/a/chat/ws');
  assert.equal((await once(ws,'message'))[0].toString(), 'first');
  const message = once(ws,'message');
  ws.send(Buffer.from([0, 255, 17]));
  const [data, binary] = await message;
  assert.equal(binary, true); assert.deepEqual(data, Buffer.from([0,255,17]));
  const stopped = once(ws,'close');
  f.change('invalid');
  await stopped;
});

test('network recovery is retryable but never resurrects an invalidated launch', async t => {
  let calls = 0;
  const f = await fixture(t, (_req,res) => {calls++; res.end('{}');});
  await f.client.context();
  f.change('recovering');
  assert.equal(f.session.assertLive().connection, 'recovering');
  assert.equal((await f.client.context()).connection, 'recovering');
  await assert.rejects(f.client.request('/api/test'), {code:'NETWORK_NOT_READY'});
  assert.equal(calls, 0);
  f.change('ready');
  assert.equal(f.session.assertLive().connection, 'ready');
  assert.equal((await f.client.request('/api/test')).status, 200);
  const invalidated = expired(f.client);
  f.change('invalid'); await invalidated;
  f.change('ready');
  assert.throws(() => f.session.assertLive(), {code:'HOST_SESSION_EXPIRED'});
  await assert.rejects(f.client.context(), {code:'HOST_SESSION_EXPIRED'});
});

test('gateway validates credentials, browser origins and paths before reaching the box', async t => {
  let calls = 0;
  const f = await fixture(t, (_req,res) => {calls++;res.end('{}');});
  const raw = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get(f.url, {path, headers:{authorization:`Bearer ${f.token}`, ...headers}}, res => {res.resume();resolve(res.statusCode);});
    req.on('error', reject);
  });
  assert.equal(await raw('/api/test', {authorization:'Bearer wrong'}), 401);
  assert.equal(await raw('/api/test', {origin:'https://untrusted.test'}), 403);
  assert.equal(await raw('/api/test', {host:'untrusted.test'}), 403);
  assert.equal(await raw('/api/auth/logout'), 403);
  assert.equal((await f.client.context()).boxId, '102');
  for (const path of ['http://example.com/api/test','//example.com/api/test','/api/%2e%2e/admin','/api/%5csecret','/api/test?token=stolen','/api/test?access_token=stolen']) assert.equal(await raw(path), 400, path);
  assert.equal(calls, 0);
});

test('box session rejection revokes the launch and HTTP requests are never replayed', async t => {
  let calls = 0;
  const f = await fixture(t, (_req,res) => {calls++;res.writeHead(401);res.end('{}');});
  await f.client.context();
  const invalidated = expired(f.client);
  await assert.rejects(f.client.request('/api/action', {method:'POST', body:{action:'once'}}), {code:'HOST_SESSION_EXPIRED'});
  await invalidated;
  await assert.rejects(f.client.request('/api/action'), {code:'HOST_SESSION_EXPIRED'});
  assert.equal(calls, 1);
});

test('aborting one HTTP stream cancels the box operation without ending the application session', {timeout:3000}, async t => {
  let resolveClosed;
  const closed = new Promise(resolve => {resolveClosed=resolve;});
  const f=await fixture(t, (req,res)=>{
    if(req.url==='/api/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: one\n\n');res.once('close',resolveClosed);}
    else res.end('{}');
  });
  await f.client.context();
  const controller=new AbortController();
  const response=await f.client.request('/api/stream',{signal:controller.signal});
  const reader=response.body.getReader();await reader.read();controller.abort();
  await assert.rejects(reader.read());await closed;
  assert.equal((await f.client.request('/api/test')).status,200);
});

for (const ending of ['revocation', 'close']) {
test(`a response arriving after ${ending} is discarded, including transports that ignore abort`, {timeout:3000}, async t => {
  let complete, started;
  const waiting=new Promise(resolve=>{started=resolve;});
  let live = true, changed;
  const session=await openSession({
    context:()=>{if (!live) throw Error('NETWORK_CHANGED'); return {boxId:'102',connection:'ready'};},
    subscribe(fn) { changed = fn; return () => {}; },
    request:()=>{started();return new Promise(resolve=>{complete=resolve;});},
  });
  const client=fromEnvironment(session.environment);
  t.after(async()=>{client.close();await session.close();});
  await client.context();
  const request=client.request('/api/slow');
  const rejected=assert.rejects(request);await waiting;
  if (ending === 'revocation') { live = false; changed(); }
  else await session.close(); // Local cleanup must not wait for an uncooperative box promise.
  const {PassThrough}=await import('node:stream');
  const late=new PassThrough();complete({status:200,headers:{},body:late});
  await rejected;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(late.destroyed,true);
});
}

test('a WebSocket arriving after final close is terminated without completing the application handshake', {timeout:3000}, async t => {
  const {WebSocket, WebSocketServer} = await import('ws');
  const box = new WebSocketServer({port:0, host:'127.0.0.1'});
  await once(box, 'listening');
  t.after(async () => {
    for (const ws of box.clients) ws.terminate();
    await new Promise(resolve => box.close(resolve));
  });
  let complete, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const session = await openSession({
    context: () => ({boxId:'102', connection:'ready'}),
    openStream: () => { started(); return new Promise(resolve => { complete = resolve; }); },
  });
  t.after(() => session.close());
  const client = fromEnvironment(session.environment);
  t.after(() => client.close());
  await client.context();
  const ws = await client.openStream('/api/agents/a/chat/ws');
  let opened = false;
  ws.once('open', () => { opened = true; });
  const clientClosed = new Promise(resolve => ws.once('close', resolve));
  await waiting;
  await session.close();
  await clientClosed;
  const late = new WebSocket(`ws://127.0.0.1:${box.address().port}`);
  t.after(() => late.terminate());
  await once(late, 'open');
  const lateClosed = once(late, 'close');
  complete(late);
  await lateClosed;
  assert.equal(opened, false);
  assert.equal(late.readyState, WebSocket.CLOSED);
});

test('existing Buffer uploads larger than 32 MiB reach the box unchanged', {timeout:5000}, async t => {
  const f=await fixture(t,async(req,res)=>{
    let bytes=0;
    for await (const chunk of req) bytes+=chunk.length;
    res.end(JSON.stringify({bytes}));
  });
  await f.client.context();
  const response=await f.client.request('/api/upload',{method:'POST',body:Buffer.alloc(33*1024*1024)});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{bytes:33*1024*1024});
  assert.equal((await f.client.context()).boxId,'102');
});

// Allow slower disks to stream 64 MiB; the assertions still verify streaming and byte integrity.
for (const kind of ['node', 'web']) {
test(`${kind} stream uploads a large multipart file before the source finishes`, {timeout:15000}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wanx-upload-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const filename = path.join(directory, 'large.bin');
  const file = await open(filename, 'w');
  await file.truncate(64 * 1024 * 1024);
  await file.write(Buffer.from('file-tail'), 0, 9, 64 * 1024 * 1024 - 9);
  await file.close();
  const prefix = Buffer.from('--upload-boundary\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');
  const suffix = Buffer.from('\r\n--upload-boundary--\r\n');
  const expected = createHash('sha256').update(prefix);
  for await (const chunk of createReadStream(filename)) expected.update(chunk);
  expected.update(suffix);
  let receivedFirst;
  const first = new Promise(resolve => {receivedFirst = resolve;});
  t.after(receivedFirst);
  let finished = false;
  const f = await fixture(t, async (req, res) => {
    assert.equal(req.headers['content-type'], 'multipart/form-data; boundary=upload-boundary');
    assert.equal(finished, false, 'the box must receive bytes before the entire file is read');
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of req) {bytes += chunk.length; hash.update(chunk); receivedFirst();}
    res.end(JSON.stringify({bytes, hash:hash.digest('hex')}));
  });
  const source = Readable.from((async function* () {
    yield prefix;
    // Waiting for the box here detects buffering anywhere in the upload chain.
    await first;
    yield* createReadStream(filename);
    yield suffix;
    finished = true;
  })());
  t.after(() => source.destroy());
  const response = await f.client.request('/api/upload', {
    method:'POST', headers:{'content-type':'multipart/form-data; boundary=upload-boundary'},
    body:kind === 'node' ? source : Readable.toWeb(source),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {bytes:64 * 1024 * 1024 + prefix.length + suffix.length, hash:expected.digest('hex')});
  assert.equal(finished, true);
});
}

test('upload backpressure stops reading the source while the box is paused', {timeout:3000}, async t => {
  let started, disconnected, incoming;
  const received = new Promise(resolve => {started = resolve;});
  const closed = new Promise(resolve => {disconnected = resolve;});
  const f = await fixture(t, (req, res) => {
    incoming = req;
    req.pause();
    res.once('close', disconnected);
    started();
  });
  let produced = 0;
  const size = 256 * 1024 * 1024;
  const source = new Readable({read() {
    if (produced === size) return this.push(null);
    produced += 65536;
    this.push(Buffer.alloc(65536));
  }});
  t.after(() => source.destroy());
  const controller = new AbortController();
  const rejected = assert.rejects(f.client.request('/api/upload', {method:'POST', body:source, signal:controller.signal}), {name:'AbortError'});
  await received;
  await delay(50);
  assert.ok(produced < size, `paused box must not cause the full ${size}-byte source to be buffered (read ${produced})`);
  controller.abort();
  await rejected;
  // Let Node drain already queued TCP bytes and observe the peer closing.
  incoming.resume();
  await closed;
});

for (const earlyHeaders of [false, true]) {
test(`upload outlives the header timeout while progressing (early response: ${earlyHeaders})`, {timeout:5000}, async t => {
  const f = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      if (earlyHeaders) res.write(chunk);
      else body += chunk;
    }
    res.end(body);
  });
  const client = createHostClient({baseURL:f.url, token:f.token, timeoutMs:500});
  t.after(() => client.close());
  const source = Readable.from((async function* () {
    for (let index = 0; index < 6; index++) {yield Buffer.from('chunk'); await delay(150);}
  })());
  t.after(() => source.destroy());
  const response = await client.request('/api/upload', {method:'POST', body:source});
  assert.equal(await response.text(), 'chunk'.repeat(6));
});
}

test('a stalled streaming upload times out and closes the source and box request', {timeout:3000}, async t => {
  let disconnected;
  const closed = new Promise(resolve => {disconnected = resolve;});
  const f = await fixture(t, (req, res) => {
    req.resume();
    res.once('close', disconnected);
  });
  const client = createHostClient({baseURL:f.url, token:f.token, timeoutMs:100});
  t.after(() => client.close());
  const source = new Readable({read() {this.push(Buffer.from('first')); this._read = () => {};}});
  t.after(() => source.destroy());
  await assert.rejects(client.request('/api/upload', {method:'POST', body:source}), {code:'HOST_REQUEST_TIMEOUT'});
  await closed;
  assert.equal(source.destroyed, true);
});

test('cancelling one upload preserves a concurrent large upload on the same session', {timeout:5000}, async t => {
  let started;
  const receiving = new Promise(resolve => {started = resolve;});
  const f = await fixture(t, async (req, res) => {
    if (req.url === '/api/cancel') {req.once('data', started); return;}
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    res.end(JSON.stringify({bytes}));
  });
  const controller = new AbortController();
  const pending = new Readable({read() {this.push(Buffer.from('pending')); this._read = () => {};}});
  t.after(() => pending.destroy());
  const rejected = assert.rejects(f.client.request('/api/cancel', {method:'POST', body:pending, signal:controller.signal}), {name:'AbortError'});
  await receiving;
  const source = Readable.from((async function* () {
    yield Buffer.alloc(65536);
    controller.abort();
    for (let i = 1; i < 640; i++) yield Buffer.alloc(65536);
  })());
  t.after(() => source.destroy());
  const response = await f.client.request('/api/upload', {method:'POST', body:source});
  assert.deepEqual(await response.json(), {bytes:40 * 1024 * 1024});
  await rejected;
  assert.equal((await f.client.context()).boxId, '102');
});

test('box rejection during an existing large Buffer upload preserves its 413 response', {timeout:5000}, async t => {
  const f = await fixture(t, (req, res) => {
    req.once('data', () => {
      res.writeHead(413, {'content-type':'application/json'});
      res.end('{"code":"BOX_UPLOAD_LIMIT"}');
    });
  });
  const response = await f.client.request('/api/upload', {method:'POST', body:Buffer.alloc(33 * 1024 * 1024)});
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {code:'BOX_UPLOAD_LIMIT'});
});

test('local Host forwards signed resource selectors without caller credentials', async t => {
  let received;
  const connection = { kind: 'local-trust-v1', close() {}, onInvalidated() { return () => {}; },
    context: () => ({ protocolVersion: 2, connection: 'ready', dataIdentity: { profileId: 'profile-a', boxId: 'box-a',
      boxKeyThumbprint: 'pin-a', ownershipEpoch: 1, principalId: 'principal-a' } }),
    async request(input) { received = input; return { status: 200, headers: {}, body: Readable.from(['ok']) }; } };
  const session = await openSession(connection);
  t.after(() => session.close());
  const selectors = { 'if-range': 'etag-1', 'if-match': 'etag-2', 'last-event-id': 'event-a',
    'idempotency-key': 'operation-a', 'x-wanx-data-context': 'context-a', 'x-space-link': 'link-a',
    'x-content-sha256': 'digest-a', 'range': 'bytes=0-9' };
  const response = await fetch(session.environment.WANX_HOST_BASE_URL + '/api/private', {
    headers: { ...selectors, authorization: 'Bearer ' + session.environment.WANX_HOST_TOKEN, cookie: 'stolen=1' } });
  assert.equal(await response.text(), 'ok');
  for (const [key, value] of Object.entries(selectors)) assert.equal(received.headers[key], value);
  assert.equal(received.headers.authorization, undefined); assert.equal(received.headers.cookie, undefined);
});
