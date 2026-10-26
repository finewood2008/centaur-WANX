import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { canonicalLedger, ledgerDigest } from '../device-trust/ledger-contract.mjs';
import { signBackupIOProof, verifyBackupIOProof, validateBackupIOProof, signRestoreKeyProof, verifyRestoreKeyProof,
  backupIORequestSpec, restoreKeyRequestSpec, signBackupIOResponse, verifyBackupIOResponse } from '../device-trust/backup-contract.mjs';
const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = key.publicKey.export({ format: 'jwk' });
const id = () => randomBytes(32).toString('base64url');
const sha = bytes => createHash('sha256').update(bytes).digest('base64url');
const now = Math.floor(Date.now() / 1000);
const descriptor = { boxId: 'backup-box', boxKey: pub, baseUrl: 'https://127.0.0.1:8443', tlsSpkiSha256: id() };
const shared = () => ({ schemaVersion: 1, purpose: 'centuarai.local-backup.io', boxId: descriptor.boxId,
  boxKeyThumbprint: publicKeyThumbprint(pub), ownershipEpoch: 2, principalSecurityVersion: 3,
  nonce: id(), issuedAt: now, expiresAt: now + 60, actor: { kind: 'binding', principalId: 'principal', bindingId: 'binding', keyVersion: 1 } });
test('backup access proof has a fixed purpose/actor and never accepts arbitrary signing fields', () => {
  const payload = { ...shared(), operation: 'targets.list', bodySha256: ledgerDigest({}) };
  const proof = signBackupIOProof(payload, key.privateKey);
  assert.deepEqual(verifyBackupIOProof(proof, pub), payload);
  assert.deepEqual(backupIORequestSpec('/backup-io/targets.list', { body: {}, proof }).request, payload);
  for (const mutation of [{ verified: true }, { operation: 'shell.execute' }, { expiresAt: now + 61 },
    { actor: { ...payload.actor, kind: 'recovery' } }, { purpose: 'centuarai.local-ledger.mutation' }])
    assert.throws(() => validateBackupIOProof({ ...payload, ...mutation }));
  assert.throws(() => verifyRestoreKeyProof(proof, pub));
  assert.throws(() => backupIORequestSpec('/backup-io/source.read', { body: { sourceId: 'arbitrary' }, proof }));
});
test('bounded upload binds exact canonical body and canonical standard base64', () => {
  const body = { uploadId: 'upload', offset: 0, chunkBase64: Buffer.alloc(1048576, 127).toString('base64') };
  const payload = { ...shared(), operation: 'source.append', bodySha256: ledgerDigest(body) };
  const proof = signBackupIOProof(payload, key.privateKey);
  assert.ok(backupIORequestSpec('/backup-io/source.append', { body, proof }).encoded.length <= 1420000);
  assert.throws(() => backupIORequestSpec('/backup-io/source.append', { body: { ...body, offset: 1 }, proof }));
  assert.throws(() => backupIORequestSpec('/backup-io/source.append', { body: { ...body, chunkBase64: body.chunkBase64.replace(/=+$/, '') }, proof }));
});
test('range content is authenticated by small receipt and exact request nonce/body hash', () => {
  const content = Buffer.alloc(1048576, 71), body = { operationId: id(), offset: 0, length: content.length };
  const request = { ...shared(), operation: 'archive.read', bodySha256: ledgerDigest(body) };
  const payload = { schemaVersion: 1, purpose: 'centuarai.local-backup.io-response', boxId: descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(pub), operation: request.operation, nonce: request.nonce, requestBodySha256: request.bodySha256, issuedAt: now,
    body: { type: 'backup-archive-range', operationId: body.operationId, backupId: id(), archiveSha256: sha(content),
      offset: 0, length: content.length, totalBytes: content.length, contentSha256: sha(content), eof: true } };
  const receipt = signBackupIOResponse(payload, key.privateKey), outer = { receipt, contentBase64: content.toString('base64') };
  assert.ok(receipt.length < 16384); assert.ok(JSON.stringify(outer).length < 1420000);
  assert.deepEqual(verifyBackupIOResponse(JSON.stringify(outer), { descriptor, request, now }).content, content);
  assert.throws(() => verifyBackupIOResponse(JSON.stringify({ ...outer, contentBase64: Buffer.alloc(content.length, 72).toString('base64') }), { descriptor, request, now }));
  assert.throws(() => verifyBackupIOResponse(JSON.stringify(outer), { descriptor, request: { ...request, nonce: id() }, now }));
  assert.throws(() => verifyBackupIOResponse(JSON.stringify(outer), { descriptor, request, now: now + 61 }));
  assert.throws(() => verifyBackupIOResponse(JSON.stringify(outer).replace('{', '{"receipt":"duplicate",'), { descriptor, request, now }));
});
test('single-archive restore handoff binds one data key without accepting private keys', () => {
  const dataKey = randomBytes(32), payload = { ...shared(), purpose: 'centuarai.local-restore.key',
    operationId: id(), archiveSha256: id(), dataKeySha256: sha(dataKey) };
  const proof = signRestoreKeyProof(payload, key.privateKey);
  assert.deepEqual(verifyRestoreKeyProof(proof, pub), payload);
  const input = { operationId: payload.operationId, archiveSha256: payload.archiveSha256, dataKey: dataKey.toString('base64url'), proof };
  assert.equal(restoreKeyRequestSpec(input).kind, 'restore-key-received');
  assert.throws(() => restoreKeyRequestSpec({ ...input, dataKey: id() }));
  assert.throws(() => restoreKeyRequestSpec({ ...input, privateKey: 'forbidden' }));
  assert.throws(() => verifyBackupIOProof(proof, pub));
  dataKey.fill(0);
});

