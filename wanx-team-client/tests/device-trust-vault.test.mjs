import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createIdentityVault } from '../device-trust/identity-vault.mjs';
import { publicKeyThumbprint, requestDigest, verifyApprovalSignature, verifyCancelProof, verifyRequestProof } from '../device-trust/binding-contract.mjs';
import { firstRootDigest } from '../device-trust/management-contract.mjs';

const vector = JSON.parse(await readFile(new URL('../../contracts/local-trust/v1/vectors.json', import.meta.url)));
const passphrase = 'synthetic local passphrase only';
const otherPassphrase = 'different synthetic passphrase';
const code = (suffix) => (error) => error?.code === `LOCAL_IDENTITY_${suffix}`;

async function fixture(t, { create = true, clock } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-identity-test-'));
  const directory = path.join(root, 'identity');
  const options = { directory, ...(clock ? { clock } : {}) };
  // This test fixture creates no real identity. Windows ACL behavior belongs to
  // the shell's existing adapter; do not silently substitute a no-op adapter.
  if (process.platform === 'win32') {
    const { protectPrivateDirectory } = await import('../shell/private-storage.mjs');
    options.protectDirectory = (target) => protectPrivateDirectory(target);
  }
  const vault = createIdentityVault(options);
  t.after(async () => { vault.close(); await rm(root, { recursive: true, force: true }); });
  await vault.load();
  const profile = create ? await vault.createProfile({ passphrase }) : null;
  return { vault, profile, root, directory, file: path.join(directory, 'identity-vault.json'), options };
}

function binding(profile) {
  return { ...structuredClone(vector.request), clientId: profile.clientId, accessKey: profile.accessKey };
}

