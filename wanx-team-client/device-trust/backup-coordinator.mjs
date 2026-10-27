import { createHash, randomBytes } from 'node:crypto';
import { canonicalLedger, ledgerDigest, mutationDigest } from './ledger-contract.mjs';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { BACKUP_CHUNK_BYTES, BACKUP_PROFILES, backupRecipientThumbprint, validateBackupIOBody, verifyBackupIOResponse } from './backup-contract.mjs';
import { inspectLocalBackupArchive } from './backup-archive.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalLedger(a) === canonicalLedger(b);
const copy = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('base64url');

// Narrow main-only backup workflow. All paths are selected by the native file
// adapter; all remote handles and completion claims are box-signed evidence.
export function createBackupCoordinator({ vault, box, saveBox, run, clock, transportFactory, materials, backupFiles,
  ensureBackupNamespace, requireProfile, inflight, prepare, reviews, read, selfBinding, principalState, send, actorFor, challengeFor }) {
  const sources = new Map();
  const now = () => Math.floor(clock() / 1000);
  const requireFiles = () => { if (!backupFiles) fail('LOCAL_BACKUP_FILES_UNAVAILABLE'); };
  const withFile = async (operation, guard) => {
    requireFiles(); guard(); const abort = new AbortController(); inflight.add(abort);
    try { const result = await operation(abort.signal); guard(); return result; }
    finally { inflight.delete(abort); }
  };
  async function io(item, operation, body, principalSecurityVersion, guard) {
    body = validateBackupIOBody(operation, body);
    const challenge = await challengeFor(item, guard);
    if (challenge.context.ownershipEpoch !== item.checkpoint.ownershipEpoch || challenge.context.boxId !== item.descriptor.boxId
      || challenge.context.boxKeyThumbprint !== publicKeyThumbprint(item.descriptor.boxKey)) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    const payload = { schemaVersion: 1, purpose: 'centuarai.local-backup.io', boxId: item.descriptor.boxId,
      boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey), ownershipEpoch: challenge.context.ownershipEpoch,
      principalSecurityVersion, nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
      actor: actorFor(item), operation, bodySha256: ledgerDigest(body) };
    const proof = vault.signBackupIO(payload), abort = new AbortController(); inflight.add(abort);
    try {
      const result = await transportFactory(item.descriptor).request('/backup-io/' + operation, { body, proof }, { signal: abort.signal });
      guard(); return verifyBackupIOResponse(result, { descriptor: item.descriptor, request: payload, now: now() });
    } finally { inflight.delete(abort); }
  }
  async function qualified(boxId, capability, guard) {
    const current = await principalState(box(boxId), guard);
    if (!current.own.capabilities.includes(capability)) fail('LOCAL_TRUST_CAPABILITY_REQUIRED');
    return { item: box(boxId), current, version: current.projection.principal.principalSecurityVersion };
  }
  async function ensureNamespace(item, scopeProfile, guard) {
    if (scopeProfile !== 'wanx-personal-v1') return;
    if (typeof ensureBackupNamespace !== 'function') fail('LOCAL_BACKUP_NAMESPACE_UNAVAILABLE');
    const expected = { profileId: requireProfile().profileId, boxId: item.descriptor.boxId,
      boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey), principalId: item.principalId,
      bindingId: item.bindingId, ownershipEpoch: item.checkpoint.ownershipEpoch };
    const abort = new AbortController(); inflight.add(abort);
    try {
      guard(); const result = await ensureBackupNamespace({ ...expected, signal: abort.signal }); guard();
      if (!same(result, expected)) fail('LOCAL_BACKUP_NAMESPACE_UNAVAILABLE');
    } finally { inflight.delete(abort); }
  }
  async function status(boxId, requestId, guard) {
    const item = box(boxId), saved = item.mutations?.[requestId];
    if (!saved?.ack || !['backup.create', 'backup.restore'].includes(saved.mutation.action)) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
    const response = await read(item, 'operation-status', requestId, guard), actual = response.body.status;
    if (actual.action !== saved.mutation.action || actual.mutationDigest !== mutationDigest(saved.mutation)) fail('LOCAL_LEDGER_MUTATION_CHANGED');
    const prior = saved.operationStatus?.status;
    if (prior && (actual.attempt < prior.attempt || actual.attempt === prior.attempt && actual.stateVersion < prior.stateVersion
      || prior.state === 'completed' && !same(prior, actual))) fail('LOCAL_BACKUP_STATUS_CHANGED');
    await saveBox(item.descriptor, value => ({ ...value, mutations: { ...value.mutations,
      [requestId]: { ...value.mutations[requestId], operationStatus: response.body } } }), guard);
    return { boxId, requestId, ...copy(response.body) };
  }
  return {
    invalidate() { for (const source of sources.values()) materials.releaseCurrent(source.material.recoveryHandle); sources.clear(); },
    async validateReview(selected, current, guard) {
      if (selected.mutation.action !== 'ownership.transfer-prepare') return;
      if (!selected.transferPlan || selected.transferPlan.scopeManifestDigest !== selected.mutation.args.scopeManifestDigest)
        fail('LOCAL_TRANSFER_SCOPE_CHANGED');
      const fresh = await io(box(selected.descriptor.boxId), 'transfer.plan', {}, current.projection.principal.principalSecurityVersion, guard);
      if (!same(fresh.body, selected.transferPlan)) fail('LOCAL_TRANSFER_SCOPE_CHANGED');
    },
    attachRestoreProof(selected, saved) {
      if (selected.mutation.action === 'ownership.transfer-prepare') {
        saved.transferPlan = copy(selected.transferPlan); saved.transferPlanReceipt = selected.transferPlanReceipt;
      }
      if (selected.mutation.action !== 'backup.restore') return;
      const source = sources.get(selected.backupSourceHandle);
      if (!source || source.boxId !== selected.descriptor.boxId || source.remote.sourceId !== selected.mutation.args.sourceId)
        fail('LOCAL_BACKUP_SOURCE_EXPIRED');
      saved.proofs.sourceRecoveryProof = materials.signSourceRecovery(source.material.recoveryHandle, selected.mutation);
      saved.restoreSource = copy(source.remote);
    },
    releaseReview(selected) {
      const source = sources.get(selected.backupSourceHandle);
      if (source) materials.releaseCurrent(source.material.recoveryHandle);
      sources.delete(selected.backupSourceHandle);
    },
    api: {
      prepareOwnershipTransfer: ({ boxId }) => run(async guard => {
        const { item, version } = await qualified(boxId, 'ownership.transfer', guard);
        const plan = await io(item, 'transfer.plan', {}, version, guard);
        const review = await prepare(boxId, 'ownership.transfer-prepare', {
          transferId: randomBytes(32).toString('base64url'), dataDisposition: 'erase-local',
          expectedOwnerPrincipalId: item.principalId, scopeManifestDigest: plan.body.scopeManifestDigest,
          retainedIndependentBackups: true,
        }, guard);
        const selected = reviews.get(review.reviewHandle);
        if (!selected) fail('LOCAL_TRUST_REVIEW_EXPIRED');
        selected.transferPlan = copy(plan.body); selected.transferPlanReceipt = plan.receipt;
        selected.visible.transferPlan = copy(plan.body);
        return copy(selected.visible);
      }),
      refreshBackupTargets: ({ boxId }) => run(async guard => {
        const { item, current, version } = await qualified(boxId, 'backup.create', guard);
        const result = await io(item, 'targets.list', {}, version, guard);
        return { boxId, ...copy(result.body), recovery: copy(current.projection.recoverySummary) };
      }),
      prepareBackupCreate: ({ boxId, targetId, scopeProfile, includeBusinessSecrets }) => run(async guard => {
        if (typeof includeBusinessSecrets !== 'boolean' || !Object.hasOwn(BACKUP_PROFILES, scopeProfile)
          || scopeProfile === 'wanx-personal-v1' && includeBusinessSecrets) fail('LOCAL_TRUST_INVALID_INPUT');
        const { item, current, version } = await qualified(boxId, 'backup.create', guard);
        const recovery = current.projection.recoverySummary;
        if (!recovery || recovery.status !== 'active') fail('LOCAL_BACKUP_RECOVERY_REQUIRED');
        const available = (await io(item, 'targets.list', {}, version, guard)).body.targets;
        const target = available.find(value => value.targetId === targetId);
        if (!target || !target.scopeProfiles.includes(scopeProfile)) fail('LOCAL_BACKUP_TARGET_UNAVAILABLE');
        await ensureNamespace(item, scopeProfile, guard);
        const review = await prepare(boxId, 'backup.create', { scopeProfile, resourceIds: BACKUP_PROFILES[scopeProfile],
          expectedRecoveryVersion: recovery.version, recipientKeyThumbprint: backupRecipientThumbprint(recovery.backupKey),
          targetId, includeBusinessSecrets }, guard);
        return review;
      }),
      importBackupSource: ({ boxId }) => run(async guard => {
        if (sources.size >= 4) fail('LOCAL_BACKUP_CAPACITY');
        const { item, current, version } = await qualified(boxId, 'backup.restore', guard);
        if (!current.projection.recoverySummary) fail('LOCAL_BACKUP_RECOVERY_REQUIRED');
        const material = await materials.importCurrent(guard); if (!material) return null;
        let local;
        try {
          local = await withFile(signal => backupFiles.chooseSource({ signal }), guard);
          if (!local) { materials.releaseCurrent(material.recoveryHandle); return null; }
          const inspected = await inspectLocalBackupArchive({ archiveBytes: local.archiveBytes, descriptor: material.descriptor,
            read: (offset, length) => withFile(signal => backupFiles.readSource({ handle: local.handle, offset, length, signal }), guard) });
          if (inspected.archiveSha256 !== local.archiveSha256 || inspected.header.principalId !== material.principalId
            || !Object.hasOwn(BACKUP_PROFILES, inspected.header.scopeProfile)) fail('LOCAL_BACKUP_SOURCE_CHANGED');
          const checkedKey = materials.unwrapArchiveKey(material.recoveryHandle, inspected.header); checkedKey.fill(0);
          const beginning = (await io(item, 'source.begin', { archiveBytes: local.archiveBytes, archiveSha256: local.archiveSha256,
            source: material.descriptor }, version, guard)).body;
          let offset = 0;
          while (offset < local.archiveBytes) {
            const chunk = await withFile(signal => backupFiles.readSource({ handle: local.handle, offset,
              length: Math.min(BACKUP_CHUNK_BYTES, local.archiveBytes - offset), signal }), guard);
            try {
              const response = (await io(item, 'source.append', { uploadId: beginning.uploadId, offset,
                chunkBase64: chunk.toString('base64') }, version, guard)).body;
              if (response.uploadId !== beginning.uploadId || response.offset !== offset + chunk.length) fail('LOCAL_BACKUP_RESPONSE_CHANGED');
              offset = response.offset;
            } finally { chunk.fill(0); }
          }
          const remote = (await io(item, 'source.finalize', { uploadId: beginning.uploadId }, version, guard)).body;
          if (remote.archiveBytes !== local.archiveBytes || remote.archiveSha256 !== local.archiveSha256 || !same(remote.source, material.descriptor)
            || !same(remote.header, inspected.header) || remote.sourceProof !== inspected.sourceProof
            || remote.header.principalId !== material.principalId || remote.header.recoveryId !== material.newRecovery.recoveryId
            || remote.header.recoveryVersion !== material.newRecovery.version || !same(remote.header.sourceRecoverySigningKey, material.newRecovery.signingKey)
            || remote.header.recipientKeyThumbprint !== backupRecipientThumbprint(material.newRecovery.backupKey)
            || !Object.hasOwn(BACKUP_PROFILES, remote.header.scopeProfile) || remote.expiresAt <= now()) fail('LOCAL_BACKUP_SOURCE_CHANGED');
          // Validate actual unwrap before presenting a restore review, then
          // discard that key. Only the committed operation can receive a key.
          const key = materials.unwrapArchiveKey(material.recoveryHandle, remote.header); key.fill(0);
          const sourceHandle = randomBytes(32).toString('base64url'); sources.set(sourceHandle, { boxId, material, remote });
          return { sourceHandle, boxId, label: local.label, sourceBoxId: remote.source.boxId,
            sourceBoxKeyThumbprint: publicKeyThumbprint(remote.source.boxKey), sourcePrincipalId: material.principalId,
            targetPrincipalId: item.principalId, backupId: remote.header.backupId, archiveBytes: remote.archiveBytes,
            archiveSha256: remote.archiveSha256, scopeProfile: remote.header.scopeProfile, resourceIds: BACKUP_PROFILES[remote.header.scopeProfile], expiresAt: remote.expiresAt };
        } catch (error) { materials.releaseCurrent(material.recoveryHandle); throw error; }
        finally { if (local) await backupFiles.release(local.handle); }
      }),
      prepareBackupRestore: ({ sourceHandle }) => run(async guard => {
        const source = sources.get(sourceHandle); if (!source || source.remote.expiresAt <= now()) fail('LOCAL_BACKUP_SOURCE_EXPIRED');
        const { item, current } = await qualified(source.boxId, 'backup.restore', guard);
        if (!current.projection.recoverySummary) fail('LOCAL_BACKUP_RECOVERY_REQUIRED');
        const remote = source.remote;
        await ensureNamespace(item, remote.header.scopeProfile, guard);
        const review = await prepare(source.boxId, 'backup.restore', { backupId: remote.header.backupId,
          archiveSha256: remote.archiveSha256, sourceBoxKeyThumbprint: publicKeyThumbprint(remote.source.boxKey),
          manifestSha256: remote.header.manifestSha256, targetDescriptorDigest: ledgerDigest(item.descriptor),
          scopeProfile: remote.header.scopeProfile, resourceIds: BACKUP_PROFILES[remote.header.scopeProfile],
          ownerMapping: [{ sourcePrincipalId: remote.header.principalId, targetPrincipalId: item.principalId,
            resourceIds: BACKUP_PROFILES[remote.header.scopeProfile] }], sourceId: remote.sourceId }, guard);
        const selected = reviews.get(review.reviewHandle);
        selected.backupSourceHandle = sourceHandle;
        selected.visible.backupSource = { source: { boxId: remote.source.boxId, baseUrl: remote.source.baseUrl },
          target: { boxId: item.descriptor.boxId, baseUrl: item.descriptor.baseUrl },
          createdAt: remote.header.createdAt, archiveBytes: remote.archiveBytes };
        return copy(selected.visible);
      }),
      refreshBackupOperation: ({ boxId, requestId }) => run(guard => status(boxId, requestId, guard)),
      provideRestoreKey: ({ boxId, requestId }) => run(async guard => {
        const progress = await status(boxId, requestId, guard), saved = box(boxId).mutations[requestId];
        if (progress.status.action !== 'backup.restore' || progress.status.state !== 'running' || progress.status.phase !== 'awaiting_key'
          || !saved.restoreSource) fail('LOCAL_BACKUP_KEY_NOT_REQUESTED');
        const source = saved.restoreSource, material = await materials.importCurrent(guard); if (!material) return null;
        let key;
        try {
          if (!same(material.descriptor, source.source)) fail('LOCAL_RECOVERY_SCOPE_MISMATCH');
          key = materials.unwrapArchiveKey(material.recoveryHandle, source.header);
          const item = box(boxId), self = await selfBinding(item, guard);
          if (!self.active || item.bindingId !== saved.mutation.actor.bindingId || item.principalId !== saved.mutation.actor.principalId)
            fail('LOCAL_TRUST_BINDING_INACTIVE');
          const challenge = await challengeFor(item, guard);
          if (challenge.context.ownershipEpoch !== saved.mutation.ownershipEpoch) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
          const proof = vault.signRestoreKey({ schemaVersion: 1, purpose: 'centuarai.local-restore.key', boxId,
            boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey), ownershipEpoch: challenge.context.ownershipEpoch,
            principalSecurityVersion: self.principalSecurityVersion, nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
            actor: actorFor(item), operationId: requestId, archiveSha256: source.archiveSha256, dataKeySha256: sha(key) });
          const received = await send(item.descriptor, '/operations/restore-key', { operationId: requestId,
            archiveSha256: source.archiveSha256, dataKey: key.toString('base64url'), proof }, 'restore-key-received', guard,
          { operationId: requestId, archiveSha256: source.archiveSha256 });
          return { boxId, requestId, keyReceived: true, receivedAt: received.body.receivedAt };
        } finally { key?.fill(0); materials.releaseCurrent(material.recoveryHandle); }
      }),
      saveBackupArchive: ({ boxId, requestId }) => run(async guard => {
        const progress = await status(boxId, requestId, guard), result = progress.status.result;
        if (progress.status.state !== 'completed' || result?.type !== 'backup-created') fail('LOCAL_BACKUP_NOT_COMPLETED');
        const item = box(boxId), self = await selfBinding(item, guard); if (!self.active) fail('LOCAL_TRUST_BINDING_INACTIVE');
        const destination = await withFile(signal => backupFiles.chooseDestination({ suggestedName: `centuarai-${result.backupId.slice(0, 16)}.cxb`,
          archiveBytes: result.bytes, archiveSha256: result.archiveSha256, signal }), guard);
        if (!destination) return null;
        try {
          for (let offset = 0; offset < result.bytes;) {
            const length = Math.min(BACKUP_CHUNK_BYTES, result.bytes - offset);
            const response = await io(item, 'archive.read', { operationId: requestId, offset, length }, self.principalSecurityVersion, guard);
            try {
              const range = response.body;
              if (range.operationId !== requestId || range.backupId !== result.backupId || range.archiveSha256 !== result.archiveSha256
                || range.offset !== offset || range.length !== length || range.totalBytes !== result.bytes) fail('LOCAL_BACKUP_RESPONSE_CHANGED');
              await withFile(signal => backupFiles.writeDestination({ handle: destination.handle, offset, bytes: response.content, signal }), guard);
              offset += length;
            } finally { response.content?.fill(0); }
          }
          const localCopy = await withFile(signal => backupFiles.commitDestination({ handle: destination.handle, signal }), guard);
          return { ...progress, localCopy: { ...localCopy, verified: true } };
        } finally { await backupFiles.release(destination.handle); }
      }),
    },
  };
}
