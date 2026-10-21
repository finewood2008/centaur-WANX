import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createAccount } from '../account/index.mjs';
import { createPairingConsumer } from '../account/pairing.mjs';
import { createSetupRuntime } from '../shell/setup.mjs';
import { registerControlActions } from '../shell/control.mjs';

const deviceId = 'centauros-37859979e324b9e257c586da';
const attemptId = '11111111-1111-4111-8111-111111111111';
const claimCode = 'ABCDEFG234';
const hash = value => createHash('sha256').update(value).digest('hex');
const pending = { deviceId, ownership: 'claimed', authorizationState: 'deviceAckPending' };
const ready = { deviceId, ownershipStatus: 'active', accessStatus: 'ready', securityStatus: 'normal',
  capabilities: { canConnect: { enabled: true } } };
const envelope = data => Response.json({ code: 0, success: true, data,
  requestId: 'request-one', serverTime: '2026-10-21T00:00:00Z' }, { headers: { 'x-request-id': 'request-one' } });

async function accountFixture(t) {
  let saved, reply = () => Response.json({ code: 200, data: { deviceId, ownership: 'claimed' } });
  const calls = [];
  const account = createAccount({ store: { load: async () => saved, save: async value => { saved = value; } },
    fetch: async (url, input) => {
      const call = { url, ...input }; calls.push(call);
      if (url.endsWith('/login')) return Response.json({ code: 200, data: { accountId: 'account-one',
        clientId: JSON.parse(input.body).clientId, accessToken: 'token', refreshToken: 'refresh', expiresIn: 3600 } });
      if (url.endsWith('/logout')) return Response.json({ code: 200, data: {} });
      return reply(call);
    } });
  t.after(() => account.close());
  await account.loginPassword({ phone: '13800000000', password: 'test' });
  const identity = account.getIdentity();
  return { account, calls, identity, reply: next => { reply = next; },
    bootstrap: devices => ({ account: { accountId: identity.accountId, accountStatus: 'active',
      currentClient: { clientId: identity.clientId, isCurrent: true, clientStatus: 'active', hasActiveSession: true } }, devices }),
    publicKey: () => saved.accounts['13800000000'].identity.publicKey };
}

test('console redemption signs the selected device and keeps a legacy receipt pending', async t => {
  const h = await accountFixture(t);
  const input = { claimCode, clientAttemptId: attemptId, expectedDeviceId: deviceId };
  assert.deepEqual(await h.account.redeemConsoleClaim(input), pending);
  const call = h.calls.at(-1), headers = call.headers;
  assert.deepEqual(JSON.parse(call.body), input);
  assert.equal(headers['X-Nexus-Body-SHA256'], hash(call.body));
  assert.equal(headers['Idempotency-Key'], attemptId);
  assert.equal(headers['X-Nexus-Signature-Version'], undefined);
  const canonical = ['NEXUSAOS-CONSUMER-V1', h.identity.accountId, h.identity.clientId, 'POST',
    '/app-api/device-console-claims/redeem', headers['X-Nexus-Timestamp'], headers['X-Nexus-Nonce'], hash(call.body)].join('\n');
  assert.ok(verify('sha256', Buffer.from(canonical), h.publicKey(), Buffer.from(headers['X-Nexus-Signature'], 'base64')));
  await h.account.redeemConsoleClaim({ claimCode, clientAttemptId: attemptId });
  assert.deepEqual(JSON.parse(h.calls.at(-1).body), { claimCode, clientAttemptId: attemptId });
});

test('console redemption rejects mismatched devices, invalid states and invalid target IDs', async t => {
  const h = await accountFixture(t);
  for (const device of ['', '.', '..', '../box', 'a'.repeat(37), null])
    await assert.rejects(h.account.redeemConsoleClaim({ claimCode, clientAttemptId: attemptId, expectedDeviceId: device }), { code: 'ACCOUNT_INVALID_INPUT' });
  for (const response of [{ ...pending, deviceId: 'other-box' }, { ...pending, authorizationState: 'active' }]) {
    h.reply(() => Response.json({ code: 200, data: response }));
    await assert.rejects(h.account.redeemConsoleClaim({ claimCode, clientAttemptId: attemptId, expectedDeviceId: deviceId }), { code: 'ACCOUNT_INVALID_RESPONSE' });
  }
  for (const authorizationState of ['deviceAckPending', 'ready', 'blocked']) {
    h.reply(() => Response.json({ code: 200, data: { ...pending, authorizationState, privateToken: 'secret' } }));
    assert.deepEqual(await h.account.redeemConsoleClaim({ claimCode, clientAttemptId: attemptId }), { ...pending, authorizationState });
  }
});

