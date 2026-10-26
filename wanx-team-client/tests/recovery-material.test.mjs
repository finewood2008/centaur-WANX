import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { constants, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { createRecoveryFiles } from '../shell/recovery-files.mjs';
import { createRecoveryMaterialManager } from '../device-trust/recovery-material.mjs';
import { ledgerDigest } from '../device-trust/ledger-contract.mjs';
import { backupRecipientThumbprint } from '../device-trust/backup-contract.mjs';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { keyPair, randomId, emptyEffect, ledgerFixture } from './ledger-test-fixture.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'recovery-material-')));
  let selected = path.join(directory, 'offline.json');
  const files = createRecoveryFiles({ dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: selected }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }),
  } });
  const manager = createRecoveryMaterialManager({ files });
  const access = keyPair(), approval = keyPair();
  const remote = ledgerFixture({ principalId: 'principal-one', clientId: 'client-one',
    accessKey: access.publicKey.export({ format: 'jwk' }), approvalKey: approval.publicKey.export({ format: 'jwk' }) });
  t.after(async () => { manager.invalidate(); files.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, files, manager, remote, choose: value => { selected = value; } };
}
const guard = () => {};

test('native material export then actual file reimport is necessary for the complete mutation proof', async t => {
  const { manager, remote, directory } = await fixture(t);
  const draft = await manager.generate({ descriptor: remote.descriptor, principalId: 'principal-one', version: 1 }, guard);
  assert.equal(draft.state, 'draft_generated');
  assert.doesNotMatch(JSON.stringify(draft), /PrivateKey|privateKey|PKCS8/);
  const mutation = { schemaVersion: 2, purpose: 'centuarai.local-ledger.mutation', ...remote.context,
    requestId: randomId(), challenge: randomId(), issuedAt: remote.now, expiresAt: remote.now + 300,
    actor: { kind: 'binding', principalId: 'principal-one', bindingId: 'root-binding', keyVersion: 1 },
    action: 'recovery.setup', args: { expectedRecoveryVersion: 0, newRecovery: draft.newRecovery }, effectsDigest: ledgerDigest(emptyEffect()) };
  assert.throws(() => manager.signMaterial(draft.materialHandle, mutation), /REIMPORT_REQUIRED/);
  const exported = await manager.export(draft.materialHandle, guard);
  assert.equal(exported.state, 'exported');
  assert.throws(() => manager.export(draft.materialHandle, guard), /REIMPORT_REQUIRED/);
  const packet = JSON.parse(await readFile(path.join(directory, 'offline.json'), 'utf8'));
  assert.ok(packet.recoverySigningPrivateKey && packet.backupDecryptPrivateKey);
  assert.throws(() => manager.signMaterial(draft.materialHandle, mutation), /REIMPORT_REQUIRED/);
  const imported = await manager.reimport(draft.materialHandle, guard);
  assert.equal(imported.state, 'reimport_verified');
  assert.equal(manager.signMaterial(draft.materialHandle, mutation).split('.').length, 3);
  assert.throws(() => manager.signMaterial(draft.materialHandle, { ...mutation, args: {
    ...mutation.args, newRecovery: { ...draft.newRecovery, recoveryId: randomId() },
  } }), /SCOPE_MISMATCH/);
  manager.invalidate();
  assert.throws(() => manager.publicDraft(draft.materialHandle), /MATERIAL_EXPIRED/);
});

test('reimport refuses a different saved recovery generation without replacing valid draft', async t => {
  const { manager, remote, directory, choose } = await fixture(t);
  const one = await manager.generate({ descriptor: remote.descriptor, principalId: 'principal-one', version: 1 }, guard);
  await manager.export(one.materialHandle, guard);
  const two = await manager.generate({ descriptor: remote.descriptor, principalId: 'principal-one', version: 1 }, guard);
  choose(path.join(directory, 'another.json'));
  await manager.export(two.materialHandle, guard);
  await assert.rejects(manager.reimport(one.materialHandle, guard), /SCOPE_MISMATCH/);
  assert.equal(manager.publicDraft(one.materialHandle).state, 'exported');
  choose(path.join(directory, 'offline.json'));
  assert.equal((await manager.reimport(one.materialHandle, guard)).state, 'reimport_verified');
});

test('malformed private material, algorithm substitution and file replacement never establish recovery', async t => {
  const { manager, remote, directory } = await fixture(t);
  const draft = await manager.generate({ descriptor: remote.descriptor, principalId: 'principal-one', version: 1 }, guard);
  await manager.export(draft.materialHandle, guard);
  const filename = path.join(directory, 'offline.json');
  const original = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(filename, JSON.stringify({ ...original, backupDecryptPrivateKey: original.recoverySigningPrivateKey }));
  await assert.rejects(manager.reimport(draft.materialHandle, guard), /MATERIAL_INVALID/);
  await writeFile(filename, JSON.stringify({ ...original, principalId: 'another-principal' }));
  await assert.rejects(manager.reimport(draft.materialHandle, guard), /SCOPE_MISMATCH/);
  await writeFile(filename, JSON.stringify(original));
  const current = await manager.importCurrent(guard);
  assert.equal(current.principalId, 'principal-one');
  assert.doesNotMatch(JSON.stringify(current), /PrivateKey|privateKey/);
});

test('historical material unwraps only the pinned archive key with exact RSA-OAEP label', async t => {
  const { manager, remote } = await fixture(t);
  const draft = await manager.generate({ descriptor: remote.descriptor, principalId: 'principal-one', version: 1 }, guard);
  await manager.export(draft.materialHandle, guard);
  const imported = await manager.importCurrent(guard), key = randomBytes(32), backupId = randomId();
  const recipientKeyThumbprint = backupRecipientThumbprint(draft.newRecovery.backupKey);
  const wrappedDataKey = publicEncrypt({ key: createPublicKey({ key: draft.newRecovery.backupKey, format: 'jwk' }),
    padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
    oaepLabel: Buffer.from(`centuarai.backup.key.v1\n${backupId}\n${recipientKeyThumbprint}`) }, key).toString('base64url');
  const header = { schemaVersion: 1, format: 'centuarai-business-backup-v1', backupId, sourceBoxId: remote.descriptor.boxId,
    sourceBoxKeyThumbprint: publicKeyThumbprint(remote.descriptor.boxKey), sourceOwnershipEpoch: 1, principalId: 'principal-one',
    principalSecurityVersion: 1, recoveryId: draft.newRecovery.recoveryId, recoveryVersion: 1,
    sourceRecoverySigningKey: draft.newRecovery.signingKey, recipientKeyThumbprint, createdAt: remote.now,
    scopeProfile: 'semantica-private-v1', scopeDigest: randomId(), wrapAlgorithm: 'RSA-OAEP-256', wrappedDataKey,
    cipher: 'A256GCM', noncePrefix: randomBytes(4).toString('base64url'), chunkSize: 1048576, chunkCount: 1,
    plaintextBytes: 10, manifestBytes: 10, manifestSha256: randomId() };
  const actual = manager.unwrapArchiveKey(imported.recoveryHandle, header);
  assert.deepEqual(actual, key); actual.fill(0); key.fill(0);
  assert.throws(() => manager.unwrapArchiveKey(imported.recoveryHandle, { ...header, backupId: randomId() }), /MATERIAL_INVALID/);
  assert.throws(() => manager.unwrapArchiveKey(imported.recoveryHandle, { ...header, principalId: 'other' }), /SCOPE_MISMATCH/);
  manager.invalidate(); assert.throws(() => manager.unwrapArchiveKey(imported.recoveryHandle, header), /MATERIAL_EXPIRED/);
});
