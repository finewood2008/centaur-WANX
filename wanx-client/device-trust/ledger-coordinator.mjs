import { createHash, randomBytes } from 'node:crypto';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { createPinnedTransport } from './pinned-transport.mjs';
import { createRecoveryMaterialManager } from './recovery-material.mjs';
import { createBackupCoordinator } from './backup-coordinator.mjs';
import { verifyDataResponse } from './data-contract.mjs';
import {
  canonicalLedger, mutationDigest, verifyLedgerResponse, V1_BINDING_FIELDS,
  validateLedgerPrepare, validateLedgerMutation,
  validateTargetInfo, parseTargetInfo, parseReviewHandoff, parseTargetProofPacket,
} from './ledger-contract.mjs';

const copy = value => structuredClone(value);
const id = () => randomBytes(32).toString('base64url');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalLedger(a) === canonicalLedger(b);
const checkpoint = value => Object.fromEntries(
  ['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion']
    .map(key => [key, value[key]]),
);
const capabilityFor = Object.freeze({
  'device.revoke': 'device.revoke', 'device.review-descendants': 'device.review_descendants',
  'principal.revoke': 'member.revoke', 'device.add-manager': 'device.approve_manage',
  'principal.invite': 'member.invite', 'recovery.setup': 'recovery.configure',
  'recovery.rotate': 'recovery.configure', 'backup.create': 'backup.create',
  'backup.restore': 'backup.restore', 'ownership.transfer-prepare': 'ownership.transfer',
});