test('transfer preview authenticates visible fixed scope and cannot hide changed counts behind a digest', () => {
  const scope = { resourceRoots: ['/var/lib/business'], cacheRoots: ['/var/lib/backups'], preservedSecurityRoots: ['/var/lib/authority'],
    affectedPrincipals: 2, affectedBindings: 4, retainedExternalBackups: true };
  const resetPlanDigest = id();
  const body = { type: 'ownership-transfer-plan', resetPlanDigest, scope,
    scopeManifestDigest: ledgerDigest({ purpose: 'centuarai.local-ledger.transfer-scope', resetPlanDigest, scope }),
    dataDisposition: 'erase-local', retainedIndependentBackups: true };
  const request = { ...shared(), operation: 'transfer.plan', bodySha256: ledgerDigest({}) };
  const payload = { schemaVersion: 1, purpose: 'centuarai.local-backup.io-response', boxId: descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(pub), operation: request.operation, nonce: request.nonce,
    requestBodySha256: request.bodySha256, issuedAt: now, body };
  const receipt = signBackupIOResponse(payload, key.privateKey);
  assert.deepEqual(verifyBackupIOResponse(JSON.stringify({ receipt, contentBase64: null }), { descriptor, request, now }).body, body);
  for (const change of [{ affectedPrincipals: 3 }, { resourceRoots: [] }, { resourceRoots: ['/a/../b'] },
    { cacheRoots: ['/b', '/a'] }, { preservedSecurityRoots: ['/a/'] }, { extra: true }])
    assert.throws(() => signBackupIOResponse({ ...payload, body: { ...body, scope: { ...scope, ...change } } }, key.privateKey));
  assert.throws(() => backupIORequestSpec('/backup-io/transfer.plan', { body: { path: '/forged' }, proof: signBackupIOProof(request, key.privateKey) }));
});

test('catalog admits only implemented profile-to-resource mappings and never treats a resource union as an entire-box backup', () => {
  const payload = { schemaVersion: 1, purpose: 'centuarai.local-backup.io-response', boxId: descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(pub), operation: 'targets.list', nonce: id(), requestBodySha256: ledgerDigest({}), issuedAt: now,
    body: { type: 'backup-targets', targets: [{ targetId: 'local-managed', kind: 'local-managed', durability: 'same-box',
      scopeProfiles: ['semantica-private-v1', 'wanx-personal-v1'], resourceIds: ['clipboard', 'semantica', 'space:personal'], maxArchiveBytes: 209715200 }] } };
  assert.doesNotThrow(() => signBackupIOResponse(payload, key.privateKey));
  for (const change of [{ scopeProfiles: ['whole-box'] }, { resourceIds: ['wanx'] }, { resourceIds: ['clipboard', 'semantica', 'space:personal', 'users'] },
    { scopeProfiles: ['wanx-personal-v1', 'semantica-private-v1'] }, { includeIdentityKeys: true }]) {
    const changed = structuredClone(payload); Object.assign(changed.body.targets[0], change);
    assert.throws(() => signBackupIOResponse(changed, key.privateKey));
  }
});