function verifyJws(jws, publicKey) {
  const [header, payload, signature] = jws.split('.');
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`),
    { key: createPublicKey({ key: publicKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

test('fresh vault creates only independent public metadata, purpose-separated encrypted slots and authenticated state', async (t) => {
  const f = await fixture(t, { create: false });
  assert.deepEqual(f.vault.snapshot(), { loaded: true, exists: false, locked: true, generation: 0, profile: null });
  const profile = await f.vault.createProfile({ passphrase });
  assert.notEqual(profile.principalId, profile.clientId);
  assert.notDeepEqual(profile.accessKey, profile.approvalKey);
  assert.equal(profile.keyProtection, 'software-passphrase-v1');
  assert.equal(f.vault.snapshot().locked, false);
  const raw = await readFile(f.file, 'utf8');
  const envelope = JSON.parse(raw);
  assert.equal(raw.includes(passphrase), false);
  assert.equal(raw.includes('PRIVATE KEY'), false);
  assert.equal(raw.includes('privateKey'), false);
  assert.notEqual(envelope.accessSlot.salt, envelope.approvalSlot.salt);
  assert.notEqual(envelope.accessSlot.nonce, envelope.approvalSlot.nonce);
  assert.equal(envelope.accessSlot.kdf, 'scrypt-131072-8-1');
  assert.deepEqual(f.vault.readState(), { schemaVersion: 1, boxes: {} });
  assert.deepEqual(Object.keys(f.vault).sort(), ['close', 'createProfile', 'load', 'lock', 'readState', 'signApproval',
    'signBinding', 'signCancel', 'signDataSession', 'signDataSessionIntent', 'signFirstRoot', 'signRead', 'signLedgerPrepare', 'signLedgerRead', 'signLedgerAuthChallenge', 'signLedgerAuthMutationChallenge', 'signBackupIO', 'signRestoreKey', 'signTeamRequest', 'signTeamRequestRead',
    'signLedgerMutation', 'signLedgerTarget', 'snapshot', 'subscribe', 'unlock', 'writeState'].sort());
  if (process.platform !== 'win32') {
    assert.equal((await lstat(f.directory)).mode & 0o077, 0);
    assert.equal((await lstat(f.file)).mode & 0o077, 0);
  }
  const snapshot = f.vault.snapshot();
  snapshot.profile.clientId = 'modified';
  assert.equal(f.vault.snapshot().profile.clientId, profile.clientId);
});

test('Access cache expires actively without a getter and one failing observer cannot prevent synchronous lock notifications', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t), events = [];
  f.vault.subscribe(() => { throw new Error('observer failure'); });
  f.vault.subscribe(event => { events.push(event); assert.equal(f.vault.snapshot().locked, event.type === 'locked'); });
  await f.vault.writeState({ schemaVersion: 1, boxes: {} });
  assert.equal(events.at(-1).type, 'state-changed');
  t.mock.timers.tick(15 * 60 * 1000);
  assert.equal(events.at(-1).type, 'locked'); assert.equal(events.at(-1).reason, 'expired');
  assert.throws(() => f.vault.signBinding(binding(f.profile)), code('LOCKED'));
});

test('finite ledger signers bind joined-principal association, re-unlock Approval per mutation and prove only their own target keys', async t => {
  const f = await fixture(t), id = Buffer.alloc(32, 7).toString('base64url'), now = vector.now;
  const descriptor = { boxId: 'ledger-box', boxKey: vector.request.accessKey, tlsSpkiSha256: id, baseUrl: 'https://127.0.0.1:9443' };
  await f.vault.writeState({ schemaVersion: 1, boxes: { 'ledger-box': { descriptor, principalId: 'joined-principal', bindingId: 'my-binding' } } });
  const prepare = { schemaVersion: 2, purpose: 'centuarai.local-ledger.prepare', boxId: 'ledger-box',
    boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch: 1, rosterVersion: 1, rosterDigest: id, policyVersion: 1,
    requestId: id, challenge: id, issuedAt: now, expiresAt: now + 60,
    actor: { kind: 'binding', principalId: 'joined-principal', bindingId: 'my-binding', keyVersion: 1 },
    action: 'device.revoke', args: { bindingId: 'other-binding', mode: 'normal' } };
  assert.deepEqual(verifyJws(f.vault.signLedgerPrepare(prepare), f.profile.accessKey), prepare);
  assert.throws(() => f.vault.signLedgerPrepare({ ...prepare, actor: { ...prepare.actor, principalId: f.profile.principalId } }), code('IDENTITY_MISMATCH'));
  const mutation = { ...prepare, purpose: 'centuarai.local-ledger.mutation', effectsDigest: id };
  await assert.rejects(f.vault.signLedgerMutation({ payload: mutation, passphrase: otherPassphrase }), code('UNLOCK_FAILED'));
  const proof = await f.vault.signLedgerMutation({ payload: mutation, passphrase });
  assert.deepEqual(verifyJws(proof, f.profile.approvalKey), mutation);
  const target = { clientId: f.profile.clientId, accessKey: f.profile.accessKey, approvalKey: f.profile.approvalKey,
    keyProtection: f.profile.keyProtection, capabilities: ['device.approve_use'], grants: [{ resourceId: 'wanx', actions: ['read'] }],
    delegableGrants: [], expiresAt: null, delegationExpiresAt: null };
  const adding = { ...mutation, action: 'device.add-manager', args: { target } };
  const both = await f.vault.signLedgerTarget({ payload: adding, passphrase });
  assert.deepEqual(verifyJws(both.targetAccessProof, f.profile.accessKey), adding);
  assert.deepEqual(verifyJws(both.targetApprovalProof, f.profile.approvalKey), adding);
  assert.throws(() => f.vault.signLedgerTarget({ payload: { ...adding, args: { target: { ...target, clientId: 'not-this-client' } } }, passphrase }), code('IDENTITY_MISMATCH'));
});

test('ledger auth challenge proves only the encrypted saved actor and epoch with its fixed Access purpose', async t => {
  const f = await fixture(t), id = Buffer.alloc(32, 7).toString('base64url'), now = vector.now;
  const descriptor = { boxId: 'challenge-box', boxKey: vector.request.accessKey, tlsSpkiSha256: id, baseUrl: 'https://127.0.0.1:9443' };
  const association = { descriptor, principalId: 'joined-principal', bindingId: 'saved-binding', checkpoint: { ownershipEpoch: 2 } };
  await f.vault.writeState({ schemaVersion: 1, boxes: { [descriptor.boxId]: association } });
  const payload = { schemaVersion: 2, purpose: 'centuarai.local-ledger.auth-challenge', boxId: descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch: 2, clientNonce: id,
    issuedAt: now, expiresAt: now + 60, actor: { kind: 'binding', principalId: 'joined-principal',
      bindingId: 'saved-binding', keyVersion: 1 } };
  const proof = f.vault.signLedgerAuthChallenge(payload);
  assert.deepEqual(verifyJws(proof, f.profile.accessKey), payload);
  assert.deepEqual(JSON.parse(Buffer.from(proof.split('.')[0], 'base64url')), {
    alg: 'ES256', typ: 'centuarai-local-ledger.auth-challenge+jws',
  });
  const mutation = { ...payload, purpose: 'centuarai.local-ledger.auth-mutation-challenge', action: 'device.revoke' };
  const mutationProof = f.vault.signLedgerAuthMutationChallenge(mutation);
  assert.deepEqual(verifyJws(mutationProof, f.profile.accessKey), mutation);
  assert.deepEqual(JSON.parse(Buffer.from(mutationProof.split('.')[0], 'base64url')), {
    alg: 'ES256', typ: 'centuarai-local-ledger.auth-mutation-challenge+jws',
  });
  for (const change of [{ ownershipEpoch: 1 }, { ownershipEpoch: 3 }, { boxId: 'unknown-box' },
    { boxKeyThumbprint: Buffer.alloc(32, 8).toString('base64url') },
    { actor: { ...payload.actor, principalId: f.profile.principalId } },
    { actor: { ...payload.actor, bindingId: 'another-binding' } }]) {
    assert.throws(() => f.vault.signLedgerAuthChallenge({ ...payload, ...change }), code('IDENTITY_MISMATCH'));
    assert.throws(() => f.vault.signLedgerAuthMutationChallenge({ ...mutation, ...change }), code('IDENTITY_MISMATCH'));
  }
  for (const change of [{ action: 'unknown' }, { action: 'recovery.recover' }, { expiresAt: now + 61 },
    { purpose: payload.purpose }, { clientNonce: 'short' }, { requestId: id }]) {
    assert.throws(() => f.vault.signLedgerAuthMutationChallenge({ ...mutation, ...change }));
  }
  for (const change of [{ purpose: 'centuarai.local-ledger.prepare' }, { expiresAt: now + 61 },
    { clientNonce: 'short' }, { operation: 'principal-state' },
    { actor: { kind: 'recovery', recoveryId: 'not-a-binding', keyVersion: 1 } }]) {
    assert.throws(() => f.vault.signLedgerAuthChallenge({ ...payload, ...change }));
  }
  const withoutCheckpoint = { ...association }; delete withoutCheckpoint.checkpoint;
  await f.vault.writeState({ schemaVersion: 1, boxes: { [descriptor.boxId]: withoutCheckpoint } });
  assert.throws(() => f.vault.signLedgerAuthChallenge(payload), code('IDENTITY_MISMATCH'));
  assert.throws(() => f.vault.signLedgerAuthMutationChallenge(mutation), code('IDENTITY_MISMATCH'));
  f.vault.lock();
  assert.throws(() => f.vault.signLedgerAuthChallenge(payload), code('LOCKED'));
  assert.throws(() => f.vault.signLedgerAuthMutationChallenge(mutation), code('LOCKED'));
});

test('historical transfer status keeps the original encrypted actor and box pin without restoring current authority', async t => {
  const f = await fixture(t), id = Buffer.alloc(32, 7).toString('base64url'), now = vector.now;
  const descriptor = { boxId: 'transfer-box', boxKey: vector.request.accessKey, tlsSpkiSha256: id, baseUrl: 'https://127.0.0.1:9443' };
  await f.vault.writeState({ schemaVersion: 1, boxes: { 'transfer-box': { descriptor, principalId: 'original-principal',
    bindingId: 'original-binding', checkpoint: { ownershipEpoch: 2 } } } });
  const payload = { schemaVersion: 2, purpose: 'centuarai.local-ledger.read', boxId: descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch: 3, nonce: id,
    issuedAt: now, expiresAt: now + 60, actor: { kind: 'binding', principalId: 'original-principal',
      bindingId: 'original-binding', keyVersion: 1 }, operation: 'transfer-status', requestId: id, bindingId: null };
  assert.deepEqual(verifyJws(f.vault.signLedgerRead(payload), f.profile.accessKey), payload);
  for (const change of [{ ownershipEpoch: 1 }, { boxKeyThumbprint: Buffer.alloc(32, 8).toString('base64url') },
    { actor: { ...payload.actor, principalId: 'new-owner' } }, { actor: { ...payload.actor, bindingId: 'new-device' } },
    { operation: 'principal-state', requestId: null }]) {
    assert.throws(() => f.vault.signLedgerRead({ ...payload, ...change }), code('IDENTITY_MISMATCH'));
  }
  f.vault.lock();
  assert.throws(() => f.vault.signLedgerRead(payload), code('LOCKED'));
});

test('backup IO and restore-key proofs are finite Access purposes pinned to the encrypted current box association', async t => {
  const f = await fixture(t), id = Buffer.alloc(32, 7).toString('base64url'), now = vector.now;
  const descriptor = { boxId: 'backup-box', boxKey: vector.request.accessKey, tlsSpkiSha256: id, baseUrl: 'https://127.0.0.1:9443' };
  await f.vault.writeState({ schemaVersion: 1, boxes: { 'backup-box': { descriptor, principalId: 'joined-principal', bindingId: 'my-binding', checkpoint: { ownershipEpoch: 2 } } } });
  const shared = { schemaVersion: 1, boxId: 'backup-box', boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey),
    ownershipEpoch: 2, principalSecurityVersion: 1, nonce: id, issuedAt: now, expiresAt: now + 60,
    actor: { kind: 'binding', principalId: 'joined-principal', bindingId: 'my-binding', keyVersion: 1 } };
  const io = { ...shared, purpose: 'centuarai.local-backup.io', operation: 'targets.list', bodySha256: id };
  assert.deepEqual(verifyJws(f.vault.signBackupIO(io), f.profile.accessKey), io);
  const restore = { ...shared, purpose: 'centuarai.local-restore.key', operationId: id, archiveSha256: id, dataKeySha256: id };
  assert.deepEqual(verifyJws(f.vault.signRestoreKey(restore), f.profile.accessKey), restore);
  for (const change of [{ ownershipEpoch: 1 }, { boxKeyThumbprint: Buffer.alloc(32, 8).toString('base64url') },
    { actor: { ...shared.actor, principalId: f.profile.principalId } }, { actor: { ...shared.actor, bindingId: 'another-device' } }]) {
    assert.throws(() => f.vault.signBackupIO({ ...io, ...change }), code('IDENTITY_MISMATCH'));
    assert.throws(() => f.vault.signRestoreKey({ ...restore, ...change }), code('IDENTITY_MISMATCH'));
  }
  assert.throws(() => f.vault.signBackupIO({ ...io, operation: 'backup.create' }));
  assert.throws(() => f.vault.signRestoreKey({ ...restore, expiresAt: now + 61 }));
  f.vault.lock(); assert.throws(() => f.vault.signBackupIO(io), code('LOCKED'));
  assert.throws(() => f.vault.signRestoreKey(restore), code('LOCKED'));
});

test('reopen remains locked and wrong local/cloud password does not unlock or replace an identity', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  f.vault.close();
  const reopened = createIdentityVault(f.options);
  t.after(() => reopened.close());
  await reopened.load();
  assert.equal(reopened.snapshot().locked, true);
  assert.throws(() => reopened.readState(), code('LOCKED'));
  await assert.rejects(reopened.unlock({ passphrase: otherPassphrase }), code('UNLOCK_FAILED'));
  assert.equal(reopened.snapshot().locked, true);
  await assert.rejects(reopened.createProfile({ passphrase }), code('EXISTS'));
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await reopened.unlock({ passphrase }), f.profile);
  assert.equal(reopened.snapshot().locked, false);
});

test('state writes serialize, copy inputs/outputs, survive reopen and authenticate checkpoint ciphertext', async (t) => {
  const f = await fixture(t);
  const initial = { schemaVersion: 1, boxes: { box: { checkpoint: { version: 1 }, note: '本地名称' } } };
  const first = f.vault.writeState(initial);
  initial.boxes.box.checkpoint.version = 99;
  await first;
  assert.equal(f.vault.readState().boxes.box.checkpoint.version, 1);
  const changed = f.vault.readState();
  changed.boxes.box.checkpoint.version = 20;
  assert.equal(f.vault.readState().boxes.box.checkpoint.version, 1);
  await Promise.all([f.vault.writeState({ value: 2 }), f.vault.writeState({ value: 3 })]);
  assert.deepEqual(f.vault.readState(), { value: 3 });
  f.vault.lock();
  await f.vault.unlock({ passphrase });
  assert.deepEqual(f.vault.readState(), { value: 3 });
  const stored = JSON.parse(await readFile(f.file, 'utf8'));
  stored.state.tag = Buffer.alloc(16).toString('base64url');
  await writeFile(f.file, JSON.stringify(stored));
  await assert.rejects(f.vault.unlock({ passphrase }), code('UNLOCK_FAILED'));
  assert.equal(f.vault.snapshot().locked, true);
});

test('state rejects prototype objects, unbounded values and external replacement without overwriting', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.vault.writeState(Object.create({ trusted: true })), code('INVALID'));
  assert.throws(() => f.vault.writeState({ unknown: undefined }), code('INVALID'));
  assert.throws(() => f.vault.writeState({ huge: 'x'.repeat(256 * 1024) }), code('STATE_TOO_LARGE'));
  const raw = await readFile(f.file, 'utf8');
  await writeFile(f.file, `${raw}\n`);
  await assert.rejects(f.vault.writeState({ checkpoint: 1 }), code('STATE_CONFLICT'));
  assert.equal(await readFile(f.file, 'utf8'), `${raw}\n`);
});

test('lock invalidates pending state writes and in-flight unlock; no delayed result revives cache', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  const writing = f.vault.writeState({ checkpoint: 100 });
  f.vault.lock('screen-lock');
  await assert.rejects(writing, code('CANCELLED'));
  assert.deepEqual(await readFile(f.file), before);
  const unlocking = f.vault.unlock({ passphrase });
  await new Promise(setImmediate);
  f.vault.lock('suspend');
  await assert.rejects(unlocking, code('CANCELLED'));
  assert.equal(f.vault.snapshot().locked, true);
  assert.throws(() => f.vault.signBinding(binding(f.profile)), code('LOCKED'));
});

test('cached AccessKey signs only fixed protocols and local client, with independent principal selection for joining', async (t) => {
  const f = await fixture(t);
  const request = binding(f.profile);
  assert.notEqual(request.principalId, f.profile.principalId);
  const proof = f.vault.signBinding(request);
  assert.deepEqual(verifyRequestProof(proof), request);
  assert.throws(() => f.vault.signBinding({ ...request, clientId: 'other' }), code('IDENTITY_MISMATCH'));
  const cancel = { ...vector.cancel, requestDigest: requestDigest(request) };
  assert.deepEqual(verifyCancelProof(f.vault.signCancel(cancel), request, vector.now), cancel);
  const read = { schemaVersion: 1, purpose: 'centuarai.local-management.read',
    boxId: request.boxId, boxKeyThumbprint: request.boxKeyThumbprint, ownershipEpoch: request.ownershipEpoch,
    nonce: request.challenge, issuedAt: vector.now, expiresAt: vector.now + 30,
    clientId: f.profile.clientId, operation: 'state', requestId: null };
  assert.deepEqual(verifyJws(f.vault.signRead(read), f.profile.accessKey), read);
  assert.throws(() => f.vault.signRead({ ...read, purpose: 'arbitrary' }));
  assert.throws(() => f.vault.signRead({ ...read, clientId: 'other' }), code('IDENTITY_MISMATCH'));
});

test('ApprovalKey requires the local passphrase for every call even after access unlock', async (t) => {
  const f = await fixture(t);
  const approval = structuredClone(vector.approval);
  await assert.rejects(f.vault.signApproval({ payload: approval, passphrase: otherPassphrase }), code('UNLOCK_FAILED'));
  const first = await f.vault.signApproval({ payload: approval, passphrase });
  const trustedState = structuredClone(vector.trustedState);
  trustedState.bindings[0].accessKey = f.profile.accessKey;
  trustedState.bindings[0].approvalKey = f.profile.approvalKey;
  assert.deepEqual(verifyApprovalSignature(first, vector.proofs.request, trustedState, vector.now), approval);
  await assert.rejects(f.vault.signApproval({ payload: approval, passphrase: otherPassphrase }), code('UNLOCK_FAILED'));
  assert.equal(f.vault.snapshot().locked, false);
  const stored = JSON.parse(await readFile(f.file, 'utf8'));
  [stored.accessSlot, stored.approvalSlot] = [stored.approvalSlot, stored.accessSlot];
  await writeFile(f.file, JSON.stringify(stored));
  await assert.rejects(f.vault.unlock({ passphrase }), code('UNLOCK_FAILED'));
});

test('approval guard and lock fences run after slow KDF, before signing and before result delivery', async (t) => {
  const f = await fixture(t);
  const interrupted = f.vault.signApproval({ payload: vector.approval, passphrase });
  await new Promise(setImmediate);
  f.vault.lock('user-switch');
  await assert.rejects(interrupted, code('CANCELLED'));
  await f.vault.unlock({ passphrase });
  let calls = 0;
  await assert.rejects(f.vault.signApproval({ payload: vector.approval, passphrase, guard() {
    calls += 1;
    if (calls === 3) throw new Error('REVIEW_CHANGED');
  } }), /REVIEW_CHANGED/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(f.vault.signApproval({ payload: vector.approval, passphrase, guard() {
    calls += 1;
    if (calls === 5) f.vault.lock();
  } }), code('CANCELLED'));
  assert.equal(calls, 5);
  assert.equal(f.vault.snapshot().locked, true);
});

test('first-root signs one immutable payload with separate access, approval and claim-secret proofs', async (t) => {
  const f = await fixture(t);
  const request = vector.request;
  const payload = { schemaVersion: 1, purpose: 'centuarai.local-management.first-root',
    boxId: request.boxId, boxKeyThumbprint: request.boxKeyThumbprint, provisioningId: request.requestId,
    ownershipEpoch: request.ownershipEpoch, challenge: request.challenge, requestId: request.requestId,
    issuedAt: request.issuedAt, expiresAt: request.expiresAt, principalId: f.profile.principalId,
    clientId: f.profile.clientId, accessKey: f.profile.accessKey, approvalKey: f.profile.approvalKey,
    grants: request.grants, grantExpiresAt: null, keyProtection: 'software-passphrase-v1' };
  const expected = structuredClone(payload);
  const claimSecret = Buffer.alloc(32, 42).toString('base64url');
  const pending = f.vault.signFirstRoot({ payload, claimSecret, passphrase });
  payload.boxId = 'changed-while-unlocking';
  const proofs = await pending;
  assert.deepEqual(Object.keys(proofs).sort(), ['accessProof', 'approvalProof', 'secretProof']);
  assert.deepEqual(verifyJws(proofs.accessProof, f.profile.accessKey), expected);
  assert.deepEqual(verifyJws(proofs.approvalProof, f.profile.approvalKey), expected);
  const parts = proofs.secretProof.split('.');
  const key = createHash('sha256').update(Buffer.from(claimSecret, 'base64url')).digest();
  assert.equal(createHmac('sha256', key).update(`${parts[0]}.${parts[1]}`).digest('base64url'), parts[2]);
  assert.equal(firstRootDigest(expected), firstRootDigest(JSON.parse(Buffer.from(parts[1], 'base64url'))));
  await assert.rejects(f.vault.signFirstRoot({ payload: { ...expected, clientId: 'other' }, claimSecret, passphrase }), code('IDENTITY_MISMATCH'));
});

test('cache has bounded lifetime; clock rollback locks instead of extending it', async (t) => {
  let now = 1000000;
  const f = await fixture(t, { clock: () => now });
  now += 15 * 60 * 1000;
  assert.equal(f.vault.snapshot().locked, true);
  await f.vault.unlock({ passphrase });
  now -= 1;
  assert.equal(f.vault.snapshot().locked, true);
});

test('missing, corrupt and unsupported vault files never silently regenerate an identity', async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  await unlink(f.file);
  await assert.rejects(f.vault.unlock({ passphrase }), code('MISSING'));
  await assert.rejects(f.vault.createProfile({ passphrase }), code('EXISTS'));
  await writeFile(f.file, 'corrupt', { mode: 0o600 });
  const broken = createIdentityVault(f.options);
  t.after(() => broken.close());
  await assert.rejects(broken.load(), code('CORRUPT'));
  await assert.rejects(broken.createProfile({ passphrase }), code('CORRUPT'));
  assert.equal(await readFile(f.file, 'utf8'), 'corrupt');
  const envelope = JSON.parse(before);
  envelope.accessSlot.kdf = 'scrypt-attacker-cost';
  await writeFile(f.file, JSON.stringify(envelope));
  await assert.rejects(broken.load(), code('CORRUPT'));
});

test('POSIX rejects symlinks and nonprivate files/directories without revealing paths', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  await chmod(f.file, 0o644);
  await assert.rejects(f.vault.unlock({ passphrase }), code('CORRUPT'));
  await chmod(f.file, 0o600);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.vault.unlock({ passphrase }), (error) => {
    assert.equal(error.code, 'LOCAL_IDENTITY_STORAGE_UNAVAILABLE');
    assert.equal(error.message.includes(f.directory), false);
    return true;
  });
  await chmod(f.directory, 0o700);
  const another = path.join(f.root, 'other.json');
  await writeFile(another, await readFile(f.file), { mode: 0o600 });
  await unlink(f.file);
  await symlink(another, f.file);
  await assert.rejects(f.vault.unlock({ passphrase }), code('STORAGE_UNAVAILABLE'));
});

test('two creates do not overwrite the first durable identity and leave no plaintext or temporary files', async (t) => {
  const f = await fixture(t, { create: false });
  const results = await Promise.allSettled([
    f.vault.createProfile({ passphrase }), f.vault.createProfile({ passphrase: otherPassphrase }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && code('EXISTS')(result.reason)).length, 1);
  assert.deepEqual(await readdir(f.directory), ['identity-vault.json']);
  assert.equal(f.vault.snapshot().profile.profileId, results.find((result) => result.status === 'fulfilled').value.profileId);
});

test('lock during initial KDF leaves no durable identity and close permanently disables key use', async (t) => {
  const f = await fixture(t, { create: false });
  const creating = f.vault.createProfile({ passphrase });
  await new Promise(setImmediate);
  f.vault.lock('window-closed');
  await assert.rejects(creating, code('CANCELLED'));
  await assert.rejects(readFile(f.file), (error) => error.code === 'ENOENT');
  assert.equal(f.vault.snapshot().exists, false);
  f.vault.close();
  await assert.rejects(f.vault.load(), code('CANCELLED'));
  assert.throws(() => f.vault.readState(), code('LOCKED'));
});
