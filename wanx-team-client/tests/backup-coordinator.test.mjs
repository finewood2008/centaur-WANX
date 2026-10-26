import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createBackupCoordinator } from '../device-trust/backup-coordinator.mjs';
import { createBackupFiles } from '../shell/backup-files.mjs';
import { signBackupIOProof, verifyBackupIOProof, signBackupIOResponse } from '../device-trust/backup-contract.mjs';
import { canonicalLedger, ledgerDigest, mutationDigest } from '../device-trust/ledger-contract.mjs';
import { publicKeyThumbprint } from '../device-trust/binding-contract.mjs';
import { keyPair, randomId } from './ledger-test-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('base64url');
async function fixture(t, { ensureBackupNamespace } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'backup-coordinator-'))), file = path.join(root, 'archive.cxb');
  const backupFiles = createBackupFiles({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: file }) } });
  const signing = keyPair(), access = keyPair(), now = Math.floor(Date.now() / 1000);
  const descriptor = { boxId: 'box', boxKey: signing.publicKey.export({ format: 'jwk' }), baseUrl: 'https://127.0.0.1:8443', tlsSpkiSha256: randomId() };
  const context = { boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch: 1,
    rosterVersion: 2, rosterDigest: randomId(), policyVersion: 1 };
  const actor = { kind: 'binding', principalId: 'principal', bindingId: 'binding', keyVersion: 1 };
  const ciphertext = Buffer.alloc(1048576 + 17, 67), requestId = randomId(), backupId = randomId();
  const mutation = { schemaVersion: 2, purpose: 'centuarai.local-ledger.mutation', ...context, requestId,
    challenge: randomId(), issuedAt: now, expiresAt: now + 300, actor, action: 'backup.create', effectsDigest: randomId(),
    args: { scopeProfile: 'semantica-private-v1', resourceIds: ['semantica'], expectedRecoveryVersion: 1,
      recipientKeyThumbprint: randomId(), targetId: 'local-managed', includeBusinessSecrets: false } };
  const item = { descriptor, principalId: actor.principalId, bindingId: actor.bindingId, checkpoint: context,
    mutations: { [requestId]: { ack: 'saved-authority-ack', mutation } } };
  const recovery = { status: 'active', version: 1, backupKey: generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey.export({ format: 'jwk' }) };
  const status = { operationId: requestId, requestId, action: 'backup.create', mutationDigest: mutationDigest(mutation),
    attempt: 1, stateVersion: 2, state: 'completed', phase: 'complete', errorCode: null, recoveryRequired: false,
    result: { type: 'backup-created', operationId: requestId, backupId, archiveSha256: sha(ciphertext), bytes: ciphertext.length }, updatedAt: now };
  const state = { file, ciphertext, status, corrupt: false, revoked: false, failRange: false, prepareCalls: [], catalogProfiles: ['semantica-private-v1'] };
  const scope = { resourceRoots: ['/var/lib/business'], cacheRoots: ['/var/lib/backup'], preservedSecurityRoots: ['/var/lib/authority'], affectedPrincipals: 2, affectedBindings: 3, retainedExternalBackups: true };
  const resetPlanDigest = randomId();
  state.transferPlan = { type: 'ownership-transfer-plan', resetPlanDigest, scope, scopeManifestDigest: ledgerDigest({ purpose: 'centuarai.local-ledger.transfer-scope', resetPlanDigest, scope }), dataDisposition: 'erase-local', retainedIndependentBackups: true };
  const reviews = new Map();
  const service = createBackupCoordinator({ ensureBackupNamespace, requireProfile: () => ({ profileId: 'fixture-profile' }), vault: { signBackupIO: payload => signBackupIOProof(payload, access.privateKey) },
    box: boxId => { assert.equal(boxId, descriptor.boxId); return item; }, saveBox: async (_, update, guard) => { guard(); Object.assign(item, update(item)); },
    run: operation => operation(() => {}), clock: () => now * 1000, materials: { releaseCurrent() {} }, backupFiles, inflight: new Set(), reviews,
    actorFor: () => actor, principalState: async () => ({ own: { capabilities: ['backup.create', 'ownership.transfer'] }, projection: { recoverySummary: recovery,
      principal: { principalSecurityVersion: 1 } } }),
    selfBinding: async () => ({ active: !state.revoked, principalSecurityVersion: 1 }),
    read: async () => ({ body: { status: structuredClone(status), operationEventDigest: randomId() } }),
    challengeFor: async () => ({ context, nonce: randomId(), issuedAt: now, expiresAt: now + 60 }),
    prepare: async (...args) => { state.prepareCalls.push(args); const visible = { reviewHandle: randomId(), action: args[1], args: args[2] };
      reviews.set(visible.reviewHandle, { visible, descriptor, mutation: { action: args[1], args: args[2] } }); return visible; },
    transportFactory: () => ({ request: async (route, input) => {
      const proof = verifyBackupIOProof(input.proof, access.publicKey.export({ format: 'jwk' }));
      let body, contentBase64 = null;
      if (route.endsWith('transfer.plan')) body = state.transferPlan;
      else if (route.endsWith('targets.list')) body = { type: 'backup-targets', targets: [{ targetId: 'local-managed', kind: 'local-managed',
        durability: 'same-box', scopeProfiles: state.catalogProfiles, resourceIds: [...new Set(state.catalogProfiles.flatMap(profile => profile === 'semantica-private-v1' ? ['semantica'] : ['clipboard', 'space:personal']))].sort(), maxArchiveBytes: 209715200 }] };
      else {
        if (state.failRange) throw new Error('synthetic disconnect');
        const chunk = ciphertext.subarray(input.body.offset, input.body.offset + input.body.length);
        body = { type: 'backup-archive-range', operationId: requestId, backupId, archiveSha256: sha(ciphertext),
          offset: input.body.offset, length: chunk.length, totalBytes: ciphertext.length, contentSha256: sha(chunk),
          eof: input.body.offset + chunk.length === ciphertext.length };
        contentBase64 = (state.corrupt ? Buffer.alloc(chunk.length, 68) : chunk).toString('base64');
      }
      return canonicalLedger({ receipt: signBackupIOResponse({ schemaVersion: 1, purpose: 'centuarai.local-backup.io-response', boxId: descriptor.boxId,
        boxKeyThumbprint: context.boxKeyThumbprint, operation: proof.operation, nonce: proof.nonce,
        requestBodySha256: proof.bodySha256, issuedAt: now, body }, signing.privateKey), contentBase64 });
    } }),
  });
  t.after(async () => { service.invalidate(); await backupFiles.close(); await rm(root, { recursive: true, force: true }); });
  return { ...state, state, root, item, reviews, coordinator: service, service: service.api, boxId: descriptor.boxId, requestId };
}
test('backup preparation derives recipient and resource scope from fresh signed target catalog', async t => {
  const e = await fixture(t);
  await assert.rejects(e.service.prepareBackupCreate({ boxId: e.boxId, targetId: '/untrusted/path', scopeProfile: 'semantica-private-v1', includeBusinessSecrets: false }), /TARGET_UNAVAILABLE/);
  assert.equal(e.prepareCalls.length, 0);
  await e.service.prepareBackupCreate({ boxId: e.boxId, targetId: 'local-managed', scopeProfile: 'semantica-private-v1', includeBusinessSecrets: false });
  const args = e.prepareCalls[0][2];
  assert.equal(args.scopeProfile, 'semantica-private-v1'); assert.deepEqual(args.resourceIds, ['semantica']);
  assert.equal(args.expectedRecoveryVersion, 1); assert.equal(args.includeBusinessSecrets, false);
});
test('signed complete job downloads exact chunks and reports actual native copy separately', async t => {
  const e = await fixture(t), result = await e.service.saveBackupArchive({ boxId: e.boxId, requestId: e.requestId });
  assert.equal(result.status.state, 'completed'); assert.equal(result.localCopy.verified, true);
  assert.equal(result.localCopy.archiveSha256, sha(e.ciphertext));
  assert.deepEqual(await readFile(e.file), e.ciphertext);
});
test('revoked identity, changed content and disconnection never leave a claimed or partial copy', async t => {
  const e = await fixture(t);
  for (const flag of ['revoked', 'corrupt', 'failRange']) {
    e.state[flag] = true;
    await assert.rejects(e.service.saveBackupArchive({ boxId: e.boxId, requestId: e.requestId }));
    assert.deepEqual(await readdir(e.root), []); e.state[flag] = false;
  }
  await e.service.refreshBackupOperation({ boxId: e.boxId, requestId: e.requestId });
  e.status.stateVersion--;
  await assert.rejects(e.service.refreshBackupOperation({ boxId: e.boxId, requestId: e.requestId }), /STATUS_CHANGED/);
});