// Main-only authority orchestration. The renderer gets immutable review DTOs
// and opaque handles. It never selects a signing purpose or a trusted roster.
export function createLedgerCoordinator({
  vault, state, box, saveBox, assertCheckpoint, run, requireProfile,
  clock = Date.now, transportFactory = descriptor => createPinnedTransport({ descriptor, protocolVersion: 2 }),
  files, backupFiles, ensureBackupNamespace,
}) {
  const inflight = new Set();
  const reviews = new Map();
  let backup;
  let generation = 0;
  const materials = createRecoveryMaterialManager({ files, clock });
  const recoveryDrafts = new Map();
  const recoveryImports = new Map();
  const now = () => Math.floor(clock() / 1000);
  const actorFor = item => ({ kind: 'binding', principalId: item.principalId,
    bindingId: item.bindingId, keyVersion: item.approvalKeyVersion || 1 });
  const invalidate = () => {
    generation += 1; reviews.clear();
    materials.invalidate(); recoveryDrafts.clear(); recoveryImports.clear();
    backup?.invalidate();
    void backupFiles?.invalidate().catch(() => {});
    for (const abort of inflight) abort.abort();
  };
  const send = async (descriptor, path, input, kind, guard, expected = {}) => {
    guard(); const abort = new AbortController(); inflight.add(abort);
    try {
      const jws = await transportFactory(descriptor).request(path, input, { signal: abort.signal });
      guard();
      const response = kind === 'effect'
        ? verifyDataResponse(jws, { descriptor, kind, nowMs: clock(), expected })
        : verifyLedgerResponse(jws, { descriptor, kind, now: now(), expected });
      return { body: response.body, jws };
    } finally { inflight.delete(abort); }
  };
  const challengePayload = (descriptor, actor, ownershipEpoch, action) => {
    const issuedAt = now();
    return { schemaVersion: 2, purpose: action ? 'centuarai.local-ledger.auth-mutation-challenge' : 'centuarai.local-ledger.auth-challenge',
      boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch,
      actor, clientNonce: id(), issuedAt, expiresAt: issuedAt + 60, ...(action ? { action } : {}) };
  };
  const challengeFor = async (item, guard, action) => {
    guard();
    const actor = actorFor(item), payload = challengePayload(item.descriptor, actor, item.checkpoint.ownershipEpoch, action);
    const proof = action ? vault.signLedgerAuthMutationChallenge(payload) : vault.signLedgerAuthChallenge(payload);
    return (await send(item.descriptor, action ? '/mutations/authenticated-challenge' : '/authenticated-challenge', { proof },
      action ? 'mutation-challenge' : 'read-challenge', guard, action ? { actor, action } : {})).body;
  };
  const recoveryChallengeFor = async (info, guard, action) => {
    guard();
    const actor = { kind: 'recovery', principalId: info.principalId, bindingId: null, keyVersion: info.newRecovery.version };
    const payload = challengePayload(info.descriptor, actor, null, action);
    const proof = action ? materials.signRecoveryMutationChallenge(info.recoveryHandle, payload) : materials.signRecoveryChallenge(info.recoveryHandle, payload);
    return (await send(info.descriptor, action ? '/mutations/authenticated-challenge' : '/authenticated-challenge', { proof },
      action ? 'mutation-challenge' : 'read-challenge', guard, action ? { actor, action } : {})).body;
  };
  const read = async (item, operation, requestId, guard) => {
    const challenge = await challengeFor(item, guard);
    const current = challenge.context;
    if (item.checkpoint && (current.ownershipEpoch < item.checkpoint.ownershipEpoch
      || current.rosterVersion < item.checkpoint.rosterVersion
      || current.policyVersion < item.checkpoint.policyVersion
      || (current.rosterVersion === item.checkpoint.rosterVersion && current.rosterDigest !== item.checkpoint.rosterDigest)))
      fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    const actor = actorFor(item);
    const proof = vault.signLedgerRead({
      schemaVersion: 2, purpose: 'centuarai.local-ledger.read', boxId: current.boxId,
      boxKeyThumbprint: current.boxKeyThumbprint, ownershipEpoch: current.ownershipEpoch,
      nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
      actor, operation, requestId, bindingId: operation === 'self-binding' ? actor.bindingId : null,
    });
    const result = await send(item.descriptor, '/read', { proof }, operation === 'data-effect' ? 'effect' : operation, guard,
      requestId && operation !== 'operation-status' ? { [operation === 'data-effect' ? 'operationId' : 'requestId']: requestId } : {});
    const returnedContext = result.body.context || result.body.currentContext;
    if (returnedContext && !same(returnedContext, current)) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    if (operation === 'operation-status' && result.body.status.operationId !== requestId) fail('LOCAL_LEDGER_RESPONSE_CHANGED');
    return result;
  };
  const selfBinding = async (item, guard) => {
    const self = (await read(item, 'self-binding', null, guard)).body;
    const profile = requireProfile();
    if (self.bindingId !== item.bindingId || self.principalId !== item.principalId || self.clientId !== profile.clientId)
      fail('LOCAL_LEDGER_SCOPE_MISMATCH');
    const active = self.status === 'active' && self.principalStatus === 'active' && self.ownershipState === 'owned'
      && self.bindingOwnershipEpoch === self.currentContext.ownershipEpoch;
    await saveBox(item.descriptor, saved => ({ ...saved, ledgerVersion: 2, self: { ...self, active, checkedAt: now() } }), guard);
    return { ...self, active };
  };
  const principalState = async (item, guard) => {
    const self = await selfBinding(item, guard);
    if (!self.active) fail('LOCAL_TRUST_BINDING_INACTIVE');
    const current = (await read(item, 'principal-state', null, guard)).body;
    assertCheckpoint(item.checkpoint, current.context);
    const projection = current.projection;
    if (projection.principal.principalId !== item.principalId || projection.principal.status !== 'active'
      || projection.principal.ownershipEpoch !== current.context.ownershipEpoch) fail('LOCAL_LEDGER_SCOPE_MISMATCH');
    const profile = requireProfile();
    const own = projection.bindings.find(binding => binding.bindingId === item.bindingId
      && binding.clientId === profile.clientId && binding.principalId === item.principalId
      && binding.role === 'manage' && binding.status === 'active' && binding.ownershipEpoch === current.context.ownershipEpoch
      && publicKeyThumbprint(binding.accessKey) === publicKeyThumbprint(profile.accessKey)
      && binding.approvalKey && publicKeyThumbprint(binding.approvalKey) === publicKeyThumbprint(profile.approvalKey)
      && (binding.expiresAt === null || binding.expiresAt > now()));
    if (!own) fail('LOCAL_TRUST_MANAGER_REQUIRED');
    await saveBox(item.descriptor, saved => ({ ...saved, ledgerVersion: 2, approvalKeyVersion: own.approvalKeyVersion,
      checkpoint: checkpoint(current.context), security: current, self: { ...self, checkedAt: now() } }), guard);
    return { ...current, own, self };
  };
  const stateDTO = (boxId, current) => ({
    boxId, context: copy(current.context), self: copy(current.self),
    ownership: copy(current.projection.ownershipView), capabilities: copy(current.own.capabilities),
    qualifiedOriginalOwnerRoot: current.projection.qualifiedOriginalOwnerRoot,
    devices: current.projection.bindings.map(binding => ({
      bindingId: binding.bindingId, principalId: binding.principalId, clientId: binding.clientId,
      role: binding.role, status: binding.status, bindingRevision: binding.bindingRevision,
      capabilities: copy(binding.capabilities), expiresAt: binding.expiresAt, delegationExpiresAt: binding.delegationExpiresAt,
      accessKeyThumbprint: publicKeyThumbprint(binding.accessKey),
      approvalKeyThumbprint: binding.approvalKey ? publicKeyThumbprint(binding.approvalKey) : null,
    })), grants: copy(current.projection.grants), recovery: copy(current.projection.recoverySummary),
  });
  const visibleReview = (descriptor, value) => ({
    reviewHandle: id(), kind: 'ledger-mutation', boxId: descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), principalId: value.mutation.actor.principalId,
    action: value.mutation.action, requestId: value.mutation.requestId, mutationDigest: mutationDigest(value.mutation),
    ownershipEpoch: value.mutation.ownershipEpoch, rosterVersion: value.mutation.rosterVersion,
    expiresAt: value.mutation.expiresAt, args: copy(value.mutation.args), effects: copy(value.effects),
    ...(value.mutation.args.target ? {
      targetAccessKeyThumbprint: publicKeyThumbprint(value.mutation.args.target.accessKey),
      targetApprovalKeyThumbprint: publicKeyThumbprint(value.mutation.args.target.approvalKey),
    } : {}),
  });
  const enrollmentArgs = input => {
    const info = parseTargetInfo(input.targetInfo);
    return { principalId: info.principalId, target: {
      clientId: info.clientId, accessKey: info.accessKey, approvalKey: info.approvalKey,
      keyProtection: info.keyProtection, capabilities: input.capabilities, grants: input.grants,
      delegableGrants: input.delegableGrants, expiresAt: input.expiresAt, delegationExpiresAt: input.delegationExpiresAt,
    } };
  };
  const prepare = async (boxId, action, args, guard) => {
    const item = box(boxId);
    const current = await principalState(item, guard);
    if (action === 'owner-policy.activate-v2') {
      if (!current.projection.qualifiedOriginalOwnerRoot) fail('LOCAL_TRUST_ORIGINAL_OWNER_REQUIRED');
    } else if (!current.own.capabilities.includes(capabilityFor[action])) fail('LOCAL_TRUST_CAPABILITY_REQUIRED');
    const actor = { kind: 'binding', principalId: item.principalId, bindingId: current.own.bindingId,
      keyVersion: current.own.approvalKeyVersion };
    const challenge = await challengeFor(box(boxId), guard, action);
    if (!same(challenge.context, current.context)) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    const payload = validateLedgerPrepare({ schemaVersion: 2, purpose: 'centuarai.local-ledger.prepare', ...current.context,
      requestId: id(), challenge: challenge.challenge, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, actor, action, args });
    const prepareProof = vault.signLedgerPrepare(payload);
    const response = await send(item.descriptor, '/mutations/prepare', { prepareProof }, 'mutation-review', guard);
    const { effectsDigest, ...withoutDigest } = response.body.mutation;
    if (!same({ ...withoutDigest, purpose: 'centuarai.local-ledger.prepare' }, payload)) fail('LOCAL_LEDGER_MUTATION_CHANGED');
    const visible = visibleReview(item.descriptor, response.body);
    reviews.clear();
    reviews.set(visible.reviewHandle, { visible, descriptor: item.descriptor, mutation: response.body.mutation,
      effects: response.body.effects, reviewJws: response.jws, generation });
    return copy(visible);
  };
  const takeReview = (handle, guard) => {
    guard(); const value = reviews.get(handle);
    if (!value || value.generation !== generation || value.mutation.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED');
    return value;
  };
  const recordAck = async (descriptor, saved, jws, guard) => {
    const mutation = saved.mutation;
    const ack = verifyLedgerResponse(jws, { descriptor, kind: 'mutation-ack', now: now(), expected: {
      requestId: mutation.requestId, mutationDigest: mutationDigest(mutation), action: mutation.action, effectsDigest: mutation.effectsDigest,
    } }).body;
    if (ack.ownershipEpoch !== mutation.ownershipEpoch || ack.rosterVersion <= mutation.rosterVersion || ack.policyVersion < mutation.policyVersion)
      fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    await saveBox(descriptor, item => {
      const prior = item.checkpoint;
      if (prior && (prior.ownershipEpoch !== ack.ownershipEpoch || (prior.rosterVersion === ack.rosterVersion && prior.rosterDigest !== ack.rosterDigest)))
        fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
      const next = { ...checkpoint(ack), boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey) };
      const recovered = mutation.action === 'recovery.recover';
      if (recovered && (ack.result.principalId !== mutation.actor.principalId || !ack.result.bindingId
        || ack.result.recoveryVersion !== mutation.args.newRecovery.version)) fail('LOCAL_LEDGER_SCOPE_MISMATCH');
      return { ...item, ledgerVersion: 2, checkpoint: !prior || next.rosterVersion >= prior.rosterVersion ? next : prior,
        ...(recovered ? { role: 'manage', principalId: ack.result.principalId, bindingId: ack.result.bindingId, approvalKeyVersion: 1 } : {}),
        mutations: { ...item.mutations, [mutation.requestId]: { ...saved, state: 'committed', ack: jws } } };
    }, guard);
    let self = null;
    try { self = await selfBinding(box(descriptor.boxId), guard); } catch { guard(); }
    return { boxId: descriptor.boxId, requestId: mutation.requestId, state: 'committed', ack: copy(ack), self,
      ...(mutation.action.startsWith('recovery.') ? { recoveryOutcome: mutation.action === 'recovery.recover' ? 'identity-recovered' : 'configuration-committed' } : {}),
      dataEffect: ['device.revoke', 'principal.revoke', 'recovery.recover', 'ownership.transfer-prepare'].includes(mutation.action)
        ? { effectState: 'unknown', operationId: mutation.requestId } : null };
  };
  const commit = async (descriptor, saved, guard) => {
    let response;
    try { response = await send(descriptor, '/mutations/commit', saved.proofs, 'mutation-ack', guard); }
    catch (error) {
      guard();
      await saveBox(descriptor, item => ({ ...item, mutations: { ...item.mutations,
        [saved.mutation.requestId]: { ...saved, state: 'outcome_unknown' },
      } }), guard);
      return { boxId: descriptor.boxId, requestId: saved.mutation.requestId, state: 'outcome_unknown', ack: null, self: null, dataEffect: null };
    }
    return recordAck(descriptor, saved, response.jws, guard);
  };
  const readRecovery = async (info, operation, requestId, guard) => {
    const challenge = await recoveryChallengeFor(info, guard);
    const proof = materials.signRecoveryRead(info.recoveryHandle, {
      schemaVersion: 2, purpose: 'centuarai.local-ledger.read', boxId: info.descriptor.boxId,
      boxKeyThumbprint: publicKeyThumbprint(info.descriptor.boxKey), ownershipEpoch: challenge.context.ownershipEpoch,
      nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
      actor: { kind: 'recovery', principalId: info.principalId, bindingId: null, keyVersion: info.newRecovery.version },
      operation, requestId, bindingId: null,
    });
    return (await send(info.descriptor, '/read', { proof }, operation, guard, { principalId: info.principalId })).body;
  };
  const currentRecovery = async (info, guard) => {
    const current = await readRecovery(info, 'recovery-state', null, guard);
    const configuration = current.configuration;
    if (!configuration || configuration.status !== 'active' || configuration.recoveryId !== info.newRecovery.recoveryId
      || configuration.version !== info.newRecovery.version || !same(configuration.signingKey, info.newRecovery.signingKey)
      || !same(configuration.backupKey, info.newRecovery.backupKey)) fail('LOCAL_RECOVERY_SCOPE_MISMATCH');
    return current;
  };
  backup = createBackupCoordinator({ vault, box, saveBox, run, clock, transportFactory, materials, backupFiles, ensureBackupNamespace, requireProfile,
    inflight, prepare, reviews, read, selfBinding, principalState, send, actorFor, challengeFor });
  return {
    invalidate,
    managerReadChallenge: (item, guard) => challengeFor(item, guard),
    async managerState(item, guard) {
      const current = await principalState(item, guard);
      if (!current.own.capabilities.includes('device.approve_use')) fail('LOCAL_TRUST_MANAGER_REQUIRED');
      const projected = binding => Object.fromEntries(V1_BINDING_FIELDS.map(name => [name, copy(binding[name])]));
      return { context: current.context, own: projected(current.own), bindings: current.projection.bindings.map(projected),
        recoveryConfigured: current.projection.recoverySummary !== null };
    },
    snapshot() {
      return Object.values(state().boxes).flatMap(item => [...Object.entries(item.mutations || {}).map(([requestId, value]) => ({
        boxId: item.descriptor.boxId, requestId, action: value.mutation.action, state: value.state,
      })), ...Object.entries(item.targetReviews || {}).filter(([, value]) => value.state === 'awaiting_actor_commit').map(([requestId, value]) => ({
        boxId: item.descriptor.boxId, requestId, action: value.mutation.action, state: value.state, role: 'target',
      }))]);
    },
    api: {
      ...backup.api,
      beginRecoveryConfiguration: ({ boxId }) => run(async guard => {
        const item = box(boxId), current = await principalState(item, guard);
        if (!current.own.capabilities.includes('recovery.configure')) fail('LOCAL_TRUST_CAPABILITY_REQUIRED');
        const expectedRecoveryVersion = current.projection.principal.recoveryVersion;
        const material = await materials.generate({ descriptor: item.descriptor, principalId: item.principalId, version: expectedRecoveryVersion + 1 }, guard);
        recoveryDrafts.set(material.materialHandle, { boxId, expectedRecoveryVersion });
        return { ...material, boxId, operation: expectedRecoveryVersion === 0 ? 'recovery.setup' : 'recovery.rotate' };
      }),
      exportRecoveryMaterial: ({ materialHandle }) => run(guard => materials.export(materialHandle, guard)),
      reimportRecoveryMaterial: ({ materialHandle }) => run(guard => materials.reimport(materialHandle, guard)),
      prepareRecoveryConfiguration: ({ materialHandle }) => run(async guard => {
        const draft = recoveryDrafts.get(materialHandle), material = materials.publicDraft(materialHandle);
        if (!draft || draft.recoveryHandle || material.state !== 'reimport_verified') fail('LOCAL_RECOVERY_REIMPORT_REQUIRED');
        const result = await prepare(draft.boxId, draft.expectedRecoveryVersion === 0 ? 'recovery.setup' : 'recovery.rotate',
          { expectedRecoveryVersion: draft.expectedRecoveryVersion, newRecovery: material.newRecovery }, guard);
        reviews.get(result.reviewHandle).materialHandle = materialHandle;
        return result;
      }),
      importIdentityRecovery: () => run(async guard => {
        const info = await materials.importCurrent(guard);
        if (!info) return null;
        try {
          const known = state().boxes[info.descriptor.boxId];
          if (known && !same(known.descriptor, info.descriptor)) fail('LOCAL_TRUST_PIN_CHANGED');
          if (known?.bindingId) fail('LOCAL_RECOVERY_NEW_DEVICE_REQUIRED');
          const current = await currentRecovery(info, guard);
          recoveryImports.set(info.recoveryHandle, { ...info, principalSecurityVersion: current.principalSecurityVersion });
          return { ...info, boxKeyThumbprint: publicKeyThumbprint(info.descriptor.boxKey),
            principalSecurityVersion: current.principalSecurityVersion, configuration: copy(current.configuration) };
        } catch (error) { materials.releaseCurrent(info.recoveryHandle); throw error; }
      }),
      beginIdentityRecovery: ({ recoveryHandle }) => run(async guard => {
        const info = recoveryImports.get(recoveryHandle);
        if (!info) fail('LOCAL_RECOVERY_MATERIAL_EXPIRED');
        const current = await currentRecovery(info, guard);
        const material = await materials.generate({ descriptor: info.descriptor, principalId: info.principalId, version: info.newRecovery.version + 1 }, guard);
        recoveryDrafts.set(material.materialHandle, { boxId: info.descriptor.boxId, recoveryHandle,
          expectedRecoveryVersion: info.newRecovery.version, expectedPrincipalSecurityVersion: current.principalSecurityVersion });
        return { ...material, boxId: info.descriptor.boxId, operation: 'recovery.recover' };
      }),
      prepareIdentityRecovery: ({ materialHandle }) => run(async guard => {
        const draft = recoveryDrafts.get(materialHandle), material = materials.publicDraft(materialHandle);
        const info = recoveryImports.get(draft?.recoveryHandle);
        if (!draft || !info || material.state !== 'reimport_verified') fail('LOCAL_RECOVERY_REIMPORT_REQUIRED');
        const current = await currentRecovery(info, guard);
        if (current.principalSecurityVersion !== draft.expectedPrincipalSecurityVersion) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
        const actor = { kind: 'recovery', principalId: info.principalId, bindingId: null, keyVersion: info.newRecovery.version };
        const action = 'recovery.recover';
        const challenge = await recoveryChallengeFor(info, guard, action);
        const profile = requireProfile();
        const payload = validateLedgerPrepare({ schemaVersion: 2, purpose: 'centuarai.local-ledger.prepare', ...challenge.context,
          requestId: id(), challenge: challenge.challenge, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, actor, action,
          args: { expectedRecoveryVersion: draft.expectedRecoveryVersion, expectedPrincipalSecurityVersion: draft.expectedPrincipalSecurityVersion,
            newRecovery: material.newRecovery, target: { clientId: profile.clientId, accessKey: profile.accessKey,
              approvalKey: profile.approvalKey, keyProtection: 'software-passphrase-v1' } } });
        const prepareProof = materials.signRecoveryPrepare(info.recoveryHandle, payload);
        const result = await send(info.descriptor, '/mutations/prepare', { prepareProof }, 'mutation-review', guard);
        const { effectsDigest, ...withoutDigest } = result.body.mutation;
        if (!same({ ...withoutDigest, purpose: 'centuarai.local-ledger.prepare' }, payload)) fail('LOCAL_LEDGER_MUTATION_CHANGED');
        const visible = { ...visibleReview(info.descriptor, result.body), kind: 'ledger-recovery' };
        reviews.clear(); reviews.set(visible.reviewHandle, { visible, descriptor: info.descriptor, ...result.body,
          reviewJws: result.jws, materialHandle, recoveryHandle: info.recoveryHandle, generation });
        return copy(visible);
      }),
      confirmIdentityRecovery: ({ reviewHandle, passphrase }) => run(async guard => {
        const selected = takeReview(reviewHandle, guard);
        if (selected.visible.kind !== 'ledger-recovery') fail('LOCAL_TRUST_REVIEW_INVALID');
        reviews.delete(reviewHandle);
        const live = () => { guard(); if (selected.generation !== generation || selected.mutation.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED'); };
        const targetProofs = await vault.signLedgerTarget({ payload: selected.mutation, passphrase, guard: live });
        live();
        const proofs = { mutationProof: materials.signRecoveryMutation(selected.recoveryHandle, selected.mutation), ...targetProofs,
          recoveryMaterialProof: materials.signMaterial(selected.materialHandle, selected.mutation), sourceRecoveryProof: null };
        const saved = { mutation: selected.mutation, effects: selected.effects, reviewJws: selected.reviewJws, state: 'outcome_unknown', proofs };
        await saveBox(selected.descriptor, item => ({ ...item, principalId: selected.mutation.actor.principalId,
          mutations: { ...item.mutations, [selected.mutation.requestId]: saved } }), live);
        materials.releaseDraft(selected.materialHandle); materials.releaseCurrent(selected.recoveryHandle);
        recoveryDrafts.delete(selected.materialHandle); recoveryImports.delete(selected.recoveryHandle);
        return commit(selected.descriptor, saved, guard);
      }),
      exportTargetInfo: () => run(async guard => {
        guard(); const profile = requireProfile();
        const info = validateTargetInfo({ schemaVersion: 2, type: 'centuarai-local-ledger-target-info',
          principalId: profile.principalId, clientId: profile.clientId, accessKey: profile.accessKey,
          approvalKey: profile.approvalKey, keyProtection: 'software-passphrase-v1' });
        return { targetInfo: canonicalLedger(info), accessKeyThumbprint: publicKeyThumbprint(info.accessKey),
          approvalKeyThumbprint: publicKeyThumbprint(info.approvalKey), clientId: info.clientId };
      }),
      prepareManagerEnrollment: input => run(guard => {
        const { target } = enrollmentArgs(input); return prepare(input.boxId, 'device.add-manager', { target }, guard);
      }),
      prepareMemberInvitation: input => run(guard => prepare(input.boxId, 'principal.invite', enrollmentArgs(input), guard)),
      exportTargetReview: ({ reviewHandle }) => run(async guard => {
        const selected = takeReview(reviewHandle, guard);
        if (!['device.add-manager', 'principal.invite'].includes(selected.mutation.action)) fail('LOCAL_TRUST_REVIEW_INVALID');
        const { baseUrl, tlsSpkiSha256, boxKey } = selected.descriptor;
        return { reviewHandoff: canonicalLedger({ schemaVersion: 2, type: 'centuarai-local-ledger-review-handoff',
          baseUrl, tlsSpkiSha256, boxKey, reviewJws: selected.reviewJws }) };
      }),
      importTargetProofs: ({ reviewHandle, targetProofs }) => run(async guard => {
        const selected = takeReview(reviewHandle, guard);
        selected.targetProofs = parseTargetProofPacket(targetProofs, selected.mutation, now());
        selected.visible.targetConfirmed = true;
        return copy(selected.visible);
      }),
      prepareTargetApproval: ({ reviewHandoff }) => run(async guard => {
        const selected = parseReviewHandoff(reviewHandoff, now());
        const profile = requireProfile(), mutation = selected.mutation;
        if (!['device.add-manager', 'principal.invite'].includes(mutation.action)) fail('LOCAL_TRUST_REVIEW_INVALID');
        const target = mutation.args.target;
        if (target.clientId !== profile.clientId || publicKeyThumbprint(target.accessKey) !== publicKeyThumbprint(profile.accessKey)
          || publicKeyThumbprint(target.approvalKey) !== publicKeyThumbprint(profile.approvalKey)
          || (mutation.action === 'principal.invite' && mutation.args.principalId !== profile.principalId)) fail('LOCAL_TRUST_TARGET_CHANGED');
        const known = state().boxes[selected.descriptor.boxId];
        if (known && !same(known.descriptor, selected.descriptor)) fail('LOCAL_TRUST_PIN_CHANGED');
        if (known?.bindingId) fail('LOCAL_TRUST_ALREADY_KNOWN');
        if (known?.checkpoint) assertCheckpoint(known.checkpoint, checkpoint(mutation));
        guard();
        const visible = { ...visibleReview(selected.descriptor, selected), kind: 'ledger-target',
          principalId: mutation.action === 'principal.invite' ? mutation.args.principalId : mutation.actor.principalId };
        reviews.clear(); reviews.set(visible.reviewHandle, { ...selected, visible, generation });
        return copy(visible);
      }),
      confirmTargetApproval: ({ reviewHandle, passphrase }) => run(async guard => {
        const selected = takeReview(reviewHandle, guard);
        if (selected.visible.kind !== 'ledger-target') fail('LOCAL_TRUST_REVIEW_INVALID');
        reviews.delete(reviewHandle);
        const live = () => { guard(); if (selected.generation !== generation || selected.mutation.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED'); };
        const proofs = await vault.signLedgerTarget({ payload: selected.mutation, passphrase, guard: live });
        live();
        await saveBox(selected.descriptor, item => ({ ...item, principalId: selected.visible.principalId,
          targetReviews: { ...item.targetReviews, [selected.mutation.requestId]: {
            mutation: selected.mutation, effects: selected.effects, reviewJws: selected.reviewJws, state: 'awaiting_actor_commit',
            targetProofs: proofs, targetProofDigests: Object.fromEntries(Object.entries(proofs).map(([name, proof]) =>
              [name, createHash('sha256').update(proof, 'ascii').digest('base64url')])),
          } },
        }), live);
        return { boxId: selected.descriptor.boxId, requestId: selected.mutation.requestId, state: 'awaiting_actor_commit',
          targetProofs: canonicalLedger({ schemaVersion: 2, type: 'centuarai-local-ledger-target-proofs',
            requestId: selected.mutation.requestId, mutationDigest: mutationDigest(selected.mutation), ...proofs }) };
      }),
      exportSecurityReceipt: ({ boxId, requestId }) => run(async guard => {
        guard(); const saved = box(boxId).mutations?.[requestId];
        if (!saved?.ack || !['device.add-manager', 'principal.invite'].includes(saved.mutation.action)) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
        return { boxId, requestId, receipt: saved.ack };
      }),
      resumeTargetApproval: ({ boxId, requestId }) => run(async guard => {
        guard(); const item = box(boxId), saved = item.targetReviews?.[requestId];
        if (!saved || saved.state !== 'awaiting_actor_commit') fail('LOCAL_TRUST_REQUEST_UNKNOWN');
        const mutation = validateLedgerMutation(saved.mutation), profile = requireProfile();
        if (!['device.add-manager', 'principal.invite'].includes(mutation.action) || mutation.requestId !== requestId
          || mutation.args.target.clientId !== profile.clientId
          || publicKeyThumbprint(mutation.args.target.accessKey) !== publicKeyThumbprint(profile.accessKey)
          || publicKeyThumbprint(mutation.args.target.approvalKey) !== publicKeyThumbprint(profile.approvalKey)) fail('LOCAL_TRUST_TARGET_CHANGED');
        for (const name of ['targetAccessProof', 'targetApprovalProof']) {
          if (typeof saved.targetProofs?.[name] !== 'string'
            || createHash('sha256').update(saved.targetProofs[name], 'ascii').digest('base64url') !== saved.targetProofDigests?.[name])
            fail('LOCAL_TRUST_TARGET_CHANGED');
        }
        return { boxId, requestId, state: saved.state, expiresAt: mutation.expiresAt,
          targetProofs: canonicalLedger({ schemaVersion: 2, type: 'centuarai-local-ledger-target-proofs', requestId,
            mutationDigest: mutationDigest(mutation), ...saved.targetProofs }) };
      }),
      acceptEnrollmentReceipt: ({ boxId, requestId, receipt }) => run(async guard => {
        const item = box(boxId), saved = item.targetReviews?.[requestId];
        if (!saved) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
        const ack = verifyLedgerResponse(receipt, { descriptor: item.descriptor, kind: 'mutation-ack', now: now(),
          expected: { requestId, mutationDigest: mutationDigest(saved.mutation), action: saved.mutation.action, effectsDigest: saved.mutation.effectsDigest } }).body;
        const principalId = saved.mutation.action === 'principal.invite' ? saved.mutation.args.principalId : saved.mutation.actor.principalId;
        if (ack.result.principalId !== principalId || !ack.result.bindingId || ack.ownershipEpoch !== saved.mutation.ownershipEpoch
          || ack.rosterVersion <= saved.mutation.rosterVersion) fail('LOCAL_LEDGER_SCOPE_MISMATCH');
        await saveBox(item.descriptor, value => {
          const prior = value.checkpoint;
          if (prior && (prior.ownershipEpoch !== ack.ownershipEpoch
            || (prior.rosterVersion === ack.rosterVersion && prior.rosterDigest !== ack.rosterDigest))) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
          const next = { ...checkpoint(ack), boxId, boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey) };
          if (prior && next.rosterVersion >= prior.rosterVersion && next.policyVersion < prior.policyVersion) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
          return { ...value, ledgerVersion: 2, role: 'manage', principalId, bindingId: ack.result.bindingId, approvalKeyVersion: 1,
            checkpoint: prior && prior.rosterVersion > next.rosterVersion ? prior : next,
            targetReviews: { ...value.targetReviews, [requestId]: { ...saved, state: 'committed', ack: receipt } } };
        }, guard);
        const self = await selfBinding(box(boxId), guard);
        return { boxId, requestId, state: 'committed', ack: copy(ack), self, dataEffect: null };
      }),
      refreshSecurityState: ({ boxId }) => run(async guard => stateDTO(boxId, await principalState(box(boxId), guard))),
      refreshSelfBinding: ({ boxId }) => run(async guard => ({ boxId, self: await selfBinding(box(boxId), guard) })),
      refreshMembers: ({ boxId }) => run(async guard => {
        const item = box(boxId); const current = await principalState(item, guard);
        if (!current.own.capabilities.some(value => ['member.invite', 'member.revoke'].includes(value))) fail('LOCAL_TRUST_CAPABILITY_REQUIRED');
        const result = (await read(item, 'membership-directory', null, guard)).body;
        assertCheckpoint(current.context, result.context); return { boxId, ...copy(result) };
      }),
      prepareActivatePolicy: ({ boxId, capabilities }) => run(guard => prepare(boxId, 'owner-policy.activate-v2', { capabilities }, guard)),
      prepareDeviceRevocation: ({ boxId, bindingId, mode }) => run(guard => prepare(boxId, 'device.revoke', { bindingId, mode }, guard)),
      prepareDescendantReview: ({ boxId, bindingIds }) => run(guard => prepare(boxId, 'device.review-descendants', { bindingIds }, guard)),
      prepareMemberRevocation: ({ boxId, principalId }) => run(guard => prepare(boxId, 'principal.revoke', { principalId }, guard)),
      confirmSecurityMutation: ({ reviewHandle, passphrase }) => run(async guard => {
        const selected = takeReview(reviewHandle, guard);
        reviews.delete(reviewHandle);
        const mutation = validateLedgerMutation(selected.mutation);
        if (mutation.action === 'recovery.recover' || mutation.action === 'backup.restore' && !selected.backupSourceHandle
          || (['recovery.setup', 'recovery.rotate'].includes(mutation.action) && !selected.materialHandle)
          || (['device.add-manager', 'principal.invite'].includes(mutation.action) && !selected.targetProofs))
          fail('LOCAL_TRUST_ADDITIONAL_PROOF_REQUIRED');
        const live = () => {
          guard();
          if (selected.generation !== generation || selected.mutation.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED');
        };
        const current = await principalState(box(selected.descriptor.boxId), live);
        if (!same(current.context, checkpoint(mutation))) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
        await backup.validateReview(selected, current, live);
        const mutationProof = await vault.signLedgerMutation({ payload: mutation, passphrase, guard: live });
        live();
        const saved = { mutation, effects: selected.effects, reviewJws: selected.reviewJws, state: 'outcome_unknown',
          proofs: { mutationProof, targetAccessProof: selected.targetProofs?.targetAccessProof || null,
            targetApprovalProof: selected.targetProofs?.targetApprovalProof || null,
            recoveryMaterialProof: selected.materialHandle ? materials.signMaterial(selected.materialHandle, mutation) : null, sourceRecoveryProof: null } };
        backup.attachRestoreProof(selected, saved);
        await saveBox(selected.descriptor, item => ({ ...item, mutations: { ...item.mutations, [mutation.requestId]: saved } }), live);
        backup.releaseReview(selected);
        reviews.delete(reviewHandle);
        if (selected.materialHandle) { materials.releaseDraft(selected.materialHandle); recoveryDrafts.delete(selected.materialHandle); }
        return commit(selected.descriptor, saved, guard);
      }),
      refreshSecurityMutation: ({ boxId, requestId }) => run(async guard => {
        const item = box(boxId); const saved = item.mutations?.[requestId];
        if (!saved) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
        if (saved.mutation.actor.kind === 'recovery' && !item.bindingId) return commit(item.descriptor, saved, guard);
        const result = (await read(item, 'mutation-status', requestId, guard)).body;
        if (result.mutationDigest !== mutationDigest(saved.mutation) || result.action !== saved.mutation.action) fail('LOCAL_LEDGER_MUTATION_CHANGED');
        if (result.state === 'committed') return recordAck(item.descriptor, saved, result.ack, guard);
        if (result.state === 'prepared' && saved.proofs) return commit(item.descriptor, saved, guard);
        await saveBox(item.descriptor, value => ({ ...value, mutations: { ...value.mutations, [requestId]: { ...saved, state: result.state } } }), guard);
        return { boxId, requestId, state: result.state, ack: null, self: null, dataEffect: null };
      }),
      refreshOwnershipTransfer: ({ boxId, requestId }) => run(async guard => {
        const item = box(boxId), saved = item.mutations?.[requestId];
        if (!saved?.ack || saved.mutation.action !== 'ownership.transfer-prepare'
          || !same(saved.mutation.actor, actorFor(item))) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
        const status = (await read(item, 'transfer-status', requestId, guard)).body, actual = status.checkpoint.context;
        if (status.transferId !== saved.mutation.args.transferId || status.sourceOwnershipEpoch !== saved.mutation.ownershipEpoch
          || actual.boxId !== boxId || actual.boxKeyThumbprint !== publicKeyThumbprint(item.descriptor.boxKey)
          || actual.rosterVersion <= saved.mutation.rosterVersion || actual.policyVersion < saved.mutation.policyVersion)
          fail('LOCAL_TRANSFER_STATUS_CHANGED');
        const prior = saved.transferStatus, ranks = { frozen: 0, erase_pending: 1, redelivery_ready: 2 };
        if (prior && (ranks[status.state] < ranks[prior.state] || status.updatedAt < prior.updatedAt
          || actual.rosterVersion < prior.checkpoint.context.rosterVersion || actual.policyVersion < prior.checkpoint.context.policyVersion
          || status.checkpoint.authorizationVersion < prior.checkpoint.authorizationVersion
          || status.state === prior.state && !same(status, prior))) fail('LOCAL_TRANSFER_STATUS_CHANGED');
        await saveBox(item.descriptor, value => ({ ...value, mutations: { ...value.mutations,
          [requestId]: { ...value.mutations[requestId], transferStatus: copy(status) } } }), guard);
        return { boxId, requestId, transferStatus: copy(status), transferPlan: copy(saved.transferPlan || null) };
      }),
      refreshDataEffect: ({ boxId, requestId }) => run(async guard => {
        const item = box(boxId); const saved = item.mutations?.[requestId];
        if (!saved?.ack) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
        const self = await selfBinding(item, guard);
        if (!self.active) fail('LOCAL_TRUST_BINDING_INACTIVE');
        const effect = (await read(item, 'data-effect', requestId, guard)).body;
        return { boxId, requestId, dataEffect: copy(effect) };
      }),
    },
  };
}