test('console redemption cancellation prevents dispatch and discards an old login receipt', async t => {
  const h = await accountFixture(t), controller = new AbortController(); controller.abort();
  const before = h.calls.length;
  await assert.rejects(h.account.redeemConsoleClaim({ claimCode, clientAttemptId: attemptId, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.length, before);
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  h.reply(async () => { entered(); await new Promise(resolve => { release = resolve; }); return Response.json({ code: 200, data: pending }); });
  const operation = h.account.redeemConsoleClaim({ claimCode, clientAttemptId: attemptId });
  const rejected = assert.rejects(operation, { code: 'ACCOUNT_CANCELLED' });
  await reached; await h.account.logout(); release(); await rejected;
});

test('console authorization requires latest bootstrap ACK and every authorization gate', async t => {
  const h = await accountFixture(t);
  for (const devices of [[], [{ ...ready, deviceId: 'other-box' }], [{ deviceId, status: 'active', accessState: 'ready', online: true }],
    [{ ...ready, accessStatus: 'projectionPending' }], [{ ...ready, accessStatus: 'deviceAckPending' }],
    [{ ...ready, ownershipStatus: 'claimPending' }], [{ ...ready, securityStatus: undefined }],
    [{ ...ready, capabilities: { canConnect: { enabled: false } } }]]) {
    h.reply(() => envelope(h.bootstrap(devices)));
    assert.deepEqual(await h.account.getConsoleClaimAuthorization(deviceId), { deviceId, authorizationState: 'deviceAckPending' });
  }
  h.reply(() => envelope(h.bootstrap([ready])));
  assert.deepEqual(await h.account.getConsoleClaimAuthorization(deviceId), { deviceId, authorizationState: 'ready' });
  assert.ok(h.calls.at(-1).url.endsWith('/app-api/v1/sync/bootstrap'));
  for (const override of [{ accessStatus: 'blocked' }, { securityStatus: 'disabled' }, { securityStatus: 'quarantined' }, { ownershipStatus: 'releasePending' }]) {
    h.reply(() => envelope(h.bootstrap([{ ...ready, ...override }])));
    assert.deepEqual(await h.account.getConsoleClaimAuthorization(deviceId), { deviceId, authorizationState: 'blocked' });
  }
});

test('console authorization rejects mismatched or inactive bootstrap identities and duplicate targets', async t => {
  const h = await accountFixture(t);
  const invalid = [value => { value.account.accountId = 'other'; }, value => { value.account.accountStatus = 'disabled'; },
    value => { value.account.currentClient.clientId = 'other'; }, value => { value.account.currentClient.isCurrent = false; },
    value => { value.account.currentClient.clientStatus = 'revoked'; }, value => { value.account.currentClient.hasActiveSession = false; },
    value => { value.devices.push(ready); }];
  for (const modify of invalid) {
    const data = h.bootstrap([ready]); modify(data); h.reply(() => envelope(data));
    await assert.rejects(h.account.getConsoleClaimAuthorization(deviceId), { code: 'ACCOUNT_INVALID_RESPONSE' });
  }
});

const attestation = { deviceId, certificatePem: '-----BEGIN CERTIFICATE-----', certificateChainPem: [],
  publicKeySha256: 'a'.repeat(64), serialNumber: '01', certificateStatus: 'active',
  expiresAt: '2027-10-21T00:00:00Z', statusCheckedAt: '2026-10-21T00:00:00Z' };
const wifiInput = clientId => ({ deviceId, clientId, pairingSessionId: attemptId, clientAttemptId: attemptId,
  helloContextId: Buffer.alloc(16, 1).toString('base64url'),
  ...Object.fromEntries(['appNonce', 'clientNonce', 'pairingDeviceNonce', 'challengeNonce'].map(key => [key, Buffer.alloc(32, 2).toString('base64url')])),
  deviceInfoSha256: 'a'.repeat(64), signature: Buffer.alloc(256, 3).toString('base64'), pairingTokenCiphertextSha256: 'b'.repeat(64) });
const permit = identity => ({ permit: { payload: { schemaVersion: 1, purpose: 'console-wifi', deviceId, claimSessionId: attemptId,
  accountId: identity.accountId, clientId: identity.clientId, pairingSessionId: attemptId, challengeCanonicalSha256: 'c'.repeat(64),
  pairingTokenCiphertextSha256: 'b'.repeat(64), expiresInSeconds: 300 },
  keyId: 'console-wifi-key', algorithm: 'Ed25519', signature: Buffer.alloc(64, 4).toString('base64') } });

test('console Wi-Fi endpoints sign code plus exact target without changing ownership', async t => {
  const h = await accountFixture(t), consumer = createPairingConsumer(h.account); t.after(() => consumer.dispose());
  const api = await consumer.pairingApi();
  h.reply(() => envelope(attestation));
  assert.deepEqual((await api.getConsoleWifiAttestation(claimCode, deviceId)).data, attestation);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body), { claimCode, expectedDeviceId: deviceId });
  assert.ok(h.calls.at(-1).url.endsWith('/app-api/device-console-claims/wifi-attestation'));
  assert.equal(h.calls.at(-1).headers['X-Nexus-Signature-Version'], undefined);
  const input = wifiInput(h.identity.clientId), data = permit(h.identity);
  h.reply(() => envelope(data));
  assert.deepEqual((await api.authorizeConsoleWifi(claimCode, input)).data, data);
  assert.deepEqual(JSON.parse(h.calls.at(-1).body), { claimCode, ...input });
  assert.ok(h.calls.at(-1).url.endsWith('/app-api/device-console-claims/wifi-authorize'));
  assert.equal(h.calls.at(-1).headers['X-Nexus-Signature-Version'], undefined);
  assert.equal(h.calls.at(-1).headers['Idempotency-Key'], undefined);
  assert.equal(h.calls.some(call => call.url.endsWith('/redeem') || call.url.endsWith('/prove')), false);
});

