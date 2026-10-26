import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, symlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createLocalDataAccess } from '../device-trust/data-session.mjs';
import { createIdentityVault } from '../device-trust/identity-vault.mjs';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { signSession, signSessionIntent, validateSessionIntentPayload, DATA_HEADER_FIELDS } from '../device-trust/data-contract.mjs';
import { createDashboardGateway } from '../octop/gateway.mjs';
import { createPlatformClient } from '../platform.mjs';
import { createClient } from '../client.mjs';
import { createTunnelAgent } from '../network/tunnel.mjs';
import { createApplicationSession } from '../app-host/session.mjs';
import { fromEnvironment } from '../host-sdk/index.cjs';

const randomId = () => randomBytes(32).toString('base64url');
const canonical = value => value && typeof value === 'object' ? (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`) : JSON.stringify(value);
const digest = value => createHash('sha256').update(value).digest('base64url');
const decode = value => JSON.parse(Buffer.from(value.split('.')[1], 'base64url'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checkSignature = (proof, key) => {
  const parts = proof.split('.');
  assert.equal(verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
  return decode(proof);
};

async function fixture(t, { realVault = false, badPin = false, sessionLifetimeMs = 300000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-data-test-'));
  const cert = await readFile(new URL('./fixtures/tls/server-cert.pem', import.meta.url));
  const tlsKey = await readFile(new URL('./fixtures/tls/server-key.pem', import.meta.url));
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const access = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const profile = { profileId: 'profile-a', principalId: 'principal-a', clientId: 'client-a', accessKey: access.publicKey.export({ format: 'jwk' }) };
  let locked = false, generation = 1, state, denies = false, bindingRevision = 1, sessionGate = null, anonymousDenied = false;
  const subscribers = new Set(), connections = new Set(), wsConnections = new Set();
  const channels = new Map(), renewals = new Map(), intents = new Map(), intentIds = new Set(), seen = [], heartbeats = [], controlRequests = [];
  const applicationGrants = new Map(), businessStatuses = new Map();
  const ws = new WebSocketServer({ noServer: true });
  const generationId = randomId();
  let descriptor;
  const reply = (response, kind, body) => {
    const value = { schemaVersion: 1, purpose: 'centuarai.local-data.response', boxId: descriptor.boxId,
      boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), kind, issuedAtMs: body.issuedAtMs, body };
    const header = Buffer.from(canonical({ alg: 'ES256', typ: 'centuarai-local-data-response+jws' })).toString('base64url');
    const encoded = Buffer.from(canonical(value)).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${encoded}`), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    response.writeHead(200, { 'content-type': 'application/jose' }); response.end(`${header}.${encoded}.${signature}`);
  };
  const deny = (response, code = 'LOCAL_DATA_FORBIDDEN') => {
    response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code }));
  };
  const liveChannel = (channel, now) => channel && now < Math.min(channel.expiresAtMs, channel.presenceExpiresAtMs);
  function dataProof(request) {
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
    const proof = request.headers['x-centuarai-data-proof']; assert.equal(typeof proof, 'string');
    const payload = decode(proof), channel = channels.get(payload.sessionId); assert.ok(channel);
    checkSignature(proof, channel.key);
    assert.equal(payload.method, request.method); assert.equal(payload.rawTarget, request.url);
    assert.deepEqual(Object.keys(payload.headers).sort(), [...DATA_HEADER_FIELDS].sort());
    assert.equal(channel.seen.has(payload.jti), false); channel.seen.add(payload.jti);
    assert.equal(payload.applicationId, channel.applicationId); assert.equal(payload.launchId, channel.launchId);
    assert.equal(payload.headers.range, request.headers.range ?? null);
    assert.equal(payload.headers.ifRange, request.headers['if-range'] ?? null);
    assert.equal(payload.headers.lastEventId, request.headers['last-event-id'] ?? null);
    assert.equal(payload.headers.contentSha256, request.headers['x-content-sha256'] ?? null);
    if (payload.transport === 'websocket') {
      assert.equal(payload.headers.webSocketKey, request.headers['sec-websocket-key']);
      assert.equal(payload.headers.webSocketProtocol, request.headers['sec-websocket-protocol'] ?? null);
    }
    return payload;
  }
  const server = https.createServer({ cert, key: tlsKey }, async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = Buffer.concat(chunks);
      if (request.url.startsWith('/local-trust/v1/data/')) {
        const value = JSON.parse(bytes), now = Date.now();
        controlRequests.push({ path: request.url, value });
        if (request.url.endsWith('/session-challenge')) {
          assert.deepEqual(Object.keys(value), ['proof']);
          const payload = validateSessionIntentPayload(checkSignature(value.proof, activeProfile.accessKey));
          assert.deepEqual(JSON.parse(Buffer.from(value.proof.split('.')[0], 'base64url')), { alg: 'ES256', typ: 'centuarai-local-data-session-intent+jws' });
          assert.equal(payload.boxId, descriptor.boxId); assert.equal(payload.boxKeyThumbprint, publicKeyThumbprint(descriptor.boxKey));
          assert.equal(payload.bindingId, 'binding-a');
          assert.ok(payload.issuedAtMs <= now && now < payload.expiresAtMs && payload.expiresAtMs - payload.issuedAtMs <= 3000);
          assert.notEqual(publicKeyThumbprint(payload.channelKey), publicKeyThumbprint(activeProfile.accessKey));
          assert.equal(intentIds.has(payload.jti), false); intentIds.add(payload.jti);
          if (anonymousDenied) return deny(response, 'LOCAL_DATA_CAPACITY');
          const challenge = randomId(); intents.set(challenge, payload);
          return reply(response, 'session-challenge', { challenge, gatewayGeneration: generationId, issuedAtMs: now, expiresAtMs: now + 30000 });
        }
        if (request.url.endsWith('/renewal-challenge')) {
          assert.deepEqual(Object.keys(value), ['proof']);
          const payload = decode(value.proof), old = channels.get(payload.sessionId);
          if (denies || !liveChannel(old, now)) return deny(response);
          if (old.bindingRevision !== bindingRevision) return deny(response, 'LOCAL_DATA_CONTEXT_CHANGED');
          checkSignature(value.proof, old.key);
          assert.deepEqual(JSON.parse(Buffer.from(value.proof.split('.')[0], 'base64url')), { alg: 'ES256', typ: 'centuarai-local-data-renewal+jws' });
          assert.equal(payload.purpose, 'centuarai.local-data.renewal');
          assert.equal(payload.applicationId, old.applicationId); assert.equal(payload.launchId, old.launchId);
          assert.equal(payload.gatewayGeneration, generationId); assert.equal(payload.boxId, descriptor.boxId);
          assert.ok(payload.issuedAtMs <= now && now < payload.expiresAtMs && payload.expiresAtMs - payload.issuedAtMs <= 3000);
          assert.notEqual(publicKeyThumbprint(payload.channelKey), publicKeyThumbprint(old.key));
          assert.notEqual(publicKeyThumbprint(payload.channelKey), publicKeyThumbprint(activeProfile.accessKey));
          assert.equal(old.seen.has(payload.jti), false); old.seen.add(payload.jti);
          const challenge = randomId(); renewals.set(challenge, payload);
          return reply(response, 'session-challenge', { challenge, gatewayGeneration: generationId, issuedAtMs: now, expiresAtMs: now + 30000 });
        }
        if (request.url.endsWith('/sessions') || request.url.endsWith('/renewals')) {
          const renewing = request.url.endsWith('/renewals');
          if (!renewing && anonymousDenied) return deny(response, 'LOCAL_DATA_CAPACITY');
          const payload = checkSignature(value.accessProof, activeProfile.accessKey);
          if (sessionGate) { const gate = sessionGate; sessionGate = null; gate.enter(); await gate.wait; }
          if (denies) return deny(response);
          if (renewing) {
            const proposed = renewals.get(payload.challenge); assert.ok(proposed);
            const old = channels.get(proposed.sessionId);
            if (!liveChannel(old, Date.now())) return deny(response);
            if (old.bindingRevision !== bindingRevision) return deny(response, 'LOCAL_DATA_CONTEXT_CHANGED');
            for (const field of ['requestId', 'applicationId', 'launchId']) assert.equal(payload[field], proposed[field]);
            assert.deepEqual(payload.channelKey, proposed.channelKey); renewals.delete(payload.challenge);
          } else {
            const proposed = intents.get(payload.challenge); assert.ok(proposed);
            for (const field of ['requestId', 'applicationId', 'launchId', 'bindingId']) assert.equal(payload[field], proposed[field]);
            assert.deepEqual(payload.channelKey, proposed.channelKey); intents.delete(payload.challenge);
          }
          const sessionId = randomId(), lifetime = channels.size ? 300000 : sessionLifetimeMs;
          channels.set(sessionId, { key: payload.channelKey, applicationId: payload.applicationId, launchId: payload.launchId,
            expiresAtMs: now + lifetime, presenceExpiresAtMs: now + Math.min(3000, lifetime), bindingRevision, seen: new Set() });
          return reply(response, 'session', { sessionId, gatewayGeneration: generationId, applicationId: payload.applicationId,
            launchId: payload.launchId, channelKeyThumbprint: publicKeyThumbprint(payload.channelKey), issuedAtMs: now,
            expiresAtMs: now + lifetime, presenceExpiresAtMs: now + Math.min(3000, lifetime), heartbeatIntervalMs: 1000,
            authorization: { boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch: 1,
              authorizationVersion: 1, principalSecurityVersion: 1, bindingId: 'binding-a', bindingRevision,
              principalId: activeProfile.principalId, clientId: activeProfile.clientId,
              grants: applicationGrants.get(payload.applicationId) || [{ resourceId: 'wanx', actions: ['execute', 'read', 'write'] }], grantExpiresAtMs: null } });
        }
        if (request.url.endsWith('/heartbeat')) {
          const payload = decode(value.proof); checkSignature(value.proof, channels.get(payload.sessionId).key); heartbeats.push(payload);
          if (denies) return deny(response);
          channels.get(payload.sessionId).presenceExpiresAtMs = Math.min(now + 3000, payload.expiresAtMs);
          return reply(response, 'heartbeat', { sessionId: payload.sessionId, sequence: payload.sequence, issuedAtMs: now,
            presenceExpiresAtMs: Math.min(now + 3000, payload.expiresAtMs), authorizationVersion: 1, bindingRevision: 1 });
        }
        return deny(response);
      }
      const proof = dataProof(request);
      assert.equal(proof.bodyBytes, bytes.length); assert.equal(proof.bodySha256, digest(bytes));
      seen.push({ path: request.url, proof, body: bytes, headers: request.headers });
      if (businessStatuses.has(request.url)) {
        response.writeHead(businessStatuses.get(request.url), { 'content-type': 'application/json' });
        response.end('{"privateBodyMustNotBeReturned":true}'); return;
      }
      if (request.url === '/api/personal-space/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: first\n\n');
        const timer = setInterval(() => response.write('data: next\n\n'), 25); response.once('close', () => clearInterval(timer)); return;
      }
      if (request.url === '/api/auth/me') { response.end('{"user_id":42,"username":"local-user"}'); return; }
      response.writeHead(request.headers.range ? 206 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, body: bytes.toString() }));
    } catch (error) { response.destroy(error); }
  });
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  server.on('upgrade', (request, socket, head) => {
    try {
      const payload = dataProof(request); seen.push({ path: request.url, proof: payload });
      ws.handleUpgrade(request, socket, head, client => {
        wsConnections.add(client); client.once('close', () => wsConnections.delete(client));
        client.on('message', value => { const message = JSON.parse(value); assert.equal(message.token, undefined); client.send(value); });
        client.send('first frame');
      });
    } catch { socket.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  descriptor = { boxId: 'box-a', baseUrl: `https://127.0.0.1:${server.address().port}`, boxKey: pair.publicKey.export({ format: 'jwk' }),
    tlsSpkiSha256: badPin ? randomId() : digest(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })) };
  let vault, activeProfile = profile;
  let protectDirectory;
  if (process.platform === 'win32') protectDirectory = (await import('../shell/private-storage.mjs')).protectPrivateDirectory;
  if (realVault) {
    vault = createIdentityVault({ directory: path.join(root, 'identity'), protectDirectory }); await vault.load();
    activeProfile = await vault.createProfile({ passphrase: 'synthetic independent local secret' });
    state = { schemaVersion: 1, boxes: { 'box-a': { descriptor, principalId: activeProfile.principalId, bindingId: 'binding-a', role: 'use', checkpoint: { ownershipEpoch: 1 }, requests: {} } } };
    await vault.writeState(state);
  } else {
    state = { schemaVersion: 1, boxes: { 'box-a': { descriptor, principalId: profile.principalId, bindingId: 'binding-a', role: 'use', checkpoint: { ownershipEpoch: 1 }, requests: {} } } };
    vault = { snapshot: () => ({ loaded: true, exists: true, locked, generation, profile: activeProfile }),
      readState: () => { assert.equal(locked, false); return structuredClone(state); },
      signDataSession: payload => { assert.equal(locked, false); return signSession(payload, access.privateKey); },
      signDataSessionIntent: payload => { assert.equal(locked, false); return signSessionIntent(payload, access.privateKey); },
      subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
      lock() { locked = true; generation++; for (const listener of subscribers) listener({ type: 'locked', reason: 'test-lock', generation }); }, close() {} };
  }
  const stagingDirectory = path.join(root, 'staging');
  const accessProvider = createLocalDataAccess({ vault, stagingDirectory, protectDirectory });
  t.after(async () => {
    accessProvider.close(); vault.close(); for (const client of wsConnections) client.terminate();
    for (const socket of connections) socket.destroy(); ws.close();
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  return { root, descriptor, vault, profile: activeProfile, provider: accessProvider, seen, heartbeats, channels, controlRequests,
    exhaustAnonymous: () => { anonymousDenied = true; },
    setBusinessStatus: (target, status) => businessStatuses.set(target, status),
    stagingDirectory, deny: () => { denies = true; }, changeRevision: () => { bindingRevision++; },
    changeApplicationGrants: (applicationId, grants) => applicationGrants.set(applicationId, grants),
    holdNextSession() {
      let enter, release; const entered = new Promise(resolve => { enter = resolve; });
      sessionGate = { enter, wait: new Promise(resolve => { release = resolve; }) }; return { entered, release };
    },
    connect: options => accessProvider.connect({ boxId: 'box-a', ...options }) };
}

test('real independent vault opens pinned LAN without cloud, signs exact staged body and selectors, exposes no bearer', async t => {
  const f = await fixture(t, { realVault: true }); const session = await f.connect();
  assert.equal(session.getToken, undefined); assert.equal(session.context().principalId, f.profile.principalId);
  const result = await session.request({ path: '/api/personal-space/uploads/one', method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-content-sha256': 'untrusted-value' }, body: Readable.from(['one', 'two']) });
  assert.equal(result.status, 200); assert.equal(f.seen[0].body.toString(), 'onetwo');
  assert.equal(f.seen[0].headers['x-content-sha256'], createHash('sha256').update('onetwo').digest('hex'));
  assert.deepEqual(await readdir(f.stagingDirectory), []);
  const range = await session.request({ path: '/api/personal-space/download', headers: { range: 'bytes=0-2', 'if-range': '"v1"' } });
  assert.equal(range.status, 206); assert.notEqual(f.seen[0].proof.jti, f.seen[1].proof.jti);
});

test('first-session intent is a finite Access proof of the saved binding and exact channel proposal', async t => {
  const f = await fixture(t, { realVault: true }), now = Date.now();
  const payload = { schemaVersion: 1, purpose: 'centuarai.local-data.session-intent', boxId: f.descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(f.descriptor.boxKey), bindingId: 'binding-a',
    applicationId: 'wanx-host', launchId: randomId(), requestId: randomId(),
    channelKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }),
    jti: randomId(), issuedAtMs: now, expiresAtMs: now + 3000 };
  assert.deepEqual(checkSignature(f.vault.signDataSessionIntent(payload), f.profile.accessKey), payload);
  for (const change of [{ boxId: 'other-box' }, { boxKeyThumbprint: randomId() }, { bindingId: 'other-binding' }]) {
    assert.throws(() => f.vault.signDataSessionIntent({ ...payload, ...change }), { code: 'LOCAL_IDENTITY_IDENTITY_MISMATCH' });
  }
  for (const change of [{ purpose: 'centuarai.local-data.session' }, { expiresAtMs: now + 3001 },
    { channelKey: f.profile.accessKey }, { ownershipEpoch: 1 }, { clientId: f.profile.clientId }]) {
    assert.throws(() => f.vault.signDataSessionIntent({ ...payload, ...change }));
  }
  const session = await f.connect();
  const intent = checkSignature(f.controlRequests[0].value.proof, f.profile.accessKey);
  const committed = checkSignature(f.controlRequests[1].value.accessProof, f.profile.accessKey);
  for (const field of ['requestId', 'applicationId', 'launchId', 'bindingId']) assert.equal(intent[field], committed[field]);
  assert.deepEqual(intent.channelKey, committed.channelKey);
  assert.equal(session.context().sessionId.length, 43);
  f.vault.lock();
  assert.throws(() => f.vault.signDataSessionIntent(payload), { code: 'LOCAL_IDENTITY_LOCKED' });
});

function namespaceTarget(f, signal) {
  return { profileId: f.profile.profileId, boxId: f.descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(f.descriptor.boxKey), principalId: f.profile.principalId,
    bindingId: 'binding-a', ownershipEpoch: 1, ...(signal ? { signal } : {}) };
}

test('backup namespace initialization uses only exact current association and two fixed authorized reads in a separate session', async t => {
  const f = await fixture(t, { realVault: true }), existing = await f.connect(), selected = existing.context();
  const target = namespaceTarget(f);
  const result = await f.provider.ensureBackupNamespace(target);
  assert.deepEqual(result, target); assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(f.seen.map(item => [item.path, item.proof.method, item.body.length]),
    [['/api/personal-space/overview', 'GET', 0], ['/api/clipboard/v1', 'GET', 0]]);
  assert.equal(f.seen[0].proof.sessionId, f.seen[1].proof.sessionId);
  assert.notEqual(f.seen[0].proof.sessionId, selected.sessionId);
  assert.equal(existing.isLive(), true); assert.deepEqual(existing.context(), selected);
  assert.equal((await existing.request({ path: '/api/auth/me' })).status, 200);
});

test('backup namespace target mismatch, arbitrary paths, unavailable resources and lock never authorize a fallback', async t => {
  const f = await fixture(t), target = namespaceTarget(f);
  for (const change of [{ profileId: 'other-profile' }, { boxId: 'other-box' }, { boxKeyThumbprint: randomId() },
    { principalId: 'other-principal' }, { bindingId: 'other-binding' }, { ownershipEpoch: 2 }, { path: '/api/admin' }]) {
    await assert.rejects(f.provider.ensureBackupNamespace({ ...target, ...change }));
  }
  assert.equal(f.controlRequests.length, 0); assert.equal(f.seen.length, 0);
  f.setBusinessStatus('/api/clipboard/v1', 503);
  await assert.rejects(f.provider.ensureBackupNamespace(target), /LOCAL_DATA_UNAVAILABLE/);
  assert.deepEqual(f.seen.map(item => item.path), ['/api/personal-space/overview', '/api/clipboard/v1']);
  f.setBusinessStatus('/api/clipboard/v1', 403);
  await assert.rejects(f.provider.ensureBackupNamespace(target), /LOCAL_DATA_FORBIDDEN/);
  const gate = f.holdNextSession(), controller = new AbortController();
  const pending = f.provider.ensureBackupNamespace(namespaceTarget(f, controller.signal));
  const rejected = assert.rejects(pending);
  await gate.entered; f.vault.lock(); controller.abort(); gate.release(); await rejected;
  assert.equal(f.seen.length, 4);
});

test('wrong TLS pin sends no control or business request and never falls back', async t => {
  const f = await fixture(t, { badPin: true });
  await assert.rejects(f.connect(), error => error.code === 'LOCAL_DATA_TLS_PIN_MISMATCH');
  assert.equal(f.channels.size, 0); assert.equal(f.seen.length, 0);
});

test('lock synchronously rejects new work and closes live SSE and WebSocket well within five seconds', async t => {
  const f = await fixture(t), session = await f.connect();
  const result = await session.request({ path: '/api/personal-space/events', stream: true, headers: { 'last-event-id': 'event-1' } });
  result.body.on('error', () => {}); await once(result.body, 'data');
  const socket = await session.openWebSocket({ path: '/api/agents/fixture-agent/chat/ws', protocols: ['test-stream'] });
  assert.equal((await once(socket, 'message'))[0].toString(), 'first frame');
  const streamClosed = new Promise(resolve => result.body.once('close', resolve));
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  const started = performance.now(); f.vault.lock();
  assert.equal(session.isLive(), false);
  await assert.rejects(session.request({ path: '/api/personal-space/overview' }), /LOCAL_DATA_SESSION_CLOSED/);
  await Promise.all([streamClosed, socketClosed]); assert.ok(performance.now() - started < 1000);
});

test('staging buffers no upstream body until complete; lock aborts input and removes private temporary file', async t => {
  const f = await fixture(t), session = await f.connect(), source = new PassThrough();
  const pending = session.request({ path: '/api/personal-space/uploads/one', method: 'PUT', body: source });
  const rejected = assert.rejects(pending, /LOCAL_DATA_SESSION_CLOSED/);
  source.write(Buffer.alloc(4096));
  for (let i = 0; i < 30 && !await readdir(f.stagingDirectory).then(v => v.length, () => 0); i++) await wait(5);
  assert.equal(f.seen.length, 0); f.vault.lock(); await rejected;
  assert.deepEqual(await readdir(f.stagingDirectory), []); assert.equal(source.destroyed, true);
});

test('application launch receives separate channel identity and closing it preserves parent and sibling', async t => {
  const f = await fixture(t), session = await f.connect();
  const one = await session.deriveApplication({ applicationId: 'centaurai.wanx.dialogue' });
  const two = await session.deriveApplication({ applicationId: 'centaurai.wanx.dialogue' });
  assert.notEqual(one.context().sessionId, two.context().sessionId);
  assert.notEqual(one.context().launchId, two.context().launchId);
  one.close(); assert.equal(session.isLive(), true); assert.equal(two.isLive(), true);
  await assert.rejects(two.request({ path: '/api/personal-space/overview' }), /LOCAL_DATA_FORBIDDEN/);
  await assert.rejects(session.deriveApplication({ applicationId: 'unknown.app' }), /LOCAL_DATA_FORBIDDEN/);
});

test('heartbeat is independently signed and current authority denial closes an idle channel', async t => {
  const f = await fixture(t), session = await f.connect();
  await wait(1150); assert.equal(f.heartbeats.length, 1); assert.equal(session.isLive(), true);
  f.deny(); await wait(1150); assert.equal(session.isLive(), false);
});

test('unknown and credential headers, traversal and unknown routes fail before sending', async t => {
  const f = await fixture(t), session = await f.connect();
  for (const input of [
    { path: '/api/settings' }, { path: '/api/agents/../settings' }, { path: '/api/personal-space/%2e%2e/settings' },
    { path: '/api/personal-space/overview?token=stolen' },
    { path: '/api/personal-space/overview', headers: { authorization: 'Bearer stolen' } },
    { path: '/api/personal-space/overview', headers: { range: 'bytes=1-2', Range: 'bytes=2-3' } },
  ]) await assert.rejects(session.request(input));
  assert.equal(f.seen.length, 0);
});

test('private staging refuses a symlink directory', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), session = await f.connect();
  const other = path.join(f.root, 'other'); await mkdir(other, { mode: 0o700 }); await symlink(other, f.stagingDirectory);
  await assert.rejects(session.request({ path: '/api/personal-space/uploads/a', method: 'PUT', body: 'private' }), /LOCAL_DATA_STAGING_UNAVAILABLE/);
  assert.equal(f.seen.length, 0); assert.deepEqual(await readdir(other), []);
});

