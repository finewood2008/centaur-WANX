import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { createPinnedTransport } from '../device-trust/pinned-transport.mjs';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';

const cert = readFileSync(new URL('./fixtures/tls/server-cert.pem', import.meta.url));
const key = readFileSync(new URL('./fixtures/tls/server-key.pem', import.meta.url));
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const boxKey = pair.publicKey.export({ format: 'jwk' });
const digest = (value) => createHash('sha256').update(value).digest('base64url');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const tlsSpkiSha256 = digest(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }));
function response(kind = 'auth-challenge', changes = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { schemaVersion: 1, purpose: 'centuarai.local-management.response', boxId: 'test-box',
    boxKeyThumbprint: publicKeyThumbprint(boxKey), kind, issuedAt: now,
    body: { nonce: Buffer.alloc(32, 8).toString('base64url'), issuedAt: now, expiresAt: now + 60, ownershipEpoch: 1 }, ...changes };
  const h = Buffer.from(canonical({ alg: 'ES256', typ: 'centuarai-local-management-response+jws' })).toString('base64url');
  const p = Buffer.from(canonical(payload)).toString('base64url');
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function fixture(t, handler) {
  const server = https.createServer({ cert, key }, handler);
  let requests = 0, rawBytes = 0;
  server.on('request', () => { requests += 1; });
  server.on('secureConnection', (socket) => socket.on('data', (chunk) => { rawBytes += chunk.length; }));
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const descriptor = { boxId: 'test-box', baseUrl: `https://127.0.0.1:${server.address().port}`, boxKey, tlsSpkiSha256 };
  return { server, descriptor, counts: () => ({ requests, rawBytes }) };
}
function jose(res, text = response()) {
  res.writeHead(200, { 'Content-Type': 'application/jose', 'Cache-Control': 'no-store' }); res.end(text);
}

test('real private HTTPS validates SPKI then sends only the fixed POST and returns verified raw box JWS', async (t) => {
  let observed;
  const raw = response();
  const f = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    observed = { path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers };
    jose(res, raw);
  });
  const transport = createPinnedTransport({ descriptor: f.descriptor });
  assert.equal(await transport.request('/auth/challenge', {}), raw);
  assert.equal(observed.path, '/local-trust/v1/auth/challenge');
  assert.equal(observed.method, 'POST'); assert.equal(observed.body, '{}');
  assert.equal(observed.headers.authorization, undefined); assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.headers['content-type'], 'application/json');
});

test('wrong SPKI sends neither HTTP headers nor body even when the HTTPS peer can complete TLS', async (t) => {
  const f = await fixture(t, (_req, res) => jose(res));
  const transport = createPinnedTransport({ descriptor: { ...f.descriptor, tlsSpkiSha256: Buffer.alloc(32, 1).toString('base64url') } });
  await assert.rejects(transport.request('/first-root/commit', {
    accessProof: 'sensitive.access', approvalProof: 'sensitive.approval', secretProof: 'sensitive.secret',
  }), /TLS_PIN_MISMATCH/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.counts(), { requests: 0, rawBytes: 0 });
});

test('HTTP redirect is rejected without following to a different host or path', async (t) => {
  let forwarded = 0;
  const target = await fixture(t, (_req, res) => { forwarded += 1; jose(res); });
  const source = await fixture(t, (_req, res) => {
    res.writeHead(307, { Location: `${target.descriptor.baseUrl}/stolen` }); res.end();
  });
  await assert.rejects(createPinnedTransport({ descriptor: source.descriptor }).request('/auth/challenge', {}), /REDIRECT_REFUSED/);
  assert.equal(forwarded, 0);
});

test('operation paths and exact request fields cannot redirect or send arbitrary headers/credentials', async (t) => {
  const f = await fixture(t, (_req, res) => jose(res));
  const transport = createPinnedTransport({ descriptor: f.descriptor });
  for (const path of ['https://evil.invalid', '//evil.invalid', '/auth/challenge?x=y', '/auth/challenge#x',
    '/local-trust/v1/auth/challenge', '/../auth/challenge', '/auth/%63hallenge', 'toString', '__proto__']) {
    await assert.rejects(transport.request(path, {}), /REQUEST_INVALID/);
  }
  await assert.rejects(transport.request('/auth/challenge', { secret: 'never-send' }), /REQUEST_INVALID/);
  await assert.rejects(transport.request('/state', { proof: 'x', authorization: 'bearer' }), /REQUEST_INVALID/);
  await assert.rejects(transport.request('/state', { proof: 'x'.repeat(16385) }), /REQUEST_INVALID/);
  assert.equal(f.counts().requests, 0);
});

