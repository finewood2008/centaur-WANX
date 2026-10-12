import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createApplicationGateway } from "../app-host/http-gateway.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { createHostClient } from "../host-sdk/index.cjs";

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
  const gateway = await createApplicationGateway({ connection, token: "app-secret", capabilities: ["identity.read", "http.request", "chat.stream"] });
  const client = createHostClient({ baseURL: gateway.url, token: "app-secret" });
  t.after(async () => {
    client.close(); await gateway.close(); await upstream.close();
    box.closeAllConnections(); await new Promise(r => box.close(r));
  });
  return { box, gateway, client, change(value) { if (value === "invalid") live = false; else phase = value; for (const fn of listeners) fn(); } };
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
  const raw = await fetch(f.gateway.url + '/api/anything', {headers:{authorization:'Bearer app-secret'}});
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
  await assert.rejects(f.client.request('/api/test'), {code:'NETWORK_NOT_READY'});
  assert.equal(calls, 0);
  f.change('ready');
  assert.equal((await f.client.request('/api/test')).status, 200);
  const invalidated = expired(f.client);
  f.change('invalid'); await invalidated;
  f.change('ready');
  await assert.rejects(f.client.context(), {code:'HOST_SESSION_EXPIRED'});
});

test('gateway validates credentials, browser origins, paths and capability before reaching the box', async t => {
  let calls = 0;
  const f = await fixture(t, (_req,res) => {calls++;res.end('{}');});
  const raw = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get(f.gateway.url, {path, headers:{authorization:'Bearer app-secret', ...headers}}, res => {res.resume();resolve(res.statusCode);});
    req.on('error', reject);
  });
  assert.equal(await raw('/api/test', {authorization:'Bearer wrong'}), 401);
  assert.equal(await raw('/api/test', {origin:'https://untrusted.test'}), 403);
  assert.equal(await raw('/api/test', {host:'untrusted.test'}), 403);
  assert.equal(await raw('/api/auth/logout'), 403);
  assert.equal((await f.client.context()).boxId, '102');
  for (const path of ['http://example.com/api/test','//example.com/api/test','/api/%2e%2e/admin','/api/%5csecret','/api/test?token=stolen','/api/test?access_token=stolen']) assert.equal(await raw(path), 400, path);
  assert.equal(calls, 0);
  const restricted = await createApplicationGateway({connection:{context:()=>({connection:'ready'})},token:'restricted',capabilities:['identity.read']});
  t.after(() => restricted.close());
  assert.equal((await fetch(restricted.url+'/api/test', {headers:{authorization:'Bearer restricted'}})).status, 403);
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

test('a response arriving after revocation is discarded, including transports that ignore abort', {timeout:3000}, async t => {
  let complete, started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const gateway=await createApplicationGateway({token:'slow',capabilities:['identity.read','http.request'],connection:{
    context:()=>({boxId:'102',connection:'ready'}),
    request:()=>{started();return new Promise(resolve=>{complete=resolve;});},
  }});
  const client=createHostClient({baseURL:gateway.url,token:'slow'});
  t.after(async()=>{client.close();await gateway.close();});
  await client.context();
  const request=client.request('/api/slow');
  const rejected=assert.rejects(request);await waiting;
  gateway.revoke();
  const {PassThrough}=await import('node:stream');
  const late=new PassThrough();complete({status:200,headers:{},body:late});
  await rejected;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(late.destroyed,true);
});

test('oversized uploads return a bounded error without revoking the session or contacting the box', {timeout:3000}, async t => {
  let calls=0;
  const f=await fixture(t,(_req,res)=>{calls++;res.end('{}');});
  await f.client.context();
  await assert.rejects(f.client.request('/api/upload',{method:'POST',body:Buffer.alloc(33*1024*1024)}),{code:'HOST_REQUEST_TOO_LARGE'});
  assert.equal(calls,0);
  assert.equal((await f.client.context()).boxId,'102');
});