test('console Wi-Fi adapter rejects forged requests, mismatched attestation and malformed permits', async t => {
  const h = await accountFixture(t), consumer = createPairingConsumer(h.account); t.after(() => consumer.dispose());
  const api = await consumer.pairingApi(), input = wifiInput(h.identity.clientId);
  for (const code of ['', '123', 'abcdefg234']) assert.throws(() => api.getConsoleWifiAttestation(code, deviceId), { code: 'INVALID_REQUEST' });
  assert.throws(() => api.authorizeConsoleWifi(claimCode, { ...input, clientId: 'other' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => api.authorizeConsoleWifi(claimCode, { ...input, requestedOps: ['claim'] }), { code: 'INVALID_REQUEST' });
  h.reply(() => envelope({ ...attestation, deviceId: 'other' }));
  await assert.rejects(api.getConsoleWifiAttestation(claimCode, deviceId), { code: 'CONTRACT_MISMATCH' });
  for (const change of [{ purpose: 'owner-wifi' }, { schemaVersion: 2 }, { expiresInSeconds: 301 }, { deviceId: 'other' },
    { accountId: 'other' }, { clientId: 'other' }, { claimSessionId: 'bad' }, { pairingSessionId: '22222222-2222-4222-8222-222222222222' },
    { challengeCanonicalSha256: 'invalid' }, { pairingTokenCiphertextSha256: 'a'.repeat(64) }, { ownerAccountId: h.identity.accountId }]) {
    const data = permit(h.identity); Object.assign(data.permit.payload, change); h.reply(() => envelope(data));
    await assert.rejects(api.authorizeConsoleWifi(claimCode, input), { code: 'CONTRACT_MISMATCH' });
  }
  for (const change of [{ signature: 'bad' }, { algorithm: 'RSA' }, { keyId: '' }, { privateKey: 'unexpected' }]) {
    const data = permit(h.identity); Object.assign(data.permit, change); h.reply(() => envelope(data));
    await assert.rejects(api.authorizeConsoleWifi(claimCode, input), { code: 'CONTRACT_MISMATCH' });
  }
});

test('console Wi-Fi checks account generation and cancellation before dispatch', async t => {
  const h = await accountFixture(t), consumer = createPairingConsumer(h.account); t.after(() => consumer.dispose());
  const api = await consumer.pairingApi(), controller = new AbortController(); controller.abort();
  const before = h.calls.length;
  await assert.rejects(api.getConsoleWifiAttestation(claimCode, deviceId, controller.signal), { name: 'AbortError' });
  assert.equal(h.calls.length, before);
  await h.account.logout();
  await assert.rejects(api.getConsoleWifiAttestation(claimCode, deviceId), { code: 'AUTH_REQUIRED' });
});

test('setup redemption callback pins target, account and client across the request', async t => {
  const contents = new EventEmitter(); contents.send = () => {};
  const ipcMain = { handle() {}, removeHandler() {} };
  let identity = { accountId: 'account-one', clientId: 'client-one' }, options, redeem = async () => pending;
  const calls = [];
  const account = { getIdentity: () => identity, snapshot: () => ({ phase: 'authenticated' }), subscribe: () => () => {},
    redeemConsoleClaim: async input => { calls.push(input); return redeem(); } };
  const runtime = await createSetupRuntime({ control: { webContents: contents, isDestroyed: () => false },
    controlURL: 'file:///client/index.html', ipcMain, account, client: { refreshDevices: async () => {} },
    makeStore: () => ({}), makeHost: input => { options = input; return { subscribe: () => () => {}, dispose: async () => {} }; },
    installPicker: () => () => {} });
  t.after(() => runtime.dispose());
  const context = { ...identity, clientAttemptId: attemptId, signal: new AbortController().signal };
  assert.deepEqual(await options.redeemConsoleClaim(claimCode, deviceId, context), pending);
  assert.deepEqual(calls[0], { claimCode, expectedDeviceId: deviceId, clientAttemptId: attemptId, signal: context.signal });
  await assert.rejects(options.redeemConsoleClaim(claimCode, deviceId, { ...context, accountId: 'other' }), { code: 'AUTH_SESSION_CHANGED' });
  assert.equal(calls.length, 1);
  redeem = async () => ({ ...pending, deviceId: 'other' });
  await assert.rejects(options.redeemConsoleClaim(claimCode, deviceId, context), { code: 'CONTRACT_MISMATCH' });
  redeem = async () => { identity = { ...identity, clientId: 'next-client' }; return pending; };
  await assert.rejects(options.redeemConsoleClaim(claimCode, deviceId, context), { code: 'AUTH_SESSION_CHANGED' });
});

test('preload and control preserve claim target, keep status read-only and restrict setup redemption fields', async () => {
  const controlURL = 'file:///client/index.html', mainFrame = { url: controlURL };
  const contents = { mainFrame }, event = { sender: contents, senderFrame: mainFrame };
  const handlers = new Map(), exposed = {}, calls = [];
  let publishes = 0;
  registerControlActions({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    control: { webContents: contents, isDestroyed: () => false }, controlURL,
    client: { snapshot: () => ({ account: { phase: 'authenticated' } }),
      redeemConsoleClaim: async input => { calls.push(['claim', input]); return pending; },
      getConsoleClaimAuthorization: async id => { calls.push(['status', id]); return { deviceId: id, authorizationState: 'deviceAckPending' }; } },
    publishState: () => { publishes++; } });
  handlers.set('wanx:setup:redeemClaimCode', (_event, input) => { calls.push(['setup', input]); return { ok: true, value: pending }; });
  const source = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { process: { platform: process.platform },
    require: name => { assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
      ipcRenderer: { invoke: async (name, input) => handlers.get(name)(event, input), on() {} } }; } });
  const input = { claimCode, clientAttemptId: attemptId, expectedDeviceId: deviceId };
  assert.equal((await exposed.wanxClient.action('devices.claim', input)).ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['claim', input]);
  assert.equal(publishes, 1);
  const status = await exposed.wanxClient.action('devices.claim-status', { deviceId });
  assert.equal(status.value.authorizationState, 'deviceAckPending');
  assert.deepEqual(calls.at(-1), ['status', deviceId]);
  assert.equal(publishes, 1);
  await exposed.wanxSetup.redeemClaimCode({ ...input, accountId: 'forged' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['setup', { claimCode, clientAttemptId: attemptId }]);
  const statusHandler = handlers.get('wanx-client:console-claim-status');
  assert.throws(() => statusHandler(event, { deviceId, accountId: 'forged' }), /ACCOUNT_INVALID_INPUT/);
  assert.throws(() => statusHandler({ ...event, sender: {} }, { deviceId }), /无权/);
});