for (const [label, value, expected] of [
  ['wrong box identity', () => response('auth-challenge', { boxId: 'wrong-box' }), /CONTEXT_MISMATCH/],
  ['wrong fixed operation kind', () => response('first-root-challenge'), /KIND_INVALID/],
  ['changed signature', () => response().replace(/.$/, '.'), /LOCAL_MANAGEMENT_INVALID/],
  ['unknown signed body field', () => { const now = Math.floor(Date.now() / 1000); return response('auth-challenge', {
    body: { nonce: Buffer.alloc(32).toString('base64url'), issuedAt: now, expiresAt: now + 60, ownershipEpoch: 1, verified: true },
  }); }, /LOCAL_MANAGEMENT_INVALID/],
]) {
  test(`TLS-authenticated server still cannot bypass signed response verification: ${label}`, async (t) => {
    const f = await fixture(t, (_req, res) => jose(res, value()));
    await assert.rejects(createPinnedTransport({ descriptor: f.descriptor }).request('/auth/challenge', {}), expected);
  });
}

test('the independent signing key pin is required even with the correct TLS pin', async (t) => {
  const f = await fixture(t, (_req, res) => jose(res));
  const wrongKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  await assert.rejects(createPinnedTransport({ descriptor: { ...f.descriptor, boxKey: wrongKey } }).request('/auth/challenge', {}), /CONTEXT_MISMATCH/);
});

for (const [label, handler, expected] of [
  ['declared oversized', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/jose', 'Content-Length': '999999' }); res.write('x'); }, /RESPONSE_TOO_LARGE/],
  ['chunked oversized', (_req, res) => jose(res, 'x'.repeat(5000)), /RESPONSE_TOO_LARGE/],
  ['JSON success wrapper', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }, /RESPONSE_REJECTED/],
  ['compression', (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/jose', 'Content-Encoding': 'gzip' }); res.end('x'); }, /RESPONSE_INVALID/],
  ['server rejection', (_req, res) => { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"code":"DO_NOT_ECHO_SECRETS"}'); }, /RESPONSE_REJECTED/],
]) {
  test(`bounded transport rejects ${label}`, async (t) => {
    const f = await fixture(t, handler);
    await assert.rejects(createPinnedTransport({ descriptor: f.descriptor, maxResponseBytes: 1024 }).request('/auth/challenge', {}), expected);
  });
}

test('total deadline covers a peer that never finishes its HTTPS response', async (t) => {
  const f = await fixture(t, () => {});
  await assert.rejects(createPinnedTransport({ descriptor: f.descriptor, timeoutMs: 30 }).request('/auth/challenge', {}), /TIMEOUT/);
});

test('only exact bounded reviewed server codes reach the coordinator', async (t) => {
  let body;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(body);
  });
  const transport = createPinnedTransport({ descriptor: f.descriptor });
  for (const code of ['LOCAL_TRUST_ALREADY_OWNED', 'LOCAL_TRUST_CLOCK_ROLLBACK', 'LOCAL_BINDING_EXPIRED',
    'LOCAL_BINDING_CONTEXT_MISMATCH', 'LOCAL_TRUST_RATE_LIMITED', 'LOCAL_TRUST_UNAVAILABLE',
    'LOCAL_TRUST_BODY_TIMEOUT', 'LOCAL_TRUST_BODY_TOO_LARGE', 'LOCAL_TRUST_INVALID_REQUEST',
    'LOCAL_TRUST_ROUTE_UNAVAILABLE', 'LOCAL_TRUST_SOURCE_INVALID', 'LOCAL_TRUST_TRANSPORT_DENIED']) {
    body = JSON.stringify({ code });
    await assert.rejects(transport.request('/auth/challenge', {}), (error) => error.code === code && error.message === code);
  }
  for (const invalid of ['{"code":"LOCAL_TRUST_SECRET_VALUE"}', '{"code":"LOCAL_BINDING_NEW_UNREVIEWED"}',
    '{"code":"LOCAL_BINDING_EXPIRED","details":"secret"}', '{"code":"secret","code":"LOCAL_BINDING_EXPIRED"}',
    '{"code":"LOCAL_BINDING_EXPIRED","verified":true}', '["LOCAL_BINDING_EXPIRED"]']) {
    body = invalid;
    await assert.rejects(transport.request('/auth/challenge', {}), (error) => error.code === 'LOCAL_MANAGEMENT_RESPONSE_REJECTED'
      && !error.message.includes('secret'));
  }
  body = 'x'.repeat(1025);
  await assert.rejects(transport.request('/auth/challenge', {}), /RESPONSE_TOO_LARGE/);
});

test('total deadline covers TLS handshake stalls and sends no request body', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  const descriptor = { boxId: 'test-box', boxKey, tlsSpkiSha256, baseUrl: `https://127.0.0.1:${server.address().port}` };
  await assert.rejects(createPinnedTransport({ descriptor, timeoutMs: 30 }).request('/auth/challenge', {}), /TIMEOUT/);
});

