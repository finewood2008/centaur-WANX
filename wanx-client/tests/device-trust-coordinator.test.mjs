import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDeviceTrustCoordinator } from '../device-trust/coordinator.mjs';
import { createIdentityVault } from '../device-trust/identity-vault.mjs';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { firstRootDigest } from '../device-trust/management-contract.mjs';
import { registerDeviceTrustLifecycle } from '../shell/device-trust-lifecycle.mjs';
import { registerControlActions } from '../shell/control.mjs';

const canonical = value => value !== null && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const token = () => randomBytes(32).toString('base64url');
const passphrase = 'independent test passphrase';
function boxFixture() {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const descriptor = { boxId: 'test-box', baseUrl: 'https://127.0.0.1:9443', boxKey: key.publicKey.export({ format: 'jwk' }), tlsSpkiSha256: token() };
  const packet = { schemaVersion: 1, type: 'centuarai-local-trust-delivery', ...descriptor,
    provisioningId: token(), ownershipEpoch: 1, claimSecret: token() };
  let currentTime = Math.floor(Date.now() / 1000);
  let savedAck;
  let loseResponse = false;
  const calls = [];
  const response = (kind, body) => {
    const header = Buffer.from(canonical({ alg: 'ES256', typ: 'centuarai-local-management-response+jws' })).toString('base64url');
    const payload = Buffer.from(canonical({ schemaVersion: 1, purpose: 'centuarai.local-management.response',
      boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), kind, issuedAt: currentTime, body })).toString('base64url');
    const input = `${header}.${payload}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  return {
    packet, descriptor, calls, clock: () => currentTime * 1000,
    ackBody: () => JSON.parse(Buffer.from(savedAck.split('.')[1], 'base64url')).body,
    advance(seconds) { currentTime += seconds; },
    loseNextResponse() { loseResponse = true; },
    transportFactory: () => ({ async request(route, input) {
      calls.push(route);
      if (route === '/first-root/challenge') return response('first-root-challenge', {
        provisioningId: packet.provisioningId, ownershipEpoch: 1, challenge: token(), issuedAt: currentTime,
        expiresAt: currentTime + 300, grants: [{ resourceId: 'space', actions: ['read', 'write'] }],
      });
      assert.equal(route, '/first-root/commit');
      const payload = JSON.parse(Buffer.from(input.accessProof.split('.')[1], 'base64url'));
      savedAck ||= response('binding-ack', { requestId: payload.requestId, requestDigest: firstRootDigest(payload),
        bindingId: 'root-binding', principalId: payload.principalId, clientId: payload.clientId, role: 'manage',
        accessKeyThumbprint: publicKeyThumbprint(payload.accessKey), ownershipEpoch: 1, rosterVersion: 1,
        rosterDigest: token(), policyVersion: 1, committedAt: currentTime, recoveryConfigured: false });
      if (loseResponse) { loseResponse = false; throw new Error('SIMULATED_RESPONSE_LOSS'); }
      return savedAck;
    } }),
  };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-trust-coordinator-'));
  const remote = boxFixture();
  const service = await createDeviceTrustCoordinator({ directory, ...remote });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  await service.createProfile({ passphrase });
  return { directory, remote, service };
}

test('first-root response loss is recoverable after restart without re-claiming or new keys', async t => {
  const { directory, remote, service } = await fixture(t);
  const identity = service.snapshot().profile.clientId;
  const review = await service.prepareFirstRoot({ deliveryPacket: JSON.stringify(remote.packet) });
  assert.equal(JSON.stringify(review).includes(remote.packet.claimSecret), false);
  remote.loseNextResponse();
  await assert.rejects(service.confirmFirstRoot({ reviewHandle: review.reviewHandle, passphrase }), /SIMULATED_RESPONSE_LOSS/);
  assert.equal(service.snapshot().boxes[0].role, 'pending');
  service.close();
  const restored = await createDeviceTrustCoordinator({ directory, ...remote });
  t.after(() => restored.close());
  assert.equal(restored.snapshot().profile.locked, true);
  assert.deepEqual(restored.snapshot().boxes, []);
  await restored.unlock({ passphrase });
  remote.advance(301);
  const result = await restored.refreshRequest({ boxId: remote.descriptor.boxId, requestId: review.requestId });
  assert.equal(result.state, 'approved');
  assert.equal(restored.snapshot().profile.clientId, identity);
  assert.equal(restored.snapshot().boxes[0].role, 'manage');
  assert.equal(remote.calls.filter(route => route === '/first-root/challenge').length, 1);
  assert.equal(remote.calls.filter(route => route === '/first-root/commit').length, 2);
});

test('wrong local passphrase never submits first-root and consumes the review', async t => {
  const { remote, service } = await fixture(t);
  const review = await service.prepareFirstRoot({ deliveryPacket: JSON.stringify(remote.packet) });
  await assert.rejects(service.confirmFirstRoot({ reviewHandle: review.reviewHandle, passphrase: 'wrong but long passphrase' }), /LOCAL_IDENTITY_/);
  await assert.rejects(service.confirmFirstRoot({ reviewHandle: review.reviewHandle, passphrase }), /REVIEW_EXPIRED/);
  assert.deepEqual(remote.calls, ['/first-root/challenge']);
});

test('a saved server receipt cannot lower an already pinned policy version', async t => {
  const { directory, remote, service } = await fixture(t);
  const review = await service.prepareFirstRoot({ deliveryPacket: JSON.stringify(remote.packet) });
  remote.loseNextResponse();
  await assert.rejects(service.confirmFirstRoot({ reviewHandle: review.reviewHandle, passphrase }), /SIMULATED_RESPONSE_LOSS/);
  service.close();
  const vault = createIdentityVault({ directory, clock: remote.clock });
  await vault.load(); await vault.unlock({ passphrase });
  const saved = vault.readState();
  const ack = remote.ackBody();
  saved.boxes[remote.descriptor.boxId].checkpoint = {
    boxId: remote.descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(remote.descriptor.boxKey),
    ownershipEpoch: ack.ownershipEpoch, rosterVersion: ack.rosterVersion, rosterDigest: ack.rosterDigest, policyVersion: 2,
  };
  await vault.writeState(saved); vault.close();
  const restored = await createDeviceTrustCoordinator({ directory, ...remote });
  t.after(() => restored.close());
  await restored.unlock({ passphrase });
  await assert.rejects(restored.refreshRequest({ boxId: remote.descriptor.boxId, requestId: review.requestId }), /CHECKPOINT_CHANGED/);
  assert.equal(restored.snapshot().boxes[0].role, 'pending');
});

test('lock during per-operation KDF prevents late first-root submission', async t => {
  const { remote, service } = await fixture(t);
  const review = await service.prepareFirstRoot({ deliveryPacket: JSON.stringify(remote.packet) });
  const pending = service.confirmFirstRoot({ reviewHandle: review.reviewHandle, passphrase });
  service.lock('lock-screen');
  await assert.rejects(pending, /LOCAL_IDENTITY_|CONTEXT_CHANGED/);
  assert.deepEqual(remote.calls, ['/first-root/challenge']);
  await service.unlock({ passphrase });
  await assert.rejects(service.confirmFirstRoot({ reviewHandle: review.reviewHandle, passphrase }), /REVIEW_EXPIRED/);
});

test('untrusted invitation cannot cause network requests to an unknown box', async t => {
  const { remote, service } = await fixture(t);
  await assert.rejects(service.prepareApproval({ invitation: JSON.stringify({ schemaVersion: 1,
    type: 'centuarai-local-trust-invitation', descriptor: remote.descriptor, requestId: token(), requestDigest: token() }) }), /BOX_UNKNOWN/);
  assert.deepEqual(remote.calls, []);
});

test('corrupt identity is reported without silently creating replacement keys', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'local-trust-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'identity-vault.json'), 'corrupt', { mode: 0o600 });
  const service = await createDeviceTrustCoordinator({ directory });
  assert.ok(service.snapshot().error);
  await assert.rejects(service.createProfile({ passphrase }), /LOCAL_IDENTITY_/);
});

test('system lock, suspend, inactive user and quit lock immediately; resume never unlocks', () => {
  const app = new EventEmitter();
  const powerMonitor = new EventEmitter();
  const calls = [];
  const dispose = registerDeviceTrustLifecycle({ app, powerMonitor, service: { lock: reason => calls.push(reason) } });
  for (const event of ['lock-screen', 'suspend', 'user-did-resign-active', 'resume', 'unlock-screen']) powerMonitor.emit(event);
  app.emit('before-quit');
  assert.deepEqual(calls, ['lock-screen', 'suspend', 'user-did-resign-active', 'before-quit']);
  dispose();
  powerMonitor.emit('suspend');
  assert.equal(calls.at(-1), 'dispose');
});

test('entry works without a cloud account and only from the control main frame', async () => {
  const controlURL = 'file:///test/control.html';
  const panelURL = 'file:///test/panel.html';
  const window = url => ({ isDestroyed: () => false, webContents: { mainFrame: { url } } });
  const control = window(controlURL); const panel = window(panelURL);
  const handlers = new Map(); let opened = 0;
  registerControlActions({ ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, control, controlURL, panel, panelURL,
    openDeviceTrust: () => { opened += 1; return { opened: true }; } });
  const call = handlers.get('wanx-client:device-trust-open');
  const event = surface => ({ sender: surface.webContents, senderFrame: surface.webContents.mainFrame });
  assert.throws(() => call(event(panel)), /无权/);
  assert.throws(() => call({ ...event(control), senderFrame: { url: controlURL } }), /无权/);
  assert.throws(() => call(event(control), { verified: true }), /INVALID_INPUT/);
  assert.deepEqual(await call(event(control)), { opened: true });
  assert.equal(opened, 1);
});