test('dashboard and main gateway HTTP both use the proof session, never getToken or legacy upstream credentials', async t => {
  const f = await fixture(t), session = await f.connect();
  const gateway = await createDashboardGateway({ targetURL: f.descriptor.baseUrl, session }); t.after(() => gateway.close());
  const boot = await fetch(gateway.url); const html = await boot.text();
  const marker = /sessionStorage\.setItem\("auth_token",("[^"]+")/.exec(html);
  assert.ok(marker);
  const response = await fetch(`${gateway.origin}/api/personal-space/overview`, { headers: { authorization: `Bearer ${JSON.parse(marker[1])}` } });
  assert.equal(response.status, 200);
  assert.equal((await gateway.request({ path: '/api/personal-space/overview' })).status, 200);
  assert.equal(f.seen.length, 2); assert.equal(f.seen.every(item => item.headers.authorization === undefined), true);
});

test('platform selects independently associated LAN box while cloud restore fails, with separate application sessions and lock fencing', async t => {
  const f = await fixture(t); let cloudCalls = 0, legacyCalls = 0;
  const account = { snapshot: () => ({ phase: 'signed_out', accountId: null, clientId: null }), getIdentity: () => null,
    subscribe: () => () => {}, restore: async () => { cloudCalls++; throw new Error('offline'); }, close: async () => {} };
  const platform = createPlatformClient({ account, localDataAccess: f.provider,
    createSession: async () => { legacyCalls++; throw new Error('legacy denied'); },
    createTransport() {
      const network = { snapshot: () => ({ enabled: false, phase: 'disabled', peers: [] }), subscribe: () => () => {}, close: async () => {},
        resolveLocalDataEndpoint: async (input, trust) => { assert.equal(trust.tlsSpkiSha256, f.descriptor.tlsSpkiSha256); return input; },
        resolveEndpoint: async () => { legacyCalls++; throw new Error('legacy route denied'); } };
      return { network, client: createClient({ network, probe: async () => { legacyCalls++; throw new Error('legacy probe denied'); } }) };
    } });
  t.after(() => platform.close()); await platform.initialize();
  const connected = await platform.connectBox('box-a');
  assert.equal(connected.account.phase, 'signed_out'); assert.equal(connected.phase, 'ready');
  assert.equal(connected.connection.authorization, 'local-trust-v1'); assert.equal(connected.dataIdentity.selected.principalId, f.profile.principalId);
  const host = await platform.applicationConnection();
  const child = await host.deriveApplication({ applicationId: 'centaurai.wanx.dialogue', launchId: randomId(), capabilities: ['identity.read'] });
  assert.equal(child.context().protocolVersion, 2); assert.equal(child.context().accountId, undefined);
  assert.notEqual(child.context().dataIdentity.sessionId, host.context().dataIdentity.sessionId);
  await assert.rejects(child.request({ path: '/api/dialogue/sessions' }), /LOCAL_DATA_FORBIDDEN/);
  child.close(); assert.equal((await host.request({ path: '/api/personal-space/overview' })).status, 200);
  const launch = () => createApplicationSession({ hostApplicationId: 'wanx-host', applicationId: 'centaurai.wanx.dialogue',
    installPath: f.root, capabilities: ['identity.read', 'http.request'],
    createConnection: async ({ applicationId, ...options }) => {
      const connection = await platform.applicationConnection(applicationId, options);
      return { ...connection, request: async input => {
        try { return await connection.request(input); } catch (error) { t.diagnostic(error.code || error.message); throw error; }
      } };
    } });
  const app1 = await launch(), app2 = await launch();
  t.after(() => app1.close()); t.after(() => app2.close());
  const sdk1 = fromEnvironment(app1.environment), sdk2 = fromEnvironment(app2.environment);
  t.after(() => sdk1.close()); t.after(() => sdk2.close());
  const context1 = await sdk1.context(), context2 = await sdk2.context();
  assert.equal(context1.protocolVersion, 2); assert.equal(context1.accountId, undefined);
  assert.notEqual(context1.dataIdentity.sessionId, context2.dataIdentity.sessionId);
  assert.equal((await sdk1.request('/api/dialogue/sessions')).status, 200);
  const proved = f.seen.at(-1); assert.equal(proved.proof.applicationId, 'centaurai.wanx.dialogue');
  assert.equal(proved.proof.launchId, app1.launchId); assert.equal(proved.headers.authorization, undefined);
  await app1.close(); assert.equal((await sdk2.request('/api/dialogue/sessions')).status, 200);
  await assert.rejects(platform.connectBox('unknown-box'), /TEAM_DEVICE_APPROVAL_REQUIRED/);
  f.vault.lock(); assert.equal(platform.snapshot().dataIdentity.phase, 'locked'); assert.equal(platform.snapshot().dataIdentity.selected, null);
  assert.throws(() => app2.assertLive(), /HOST_SESSION_EXPIRED/);
  assert.throws(() => host.context(), /LOCAL_DATA_SESSION_CLOSED/);
  await assert.rejects(platform.connectBox('box-a'), /LOCAL_IDENTITY_LOCKED/);
  assert.equal(cloudCalls, 1); assert.equal(legacyCalls, 0);
});

test('pinned P2P route carries the same session proof without requiring a public CA or copying proxy authorization', async t => {
  const f = await fixture(t), sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (request, downstream, head) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-proxy'); sockets.add(downstream);
    const target = net.connect(new URL(f.descriptor.baseUrl).port, '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head);
      target.pipe(downstream); downstream.pipe(target);
    });
    sockets.add(target); target.on('error', () => downstream.destroy()); downstream.on('error', () => target.destroy());
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const url = 'https://100.90.1.2:9443';
  const agent = createTunnelAgent({ url, proxy: { port: proxy.address().port, token: 'synthetic-proxy' }, tlsSpkiSha256: f.descriptor.tlsSpkiSha256 });
  t.after(async () => { agent.destroy(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
  const session = await f.connect({ route: { url, agent, mode: 'netbird' } });
  assert.equal(session.context().route, 'p2p');
  assert.equal((await session.request({ path: '/api/personal-space/overview' })).status, 200);
  assert.equal(f.seen[0].headers.authorization, undefined);
});

test('scoped chat WebSocket uses an upgrade proof while desktop first-frame credentials cannot grant host control', async t => {
  const f = await fixture(t), session = await f.connect();
  const gateway = await createDashboardGateway({ targetURL: f.descriptor.baseUrl, session }); t.after(() => gateway.close());
  const html = await (await fetch(gateway.url)).text();
  const marker = JSON.parse(/sessionStorage\.setItem\("auth_token",("[^"]+")/.exec(html)[1]);
  const ordinary = new WebSocket(`${gateway.origin.replace('http:', 'ws:')}/api/agents/fixture-agent/chat/ws?token=${marker}`, { origin: gateway.origin });
  const first = once(ordinary, 'message'); await once(ordinary, 'open'); assert.equal((await first)[0].toString(), 'first frame');
  const desktop = new WebSocket(`${gateway.origin.replace('http:', 'ws:')}/api/desktop-stream/ws`, { origin: gateway.origin });
  await once(desktop, 'open');
  const closed = once(desktop, 'close');
  desktop.send(JSON.stringify({ type: 'start', token: marker, width: 640 }));
  await closed;
  assert.equal(f.seen.length, 1);
  for (const path of ['/api/desktop-stream/ws', '/api/mobile-stream/ws', '/api/terminal/ws'])
    await assert.rejects(session.openWebSocket({ path }), /LOCAL_DATA_FORBIDDEN/);
  ordinary.terminate(); desktop.terminate();
});

test('two staging slots per launch are bounded and a denied third input never reaches the box', async t => {
  const f = await fixture(t), session = await f.connect(), sources = [new PassThrough(), new PassThrough(), new PassThrough()];
  const one = session.request({ path: '/api/personal-space/uploads/one', method: 'PUT', body: sources[0] });
  const two = session.request({ path: '/api/personal-space/uploads/two', method: 'PUT', body: sources[1] });
  const cancelled = [assert.rejects(one), assert.rejects(two)];
  await assert.rejects(session.request({ path: '/api/personal-space/uploads/three', method: 'PUT', body: sources[2] }), /LOCAL_DATA_CAPACITY/);
  f.vault.lock(); sources.forEach(source => source.destroy()); await Promise.all(cancelled);
  assert.equal(f.seen.length, 0);
});

test('fresh renewal uses a new channel, preserves identity bounds, and cannot inherit a changed binding revision', async t => {
  const f = await fixture(t), old = await f.connect();
  const child = await old.deriveApplication({ applicationId: 'centaurai.wanx.dialogue' });
  const oldContext = old.context(), oldDeadline = f.channels.get(oldContext.sessionId).expiresAtMs;
  f.exhaustAnonymous();
  await assert.rejects(f.connect(), /LOCAL_DATA_CAPACITY/);
  const fresh = await old.renew();
  assert.notEqual(old.context().sessionId, fresh.context().sessionId);
  assert.equal(fresh.context().launchId, oldContext.launchId);
  assert.equal(f.channels.get(oldContext.sessionId).expiresAtMs, oldDeadline);
  assert.notDeepEqual(f.channels.get(old.context().sessionId).key, f.channels.get(fresh.context().sessionId).key);
  const freshChild = await child.renew({ parentSession: fresh });
  assert.equal(freshChild.context().launchId, child.context().launchId);
  assert.notEqual(freshChild.context().sessionId, child.context().sessionId);
  const renewalProofs = f.controlRequests.filter(item => item.path.endsWith('/renewal-challenge'));
  assert.equal(renewalProofs.length, 2);
  assert.equal(decode(renewalProofs[0].value.proof).sessionId, oldContext.sessionId);
  assert.equal(decode(renewalProofs[1].value.proof).sessionId, child.context().sessionId);
  old.close(); assert.equal(child.isLive(), false); assert.equal(fresh.isLive(), true); assert.equal(freshChild.isLive(), true);
  const anonymousCount = f.controlRequests.filter(item => item.path.endsWith('/session-challenge')).length;
  f.changeRevision(); await assert.rejects(fresh.renew(), /LOCAL_DATA_CONTEXT_CHANGED/);
  assert.equal(f.controlRequests.filter(item => item.path.endsWith('/session-challenge')).length, anonymousCount);
  assert.equal(fresh.isLive(), true); // Failed creation cannot mutate the captured authorization.
});

test('closing the old channel during renewal cannot publish a late replacement or fall back to anonymous admission', async t => {
  const f = await fixture(t), old = await f.connect(), gate = f.holdNextSession();
  f.exhaustAnonymous();
  const pending = old.renew(), rejected = assert.rejects(pending, /LOCAL_DATA_SESSION_CLOSED/);
  await gate.entered; old.close(); gate.release(); await rejected;
  assert.equal(old.isLive(), false);
  assert.equal(f.controlRequests.filter(item => item.path.endsWith('/session-challenge')).length, 1);
  const before = f.controlRequests.length;
  assert.throws(() => old.renew(), /LOCAL_DATA_SESSION_CLOSED/);
  assert.equal(f.controlRequests.length, before);
});

test('client publishes independently fresh child sessions without invalidating stable launch wrappers', async t => {
  const f = await fixture(t, { sessionLifetimeMs: 16000 });
  const network = { snapshot: () => ({ phase: 'disabled', enabled: false, peers: [] }), subscribe: () => () => {}, close: async () => {},
    resolveLocalDataEndpoint: async input => input };
  const client = createClient({ network }); t.after(() => client.close());
  await client.connect({ deviceId: 'box-a', url: f.descriptor.baseUrl, mode: 'direct' }, {
    localTrust: { tlsSpkiSha256: f.descriptor.tlsSpkiSha256, scope: 'test' }, createSession: input => f.connect({ route: input, signal: input.signal }) });
  const original = client.snapshot().connection.dataContext.sessionId;
  const child = client.applicationConnection('centaurai.wanx.dialogue'); const oldChild = await child.localContext();
  let invalidated = false; child.onInvalidated(() => { invalidated = true; });
  f.exhaustAnonymous();
  await wait(1250);
  assert.equal(client.snapshot().phase, 'ready');
  assert.notEqual(client.snapshot().connection.dataContext.sessionId, original);
  assert.equal(invalidated, false); assert.equal((await child.request({ path: '/api/auth/me' })).status, 200);
  const newChild = await child.localContext(); assert.notEqual(newChild.sessionId, oldChild.sessionId);
  assert.equal(newChild.launchId, oldChild.launchId);
  assert.notDeepEqual(f.channels.get(newChild.sessionId).key, f.channels.get(oldChild.sessionId).key);
  assert.equal((await client.request({ path: '/api/personal-space/overview' })).status, 200);
});

test('automatic fresh-session path stops when binding authority changes rather than accepting expanded or replacement authority', async t => {
  const f = await fixture(t, { sessionLifetimeMs: 16000 });
  const network = { snapshot: () => ({ phase: 'disabled', enabled: false, peers: [] }), subscribe: () => () => {}, close: async () => {},
    resolveLocalDataEndpoint: async input => input };
  const client = createClient({ network }); t.after(() => client.close());
  await client.connect({ deviceId: 'box-a', url: f.descriptor.baseUrl, mode: 'direct' }, {
    localTrust: { tlsSpkiSha256: f.descriptor.tlsSpkiSha256, scope: 'test' }, createSession: input => f.connect({ route: input, signal: input.signal }) });
  f.changeRevision(); await wait(1250);
  assert.equal(client.snapshot().phase, 'disconnected'); assert.equal(client.snapshot().connection, null);
  assert.equal(client.snapshot().reason, 'LOCAL_DATA_CONTEXT_CHANGED');
  assert.equal(f.channels.size, 1);
});

test('lock during a fresh session handshake discards the late result and never restores a channel', async t => {
  const f = await fixture(t), session = await f.connect(), gate = f.holdNextSession();
  const controller = new AbortController();
  const pending = session.renew({ signal: controller.signal }); const rejected = assert.rejects(pending);
  await gate.entered; f.vault.lock(); gate.release(); await rejected; await tick();
  assert.equal(session.isLive(), false); assert.equal(f.provider.snapshot().phase, 'locked');
  await assert.rejects(f.connect(), /LOCAL_IDENTITY_LOCKED/);
});

test('streamed body crossing the 100 MiB route cap is rejected before any upstream bytes and releases disk reservations', async t => {
  const f = await fixture(t), session = await f.connect();
  const chunk = Buffer.alloc(1024 * 1024, 65);
  const source = Readable.from((async function* () { for (let i = 0; i < 101; i++) yield chunk; })());
  await assert.rejects(session.request({ path: '/api/personal-space/uploads/oversize', method: 'PUT', body: source }), /LOCAL_DATA_BODY_TOO_LARGE/);
  assert.equal(f.seen.length, 0); assert.deepEqual(await readdir(f.stagingDirectory), []);
  assert.equal((await session.request({ path: '/api/personal-space/uploads/next', method: 'PUT', body: 'small' })).status, 200);
});

test('JSON preflight rejects deep, cyclic, oversized and getter inputs without serializing or uploading them', async t => {
  const f = await fixture(t), session = await f.connect();
  let deep = {}; for (let i = 0; i < 42; i++) deep = { nested: deep };
  const cycle = {}; cycle.self = cycle;
  let reads = 0; const getter = { get secret() { reads++; return 'never'; } };
  for (const body of [deep, cycle, getter, { value: 'x'.repeat(3 * 1024 * 1024) }, new Array(1000001)])
    await assert.rejects(session.request({ path: '/api/personal-space/items', method: 'POST', body }));
  assert.equal(reads, 0); assert.equal(f.seen.length, 0);
});

test('WebSocket sender bounds frame and queued bytes instead of accepting unbounded child output', async t => {
  const f = await fixture(t), session = await f.connect();
  const socket = await session.openWebSocket({ path: '/api/agents/fixture-agent/chat/ws' });
  const closed = new Promise(resolve => socket.once('close', resolve));
  const error = await new Promise(resolve => socket.send(Buffer.alloc(17 * 1024 * 1024), resolve));
  assert.equal(error.code, 'LOCAL_DATA_CAPACITY'); await closed;
});

async function offlinePlatform(t, f) {
  const account = { snapshot: () => ({ phase: 'signed_out', accountId: null, clientId: null }), getIdentity: () => null,
    subscribe: () => () => {}, restore: async () => { throw Error('offline'); }, close: async () => {} };
  const platform = createPlatformClient({ account, localDataAccess: f.provider, createSession: () => { throw Error('legacy forbidden'); },
    createTransport() {
      const network = { snapshot: () => ({ enabled: false, phase: 'disabled', peers: [] }), subscribe: () => () => {}, close: async () => {},
        resolveLocalDataEndpoint: async input => input };
      return { network, client: createClient({ network }) };
    } });
  t.after(() => platform.close()); await platform.initialize(); await platform.connectBox('box-a');
  const launch = async () => {
    const session = await createApplicationSession({ hostApplicationId: 'wanx-host', applicationId: 'centaurai.wanx.dialogue', installPath: f.root,
      capabilities: ['identity.read', 'http.request', 'chat.stream'],
      createConnection: ({ applicationId, ...options }) => platform.applicationConnection(applicationId, options) });
    t.after(() => session.close());
    const sdk = fromEnvironment(session.environment); t.after(() => sdk.close());
    return { session, sdk };
  };
  return { platform, launch };
}

async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < end, 'state transition deadline'); await wait(20); }
}

test('real offline Host HTTP and scoped WS rotate fresh channels without ending the launch, then lock destroys the live authority', async t => {
  const f = await fixture(t, { sessionLifetimeMs: 16000 });
  const { platform, launch } = await offlinePlatform(t, f), { session: app, sdk } = await launch();
  const before = await sdk.context(), rootBefore = platform.snapshot().dataIdentity.selected.sessionId;
  const socket = await sdk.openStream('/api/agents/fixture-agent/chat/ws');
  await once(socket, 'message'); const closed = once(socket, 'close');
  let invalidated = 0; app.onInvalidated(() => invalidated++);
  await until(() => platform.snapshot().dataIdentity.selected?.sessionId !== rootBefore);
  await closed;
  assert.equal(invalidated, 0); app.assertLive();
  const after = await sdk.context(); assert.notEqual(after.dataIdentity.sessionId, before.dataIdentity.sessionId);
  assert.equal(after.dataIdentity.launchId, before.dataIdentity.launchId);
  assert.equal((await sdk.request('/api/agents')).status, 200);
  assert.equal(f.seen.at(-1).proof.sessionId, after.dataIdentity.sessionId);
  const reconnected = await sdk.openStream('/api/agents/fixture-agent/chat/ws'); await once(reconnected, 'message');
  assert.equal(f.seen.at(-1).proof.sessionId, after.dataIdentity.sessionId);
  const locked = once(reconnected, 'close'), started = Date.now(); f.vault.lock();
  assert.throws(() => app.assertLive(), /HOST_SESSION_EXPIRED/); await locked;
  assert.equal(invalidated, 1); assert.ok(Date.now() - started < 1000);
});

test('launch during rotation waits for fresh parent while closing an older launch cannot publish a replacement for it', async t => {
  const f = await fixture(t, { sessionLifetimeMs: 16000 });
  const { platform, launch } = await offlinePlatform(t, f), first = await launch();
  const old = await first.sdk.context(), rootBefore = platform.snapshot().dataIdentity.selected.sessionId;
  const gate = f.holdNextSession(); await gate.entered;
  await first.session.close(); let created = false;
  const pending = launch().then(value => { created = true; return value; });
  await wait(30); assert.equal(created, false);
  gate.release(); const second = await pending;
  await until(() => platform.snapshot().dataIdentity.selected?.sessionId !== rootBefore);
  const current = await second.sdk.context(); assert.notEqual(current.dataIdentity.sessionId, old.dataIdentity.sessionId);
  assert.equal((await second.sdk.request('/api/agents')).status, 200);
  assert.throws(() => first.session.assertLive(), /HOST_SESSION_EXPIRED/);
  // There was no replacement child for the launch closed during the root handshake.
  assert.equal([...f.channels.values()].filter(channel => channel.launchId === first.session.launchId).length, 1);
});

test('a child-only scope change during fresh authorization destroys stable Host authority instead of replacing its ceiling', async t => {
  const f = await fixture(t, { sessionLifetimeMs: 16000 });
  const { platform, launch } = await offlinePlatform(t, f), { session: app } = await launch();
  f.changeApplicationGrants('centaurai.wanx.dialogue', [{ resourceId: 'wanx', actions: ['read'] }]);
  await until(() => platform.snapshot().phase !== 'ready');
  assert.equal(platform.snapshot().connection, null);
  assert.throws(() => app.assertLive(), /HOST_SESSION_EXPIRED/);
  assert.equal(f.channels.size, 4); // root and child each had a distinct rejected replacement.
});

test('launch capacity reserves a whole fresh replacement batch and releases the slot on close', async t => {
  const f = await fixture(t), network = { snapshot: () => ({ phase: 'disabled', enabled: false, peers: [] }),
    subscribe: () => () => {}, close: async () => {}, resolveLocalDataEndpoint: async input => input };
  const client = createClient({ network }); t.after(() => client.close());
  await client.connect({ deviceId: 'box-a', url: f.descriptor.baseUrl, mode: 'direct' }, {
    localTrust: { tlsSpkiSha256: f.descriptor.tlsSpkiSha256, scope: 'test' }, createSession: input => f.connect({ route: input, signal: input.signal }) });
  const launches = [];
  for (let i = 0; i < 14; i++) { const child = client.applicationConnection('centaurai.wanx.dialogue'); await child.localContext(); launches.push(child); }
  assert.throws(() => client.applicationConnection('centaurai.wanx.dialogue'), /LOCAL_DATA_CAPACITY/);
  launches[0].close();
  const replacement = client.applicationConnection('centaurai.wanx.dialogue'); await replacement.localContext();
  assert.equal((await replacement.request({ path: '/api/auth/me' })).status, 200);
});

test('native assistant metadata uses only fixed read-only routes over the local session', async t => {
  const f = await fixture(t), session = await f.connect({ applicationId: 'centaurai.wanx.dialogue' });
  for (const target of ['/api/providers/resolved', '/api/providers/active-model', '/api/preferences', '/api/settings/timezone', '/api/assistant/conversations']) {
    assert.equal((await session.request({ path: target })).status, 200);
  }
  assert.equal((await session.request({ path: '/api/assistant/profile', method: 'POST' })).status, 200);
  const count = f.seen.length;
  for (const [target, method] of [['/api/providers', 'GET'], ['/api/providers/active-model', 'PUT'], ['/api/preferences', 'PATCH'], ['/api/settings/captcha', 'GET'], ['/api/_client/space-mcp/connections', 'POST']]) {
    await assert.rejects(session.request({ path: target, method }), /LOCAL_DATA_FORBIDDEN/);
  }
  assert.equal(f.seen.length, count);
  const unrelated = await f.connect({ applicationId: 'centaurai.wanx.ai-browser' });
  await assert.rejects(unrelated.request({ path: '/api/providers/resolved' }), /LOCAL_DATA_FORBIDDEN/);
  await assert.rejects(unrelated.request({ path: '/api/assistant/conversations' }), /LOCAL_DATA_FORBIDDEN/);
});