test('cancellation aborts a pending response and an already aborted request sends nothing', async (t) => {
  let arrived;
  const received = new Promise((resolve) => { arrived = resolve; });
  const f = await fixture(t, () => arrived());
  const transport = createPinnedTransport({ descriptor: f.descriptor });
  const controller = new AbortController();
  const pending = transport.request('/auth/challenge', {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, /ABORTED/);
  await received; controller.abort(); await rejected;
  await assert.rejects(transport.request('/auth/challenge', {}, { signal: controller.signal }), /ABORTED/);
  assert.equal(f.counts().requests, 1);
});

test('each request rechecks fresh TLS and immutable descriptor pins cannot be replaced midflight', async (t) => {
  const f = await fixture(t, (_req, res) => jose(res));
  let connections = 0; f.server.on('secureConnection', () => { connections += 1; });
  const external = structuredClone(f.descriptor);
  const transport = createPinnedTransport({ descriptor: external });
  external.tlsSpkiSha256 = Buffer.alloc(32, 1).toString('base64url');
  external.baseUrl = 'https://evil.invalid';
  await transport.request('/auth/challenge', {}); await transport.request('/auth/challenge', {});
  assert.equal(connections, 2); assert.equal(f.counts().requests, 2);
});

test('only fixed signed backup inspections receive the bounded longer deadline and remain cancellable', async t => {
  const { signBackupIOProof, signBackupIOResponse } = await import('../device-trust/backup-contract.mjs');
  const { ledgerDigest } = await import('../device-trust/ledger-contract.mjs');
  const now = Math.floor(Date.now() / 1000), nonce = Buffer.alloc(32, 7).toString('base64url');
  const scope = { resourceRoots: ['/var/lib/business'], cacheRoots: ['/var/lib/backup'], preservedSecurityRoots: ['/var/lib/security'],
    affectedPrincipals: 1, affectedBindings: 1, retainedExternalBackups: true };
  const resetPlanDigest = digest('plan');
  const body = { type: 'ownership-transfer-plan', scope, resetPlanDigest, dataDisposition: 'erase-local', retainedIndependentBackups: true,
    scopeManifestDigest: ledgerDigest({ purpose: 'centuarai.local-ledger.transfer-scope', resetPlanDigest, scope }) };
  const proofPayload = { schemaVersion: 1, purpose: 'centuarai.local-backup.io', boxId: 'test-box', boxKeyThumbprint: publicKeyThumbprint(boxKey),
    ownershipEpoch: 1, principalSecurityVersion: 1, nonce, issuedAt: now, expiresAt: now + 60,
    actor: { kind: 'binding', principalId: 'principal', bindingId: 'binding', keyVersion: 1 }, operation: 'transfer.plan', bodySha256: ledgerDigest({}) };
  const receipt = signBackupIOResponse({ schemaVersion: 1, purpose: 'centuarai.local-backup.io-response', boxId: 'test-box',
    boxKeyThumbprint: publicKeyThumbprint(boxKey), operation: 'transfer.plan', nonce, requestBodySha256: proofPayload.bodySha256, issuedAt: now, body }, pair.privateKey);
  const outer = JSON.stringify({ receipt, contentBase64: null });
  const f = await fixture(t, (_req, res) => { setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(outer); } }, 40); });
  const transport = createPinnedTransport({ descriptor: f.descriptor, protocolVersion: 2, timeoutMs: 15, inspectionTimeoutMs: 250 });
  const input = { body: {}, proof: signBackupIOProof(proofPayload, pair.privateKey) };
  assert.equal(await transport.request('/backup-io/transfer.plan', input), outer);
  await assert.rejects(transport.request('/auth/challenge', {}), /TIMEOUT/);
  const abort = new AbortController(), pending = transport.request('/backup-io/transfer.plan', input, { signal: abort.signal });
  abort.abort(); await assert.rejects(pending, /ABORTED/);
  assert.throws(() => createPinnedTransport({ descriptor: f.descriptor, inspectionTimeoutMs: 60001 }), /LIMIT_INVALID/);
});