test('transfer uses signed visible OS scope and rejects changed membership before approval signing', async t => {
  const e = await fixture(t), review = await e.service.prepareOwnershipTransfer({ boxId: e.boxId });
  assert.deepEqual(review.transferPlan, e.state.transferPlan);
  assert.equal(review.args.scopeManifestDigest, e.state.transferPlan.scopeManifestDigest);
  assert.equal(review.args.dataDisposition, 'erase-local');
  const selected = e.reviews.get(review.reviewHandle), current = { projection: { principal: { principalSecurityVersion: 1 } } };
  await e.coordinator.validateReview(selected, current, () => {});
  e.state.transferPlan.scope.affectedPrincipals++;
  e.state.transferPlan.scopeManifestDigest = ledgerDigest({ purpose: 'centuarai.local-ledger.transfer-scope', resetPlanDigest: e.state.transferPlan.resetPlanDigest, scope: e.state.transferPlan.scope });
  await assert.rejects(e.coordinator.validateReview(selected, current, () => {}), /SCOPE_CHANGED/);
});

test('WANX preparation requires exact current namespace hook and never accepts caller-selected resources or secrets', async t => {
  const absent = await fixture(t); absent.state.catalogProfiles = ['wanx-personal-v1'];
  const input = { boxId: absent.boxId, targetId: 'local-managed', scopeProfile: 'wanx-personal-v1', includeBusinessSecrets: false };
  await assert.rejects(absent.service.prepareBackupCreate(input), /NAMESPACE_UNAVAILABLE/);
  assert.equal(absent.prepareCalls.length, 0);
  const calls = [];
  const ready = await fixture(t, { ensureBackupNamespace: async input => { calls.push(input); const { signal, ...identity } = input; assert.equal(signal.aborted, false); return identity; } });
  ready.state.catalogProfiles = ['semantica-private-v1', 'wanx-personal-v1'];
  await ready.service.prepareBackupCreate({ ...input, boxId: ready.boxId });
  assert.deepEqual(Object.keys(calls[0]).sort(), ['bindingId', 'boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'principalId', 'profileId', 'signal'].sort());
  assert.equal(calls[0].principalId, ready.item.principalId);
  assert.deepEqual(ready.prepareCalls[0][2].resourceIds, ['clipboard', 'space:personal']);
  await assert.rejects(ready.service.prepareBackupCreate({ ...input, includeBusinessSecrets: true }), /INVALID_INPUT/);
  const changed = await fixture(t, { ensureBackupNamespace: async ({ signal, ...identity }) => ({ ...identity, principalId: 'someone-else' }) });
  changed.state.catalogProfiles = ['wanx-personal-v1'];
  await assert.rejects(changed.service.prepareBackupCreate({ ...input, boxId: changed.boxId }), /NAMESPACE_UNAVAILABLE/);
  assert.equal(changed.prepareCalls.length, 0);
});
