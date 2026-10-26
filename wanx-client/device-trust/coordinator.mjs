import { randomBytes } from 'node:crypto';
import { createIdentityVault } from './identity-vault.mjs';
import { createPinnedTransport } from './pinned-transport.mjs';
import { createLedgerCoordinator } from './ledger-coordinator.mjs';
import {
  parseDeliveryPacket, parseJoinInfo, parseInvitation, validateDescriptor,
  verifyResponse, firstRootDigest,
} from './management-contract.mjs';
import {
  publicKeyThumbprint, requestDigest, verifyRequestProof,
  validateRequestContext, verifyApprovalSignature,
} from './binding-contract.mjs';

const copy = value => structuredClone(value);
const id = () => randomBytes(32).toString('base64url');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const checkpoint = value => Object.fromEntries(
  ['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion']
    .filter(key => key in value).map(key => [key, value[key]]),
);

// This object lives only in Electron main. The dedicated window exposes fixed
// business operations; no renderer supplies trusted state, keys or signing bytes.
export async function createDeviceTrustCoordinator({
  directory, protectDirectory, clock = Date.now,
  vault = createIdentityVault({ directory, protectDirectory, clock }),
  transportFactory = descriptor => createPinnedTransport({ descriptor }),
  ledgerTransportFactory = descriptor => createPinnedTransport({ descriptor, protocolVersion: 2 }),
  files, backupFiles, ensureBackupNamespace,
} = {}) {
  let generation = 0;
  let busy = false;
  let review = null;
  let loadError = null;
  let closed = false;
  let ledger;
  const inflight = new Set();
  try { await vault.load(); } catch (error) { loadError = error.code || 'LOCAL_IDENTITY_STORAGE_UNAVAILABLE'; }
  const now = () => Math.floor(clock() / 1000);
  const requireProfile = () => {
    if (closed) fail('LOCAL_TRUST_CLOSED');
    if (loadError) fail(loadError);
    const state = vault.snapshot();
    if (!state.exists || state.locked) fail('LOCAL_IDENTITY_LOCKED');
    return state.profile;
  };
  const state = () => {
    requireProfile();
    const value = vault.readState();
    if (value?.schemaVersion !== 1 || !value.boxes || Array.isArray(value.boxes)) fail('LOCAL_IDENTITY_STATE_INVALID');
    return value;
  };
  const box = boxId => {
    const value = state().boxes[boxId];
    if (!value || !Object.hasOwn(state().boxes, boxId)) fail('LOCAL_TRUST_BOX_UNKNOWN');
    return value;
  };
  const lock = (reason = 'manual') => {
    generation += 1;
    review = null;
    ledger?.invalidate(reason);
    for (const abort of inflight) abort.abort();
    vault.lock(reason);
  };
  const run = async operation => {
    if (closed) fail('LOCAL_TRUST_CLOSED');
    if (loadError) fail(loadError);
    if (busy) fail('LOCAL_TRUST_BUSY');
    busy = true;
    const captured = generation;
    const guard = () => {
      if (captured !== generation) fail('LOCAL_TRUST_CONTEXT_CHANGED');
      requireProfile();
    };
    try { return await operation(guard); } finally { busy = false; }
  };
  const send = async (descriptor, path, input, kind, guard, expected) => {
    guard();
    const abort = new AbortController();
    inflight.add(abort);
    try {
      const jws = await transportFactory(descriptor).request(path, input, { signal: abort.signal });
      guard();
      const response = verifyResponse(jws, { descriptor, kind, now: now(), expected });
      return { body: response.body, jws };
    } finally { inflight.delete(abort); }
  };
  const saveBox = async (descriptor, update, guard) => {
    guard();
    const value = state();
    const existing = value.boxes[descriptor.boxId];
    if (existing && !equal(validateDescriptor(existing.descriptor), validateDescriptor(descriptor))) fail('LOCAL_TRUST_PIN_CHANGED');
    const next = update(copy(existing || { descriptor, role: 'pending', principalId: null, checkpoint: null, requests: {} }));
    Object.defineProperty(value.boxes, descriptor.boxId, { value: next, enumerable: true, writable: true, configurable: true });
    await vault.writeState(value);
    guard();
  };
  const assertCheckpoint = (saved, current) => {
    if (!saved) return;
    if (saved.ownershipEpoch !== current.ownershipEpoch || current.policyVersion < saved.policyVersion
      || current.rosterVersion < saved.rosterVersion
      || (current.rosterVersion === saved.rosterVersion && current.rosterDigest !== saved.rosterDigest)) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
  };
  const pinContext = async (descriptor, context, guard) => {
    const existing = state().boxes[descriptor.boxId];
    if (existing) assertCheckpoint(existing.checkpoint, context);
    await saveBox(descriptor, item => ({ ...item, checkpoint: checkpoint(context) }), guard);
  };
  const read = async (item, operation, requestId, guard) => {
    if (operation === 'request') item = box(item.descriptor.boxId);
    const challenge = operation === 'request' && item.ledgerVersion === 2 && item.bindingId
      ? await ledger.managerReadChallenge(item, guard) : null;
    const auth = challenge ? { ...challenge, ownershipEpoch: challenge.context.ownershipEpoch }
      : (await send(item.descriptor, '/auth/challenge', {}, 'auth-challenge', guard)).body;
    if (item.checkpoint && auth.ownershipEpoch !== item.checkpoint.ownershipEpoch) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    const proof = vault.signRead({
      schemaVersion: 1, purpose: 'centuarai.local-management.read',
      boxId: item.descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey),
      ownershipEpoch: auth.ownershipEpoch, nonce: auth.nonce,
      issuedAt: auth.issuedAt, expiresAt: auth.expiresAt,
      clientId: requireProfile().clientId, operation, requestId,
    });
    return send(item.descriptor, operation === 'state' ? '/state' : '/requests/read', { proof }, operation, guard,
      operation === 'request' ? { requestId } : undefined);
  };
  const managerState = async (item, guard) => {
    if (item.ledgerVersion === 2) return ledger.managerState(item, guard);
    let body;
    try { body = (await read(item, 'state', null, guard)).body; }
    catch (error) {
      if (error.code === 'LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED') return ledger.managerState(item, guard);
      throw error;
    }
    assertCheckpoint(item.checkpoint, body.context);
    const profile = requireProfile();
    const own = body.bindings.find(binding => binding.clientId === profile.clientId
      && binding.principalId === item.principalId && binding.role === 'manage' && binding.status === 'active'
      && publicKeyThumbprint(binding.accessKey) === publicKeyThumbprint(profile.accessKey)
      && binding.approvalKey && publicKeyThumbprint(binding.approvalKey) === publicKeyThumbprint(profile.approvalKey));
    if (!own || !own.canApproveUseDevices || (own.expiresAt !== null && own.expiresAt <= now())
      || (own.delegationExpiresAt !== null && own.delegationExpiresAt <= now())) fail('LOCAL_TRUST_MANAGER_REQUIRED');
    await pinContext(item.descriptor, body.context, guard);
    return { ...body, own };
  };
  const presentReview = (kind, descriptor, payload, extra = {}) => {
    const visible = {
      reviewHandle: id(), kind, boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey),
      principalId: payload.principalId, clientId: payload.clientId, role: kind === 'first-root' ? 'manage' : 'use',
      grants: copy(payload.grants), grantExpiresAt: payload.grantExpiresAt, expiresAt: payload.expiresAt,
      requestId: payload.requestId, requestDigest: kind === 'first-root' ? firstRootDigest(payload) : requestDigest(payload),
      accessKeyThumbprint: publicKeyThumbprint(payload.accessKey), ownershipEpoch: payload.ownershipEpoch,
      ...(payload.rosterVersion ? { rosterVersion: payload.rosterVersion } : {}), ...extra,
    };
    return visible;
  };
  const takeReview = (handle, kind, guard) => {
    guard();
    if (!review || review.visible.reviewHandle !== handle || review.visible.kind !== kind
      || review.generation !== generation || review.visible.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED');
    const selected = review;
    review = null;
    return selected;
  };
  const ackResult = async (descriptor, jws, payload, digest, guard, { own = true } = {}) => {
    const expected = {
      requestId: payload.requestId, requestDigest: digest, principalId: payload.principalId, clientId: payload.clientId,
      role: payload.purpose === 'centuarai.local-management.first-root' ? 'manage' : 'use',
      accessKeyThumbprint: publicKeyThumbprint(payload.accessKey), ownershipEpoch: payload.ownershipEpoch,
    };
    if ('policyVersion' in payload) expected.policyVersion = payload.policyVersion;
    const ack = verifyResponse(jws, { descriptor, kind: 'binding-ack', now: now(), expected }).body;
    if ('rosterVersion' in payload && ack.rosterVersion <= payload.rosterVersion) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    // An older saved receipt may be retrieved after subsequent commits; it must
    // never replace a newer checkpoint. Equal versions must have equal digests.
    await saveBox(descriptor, item => {
      const prior = item.checkpoint;
      if (prior && (prior.ownershipEpoch !== ack.ownershipEpoch
        || (prior.rosterVersion === ack.rosterVersion && prior.rosterDigest !== ack.rosterDigest))) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
      const newer = !prior || ack.rosterVersion >= prior.rosterVersion;
      if (prior && newer && ack.policyVersion < prior.policyVersion) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
      return {
        ...item, ...(own ? { role: ack.role, principalId: ack.principalId, bindingId: ack.bindingId } : {}),
        checkpoint: newer ? { ...checkpoint(ack), boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey) } : prior,
        requests: { ...item.requests, [payload.requestId]: { payload, digest, state: 'approved', ack: jws, own } },
      };
    }, guard);
    return { boxId: descriptor.boxId, requestId: payload.requestId, state: 'approved', ack };
  };
  const invitation = (descriptor, payload) => JSON.stringify({
    schemaVersion: 1, type: 'centuarai-local-trust-invitation', descriptor,
    requestId: payload.requestId, requestDigest: requestDigest(payload),
  });

  ledger = createLedgerCoordinator({ vault, state, box, saveBox, assertCheckpoint, run,
    requireProfile, clock, transportFactory: ledgerTransportFactory, files, backupFiles, ensureBackupNamespace });
  const unsubscribeVault = vault.subscribe?.(event => {
    if (event.type !== 'locked') return;
    generation += 1; review = null; ledger.invalidate(event.reason);
    for (const abort of inflight) abort.abort();
  });

  return {
    ...ledger.api,
    snapshot() {
      const meta = vault.snapshot();
      const saved = !loadError && meta.exists && !meta.locked ? state() : { boxes: {} };
      return {
        profile: meta.profile ? { ...meta.profile, locked: meta.locked } : null,
        busy, error: loadError,
        boxes: Object.values(saved.boxes).map(item => ({
          boxId: item.descriptor.boxId, role: item.role, bindingId: item.bindingId,
          boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey),
        })),
        requests: Object.values(saved.boxes).flatMap(item => Object.entries(item.requests).map(([requestId, request]) => ({
          boxId: item.descriptor.boxId, requestId, state: request.state,
        }))),
        securityOperations: !loadError && meta.exists && !meta.locked ? ledger.snapshot() : [],
      };
    },
    createProfile: input => run(async () => vault.createProfile(input)),
    unlock: input => run(async () => vault.unlock(input)),
    lock,
    close: () => { lock('close'); closed = true; unsubscribeVault?.(); vault.close(); },
    prepareFirstRoot: ({ deliveryPacket }) => run(async guard => {
      const packet = parseDeliveryPacket(deliveryPacket);
      const descriptor = validateDescriptor({ boxId: packet.boxId, baseUrl: packet.baseUrl, boxKey: packet.boxKey, tlsSpkiSha256: packet.tlsSpkiSha256 });
      const existing = state().boxes[descriptor.boxId];
      if (existing && (!equal(existing.descriptor, descriptor) || existing.role !== 'pending')) fail('LOCAL_TRUST_ALREADY_KNOWN');
      const challenge = (await send(descriptor, '/first-root/challenge', {}, 'first-root-challenge', guard,
        { provisioningId: packet.provisioningId, ownershipEpoch: packet.ownershipEpoch })).body;
      const profile = requireProfile();
      const payload = {
        schemaVersion: 1, purpose: 'centuarai.local-management.first-root', boxId: packet.boxId,
        boxKeyThumbprint: publicKeyThumbprint(packet.boxKey), provisioningId: packet.provisioningId,
        ownershipEpoch: packet.ownershipEpoch, challenge: challenge.challenge, requestId: id(),
        issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, principalId: profile.principalId,
        clientId: profile.clientId, accessKey: profile.accessKey, approvalKey: profile.approvalKey,
        grants: challenge.grants, grantExpiresAt: null, keyProtection: 'software-passphrase-v1',
      };
      const visible = presentReview('first-root', descriptor, payload);
      review = { visible, descriptor, payload, claimSecret: packet.claimSecret, generation };
      return copy(visible);
    }),
    confirmFirstRoot: ({ reviewHandle, passphrase }) => run(async guard => {
      const selected = takeReview(reviewHandle, 'first-root', guard);
      const live = () => { guard(); if (selected.payload.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED'); };
      const proofs = await vault.signFirstRoot({ payload: selected.payload, claimSecret: selected.claimSecret, passphrase, guard: live });
      selected.claimSecret = null;
      live();
      await saveBox(selected.descriptor, item => ({ ...item, principalId: selected.payload.principalId,
        requests: { ...item.requests, [selected.payload.requestId]: {
          payload: selected.payload, digest: selected.visible.requestDigest, proofs, state: 'submitting', own: true,
        } },
      }), live);
      const response = await send(selected.descriptor, '/first-root/commit', proofs, 'binding-ack', live);
      return ackResult(selected.descriptor, response.jws, selected.payload, selected.visible.requestDigest, guard);
    }),
    exportJoinInfo: ({ boxId }) => run(async guard => {
      const item = box(boxId);
      const current = await managerState(item, guard);
      const deadlines = [current.own.expiresAt, current.own.delegationExpiresAt].filter(value => value !== null);
      return { joinInfo: JSON.stringify({
        schemaVersion: 1, type: 'centuarai-local-trust-join', descriptor: item.descriptor,
        principalId: item.principalId, grants: current.own.delegableGrants,
        grantExpiresAt: deadlines.length ? Math.min(...deadlines) : null,
      }) };
    }),
    prepareJoin: ({ joinInfo }) => run(async guard => {
      const info = parseJoinInfo(joinInfo);
      const profile = requireProfile();
      const known = state().boxes[info.descriptor.boxId];
      if (known && (!equal(known.descriptor, info.descriptor) || known.role !== 'pending')) fail('LOCAL_TRUST_ALREADY_KNOWN');
      const challenge = (await send(info.descriptor, '/requests/challenge', {}, 'binding-challenge', guard)).body;
      if (known) assertCheckpoint(known.checkpoint, challenge.context);
      const payload = {
        ...challenge.context, schemaVersion: 1, purpose: 'centuarai.local-device-binding.request',
        requestId: id(), challenge: challenge.challenge, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
        principalId: info.principalId, clientId: profile.clientId, accessKey: profile.accessKey, approvalKey: null,
        role: 'use', grants: info.grants, grantExpiresAt: info.grantExpiresAt, delegationAllowed: false,
      };
      const visible = presentReview('join', info.descriptor, payload);
      review = { visible, descriptor: info.descriptor, payload, generation };
      return copy(visible);
    }),
    submitJoin: ({ reviewHandle }) => run(async guard => {
      const selected = takeReview(reviewHandle, 'join', guard);
      const requestProof = vault.signBinding(selected.payload);
      await saveBox(selected.descriptor, item => ({ ...item, principalId: selected.payload.principalId,
        checkpoint: checkpoint(selected.payload), requests: { ...item.requests, [selected.payload.requestId]: {
          payload: selected.payload, digest: selected.visible.requestDigest, requestProof, state: 'submitting', own: true,
        } },
      }), guard);
      const receipt = (await send(selected.descriptor, '/requests', { requestProof }, 'request-receipt', guard,
        { requestId: selected.payload.requestId, requestDigest: selected.visible.requestDigest })).body;
      await saveBox(selected.descriptor, item => {
        item.requests[selected.payload.requestId].state = receipt.state; return item;
      }, guard);
      return { boxId: selected.descriptor.boxId, ...receipt, invitation: invitation(selected.descriptor, selected.payload) };
    }),
    prepareApproval: ({ invitation: input }) => run(async guard => {
      const info = parseInvitation(input);
      const item = box(info.descriptor.boxId);
      if (!equal(item.descriptor, info.descriptor)) fail('LOCAL_TRUST_PIN_CHANGED');
      const current = await managerState(item, guard);
      const pending = (await read(item, 'request', info.requestId, guard)).body;
      if (pending.state !== 'pending') fail('LOCAL_TRUST_REQUEST_TERMINAL');
      const payload = verifyRequestProof(pending.requestJws);
      if (requestDigest(payload) !== info.requestDigest || pending.requestDigest !== info.requestDigest
        || payload.requestId !== info.requestId || payload.principalId !== item.principalId) fail('LOCAL_TRUST_REQUEST_CHANGED');
      validateRequestContext(payload, { ...current.context, challenge: payload.challenge }, now());
      const visible = presentReview('approval', item.descriptor, payload, { approverBindingId: current.own.bindingId });
      review = { visible, descriptor: item.descriptor, payload, requestJws: pending.requestJws, current, generation };
      return copy(visible);
    }),
    confirmApproval: ({ reviewHandle, passphrase }) => run(async guard => {
      const selected = takeReview(reviewHandle, 'approval', guard);
      const live = () => { guard(); if (selected.payload.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED'); };
      const current = await managerState(box(selected.descriptor.boxId), live);
      if (!equal(current.context, selected.current.context)) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
      const payload = {
        schemaVersion: 1, purpose: 'centuarai.local-device-binding.approval', requestDigest: selected.visible.requestDigest,
        approverBindingId: current.own.bindingId, approvalKeyVersion: current.own.approvalKeyVersion,
        approvedAt: now(), expiresAt: selected.payload.expiresAt,
      };
      const approvalProof = await vault.signApproval({ payload, passphrase, guard: live });
      live();
      const latest = await managerState(box(selected.descriptor.boxId), live);
      if (!equal(latest.context, selected.current.context)) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
      verifyApprovalSignature(approvalProof, selected.requestJws,
        { ...latest.context, bindings: latest.bindings }, now());
      await saveBox(selected.descriptor, item => ({ ...item, requests: { ...item.requests, [selected.payload.requestId]: {
        payload: selected.payload, digest: selected.visible.requestDigest, state: 'approving', own: false,
      } } }), live);
      const response = await send(selected.descriptor, '/requests/approve',
        { requestId: selected.payload.requestId, approvalProof }, 'binding-ack', live);
      return ackResult(selected.descriptor, response.jws, selected.payload, selected.visible.requestDigest, guard, { own: false });
    }),
    refreshRequest: ({ boxId, requestId }) => run(async guard => {
      const item = box(boxId);
      const saved = item.requests[requestId];
      if (!saved || !Object.hasOwn(item.requests, requestId)) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
      if (saved.payload.purpose === 'centuarai.local-management.first-root') {
        if (saved.ack) {
          // A stored ACK proves a past commit, not current management authority.
          // Refresh on the box before presenting it as a current result.
          await managerState(item, guard);
          return ackResult(item.descriptor, saved.ack, saved.payload, saved.digest, guard);
        }
        const response = await send(item.descriptor, '/first-root/commit', saved.proofs, 'binding-ack', guard);
        return ackResult(item.descriptor, response.jws, saved.payload, saved.digest, guard);
      }
      if (saved.state === 'submitting') {
        await send(item.descriptor, '/requests', { requestProof: saved.requestProof }, 'request-receipt', guard,
          { requestId, requestDigest: saved.digest });
      }
      const pending = (await read(item, 'request', requestId, guard)).body;
      if (pending.requestDigest !== saved.digest || requestDigest(verifyRequestProof(pending.requestJws)) !== saved.digest)
        fail('LOCAL_TRUST_REQUEST_CHANGED');
      if (pending.ack) return ackResult(item.descriptor, pending.ack, saved.payload, saved.digest, guard, { own: saved.own });
      await saveBox(item.descriptor, value => { value.requests[requestId].state = pending.state; return value; }, guard);
      return { boxId, requestId, state: pending.state, ack: null,
        ...(saved.own ? { invitation: invitation(item.descriptor, saved.payload) } : {}) };
    }),
    cancelRequest: ({ boxId, requestId }) => run(async guard => {
      const item = box(boxId);
      const saved = item.requests[requestId];
      if (!saved?.own || saved.payload.purpose !== 'centuarai.local-device-binding.request') fail('LOCAL_TRUST_CANCEL_FORBIDDEN');
      const issuedAt = now();
      const cancelProof = vault.signCancel({ schemaVersion: 1, purpose: 'centuarai.local-device-binding.cancel',
        requestId, requestDigest: saved.digest, issuedAt, expiresAt: issuedAt + 60 });
      const response = (await send(item.descriptor, '/requests/cancel', { cancelProof }, 'request-receipt', guard,
        { requestId, requestDigest: saved.digest })).body;
      await saveBox(item.descriptor, value => { value.requests[requestId].state = response.state; return value; }, guard);
      return { boxId, requestId, state: response.state, ack: null };
    }),
    refreshDevices: ({ boxId }) => run(async guard => {
      const current = await managerState(box(boxId), guard);
      return { boxId, recoveryConfigured: current.recoveryConfigured,
        devices: current.bindings.map(binding => ({ bindingId: binding.bindingId, clientId: binding.clientId,
          role: binding.role, status: binding.status, expiresAt: binding.expiresAt,
          accessKeyThumbprint: publicKeyThumbprint(binding.accessKey) })) };
    }),
  };
}
