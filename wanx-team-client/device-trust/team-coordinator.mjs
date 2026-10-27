import { randomBytes, randomUUID } from 'node:crypto';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { validateDescriptor } from './management-contract.mjs';
import { canonicalLedger, ledgerDigest, mutationDigest, validateLedgerMutation, validateTeamMembershipRequest,
  verifyLedgerResponse, verifyLedgerTargetProofs, verifyTeamIdentityProof } from './ledger-contract.mjs';

const copy = value => structuredClone(value);
const id = () => randomBytes(32).toString('base64url');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalLedger(a) === canonicalLedger(b);
const checkpoint = value => Object.fromEntries(['boxId', 'boxKeyThumbprint', 'ownershipEpoch', 'rosterVersion', 'rosterDigest', 'policyVersion'].map(key => [key, value[key]]));
const targetFor = (profile, policy) => ({ clientId: profile.clientId, accessKey: profile.accessKey,
  approvalKey: profile.approvalKey, keyProtection: 'software-passphrase-v1', ...copy(policy) });
export function effectiveTeamAuthority(current, now) {
  const { own, projection, context } = current;
  const live = value => value === null || value > now;
  const bindings = new Map(projection.bindings.map(item => [item.bindingId, item]));
  const bindingLive = (row, delegation, seen = new Set()) => {
    if (!row || seen.has(row.bindingId) || row.status !== 'active' || row.ownershipEpoch !== context.ownershipEpoch
      || !live(row.expiresAt) || (delegation && !live(row.delegationExpiresAt))) return false;
    if (row.createdByBindingId === null) return true;
    const parent = bindings.get(row.createdByBindingId);
    return parent && bindingLive(parent, true, new Set([...seen, row.bindingId]));
  };
  const records = new Map(projection.grants.map(item => [item.grantId, item]));
  const grants = delegation => {
    const valid = (row, seen = new Set()) => row && !seen.has(row.grantId) && row.status === 'active'
      && row.ownershipEpoch === context.ownershipEpoch && live(row.expiresAt)
      && (!delegation || live(row.delegationExpiresAt))
      && (row.sourceBindingId === null || bindingLive(bindings.get(row.sourceBindingId), true))
      && row.sourceGrantIds.every(source => valid(records.get(source), new Set([...seen, row.grantId])));
    if (!bindingLive(own, delegation)) return [];
    const ceilings = [...records.values()].filter(row => row.bindingId === null && row.principalId === own.principalId && valid(row));
    const result = new Map();
    for (const row of records.values()) if (row.bindingId === own.bindingId && valid(row)) {
      const ceiling = ceilings.filter(item => item.resourceNamespaceId === row.resourceNamespaceId);
      const actions = new Set(ceiling.flatMap(item => item.actions));
      const delegates = new Set(ceiling.flatMap(item => item.delegableActions));
      const permitted = row.actions.filter(action => actions.has(action) && (!delegation || row.delegableActions.includes(action) && delegates.has(action)));
      if (permitted.length) result.set(row.resourceId, new Set([...(result.get(row.resourceId) || []), ...permitted]));
    }
    return [...result].sort(([a], [b]) => a < b ? -1 : 1).map(([resourceId, actions]) => ({ resourceId, actions: [...actions].sort() }));
  };
  return { capabilities: copy(own.capabilities), grants: grants(false), delegableGrants: grants(true),
    expiresAt: own.expiresAt, delegationExpiresAt: own.delegationExpiresAt };
}

// Only main owns cloud credentials, pinned authority and signing state. Login
// proves a Consumer identity; the independent local approval remains mandatory.
export function createTeamCoordinator({ account, vault, box, state, saveBox, run, requireProfile, now,
  prepare, reviews, takeReview, read, send, principalState, selfBinding, commit, assertCheckpoint, visibleReview }) {
  const drafts = new Map();
  let generation = 0;
  const cloudIdentity = () => {
    const value = account?.snapshot();
    if (value?.phase !== 'authenticated' || !value.accountId || !value.clientId) fail('TEAM_CLOUD_LOGIN_REQUIRED');
    return { accountId: value.accountId, clientId: value.clientId };
  };
  const cloudGuard = guard => {
    const expected = cloudIdentity();
    return () => { guard(); if (!same(expected, cloudIdentity())) fail('TEAM_CLOUD_ACCOUNT_CHANGED'); };
  };
  const cloudProof = async (deviceId, descriptor, request, guard) => {
    const current = cloudIdentity(), nonce = id(), requestId = id();
    const policy = (await send(descriptor, '/team/policy', {}, 'team-policy', guard)).body;
    if (policy.context.ownershipEpoch !== request.ownershipEpoch) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
    const proof = await account.request({ method: 'POST', path: '/app-api/v1/team/identity-proofs', body: {
      deviceId, boxId: request.boxId, boxKeyThumbprint: request.boxKeyThumbprint, ownershipEpoch: request.ownershipEpoch,
      requestDigest: ledgerDigest(request), invitationId: request.invitationId, targetAccessKey: request.target.accessKey,
      targetApprovalKey: request.target.approvalKey, nonce, requestId,
    } });
    guard();
    if (!proof || Object.keys(proof).sort().join(',') !== 'associationId,expiresAt,proof,requestId'
      || proof.requestId !== requestId || typeof proof.associationId !== 'string') fail('TEAM_CLOUD_RESPONSE_INVALID');
    const claims = verifyTeamIdentityProof(proof.proof, { policy: policy.policy, request, ...current, nonce, now: now() });
    if (proof.expiresAt !== claims.expiresAt) fail('TEAM_CLOUD_RESPONSE_INVALID');
    return { ...proof, subject: claims.subject, cloudPolicy: policy.policy, context: policy.context };
  };
  const requestFor = (descriptor, epoch, principalId, target, invitationId = null) => validateTeamMembershipRequest({
    schemaVersion: 1, purpose: 'centuarai.team-membership.request', boxId: descriptor.boxId,
    boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), ownershipEpoch: epoch, invitationId, principalId, target,
  });
  const requestRead = async (item, requestId, guard) => {
    const pending = item.teamRequests?.[requestId];
    if (!pending) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
    const issuedAt = now();
    const proof = vault.signTeamRequestRead({ schemaVersion: 1, purpose: 'centuarai.team-request.read',
      boxId: item.descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey),
      ownershipEpoch: pending.request.ownershipEpoch, requestId, nonce: id(), issuedAt, expiresAt: issuedAt + 60 });
    const result = (await send(item.descriptor, '/team/requests/read', { proof }, 'team-request', guard, { requestId })).body;
    if (!same(result.request, pending.request) || result.cloudProof !== pending.cloudProof) fail('TEAM_REQUEST_CHANGED');
    return result;
  };
  const syncAssociation = async (item, guard) => {
    const member = (await read(item, 'self-member', null, guard)).body.member;
    if (!member) fail('TEAM_MEMBER_REQUIRED');
    const receipt = (await read(item, 'team-association', member.membershipId, guard)).body.receipt;
    let projection = null;
    try { projection = await account.request({ method: 'POST', path: '/app-api/v1/team/associations/sync', body: { receipt } }); }
    catch { guard(); }
    guard();
    await saveBox(item.descriptor, value => ({ ...value, teamMember: member, teamAssociation: { receipt, projection } }), guard);
    return { member, deliveryStatus: projection?.deliveryStatus || 'deviceAckPending' };
  };
  const finishJoin = async (item, pending, result, guard) => {
    if (!result.receipt) return null;
    const mutation = validateLedgerMutation(pending.consentedMutation);
    if (!pending.consentedMutation) fail('TEAM_TARGET_CONSENT_REQUIRED');
    if (!same(mutation.args.request, pending.request) || mutation.args.cloudProof !== pending.cloudProof
      || mutation.action !== 'team.member-admit') fail('TEAM_REQUEST_CHANGED');
    const ack = verifyLedgerResponse(result.receipt, { descriptor: item.descriptor, kind: 'mutation-ack', now: now(), expected: {
      requestId: mutation.requestId, action: mutation.action, mutationDigest: mutationDigest(mutation), effectsDigest: mutation.effectsDigest,
    } }).body;
    if (ack.result.principalId !== pending.request.principalId || !ack.result.bindingId
      || ack.ownershipEpoch !== pending.request.ownershipEpoch || ack.rosterVersion <= mutation.rosterVersion) fail('TEAM_REQUEST_CHANGED');
    assertCheckpoint(item.checkpoint, checkpoint({ ...ack, boxId: item.descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey) }));
    await saveBox(item.descriptor, value => ({ ...value, ledgerVersion: 2, role: 'manage', principalId: pending.request.principalId,
      bindingId: ack.result.bindingId, approvalKeyVersion: 1,
      checkpoint: checkpoint({ ...ack, boxId: item.descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(item.descriptor.boxKey) }),
      teamRequests: { ...value.teamRequests, [result.requestId]: { ...pending, state: 'approved', receipt: result.receipt } },
    }), guard);
    const self = await selfBinding(box(item.descriptor.boxId), guard);
    const association = await syncAssociation(box(item.descriptor.boxId), guard);
    return { boxId: item.descriptor.boxId, requestId: result.requestId, state: 'approved', self, ...association };
  };
  return {
    invalidate() { generation += 1; drafts.clear(); },
    async attachConfirmation(selected, passphrase, guard) {
      const mutation = selected.mutation;
      if (['team.activate', 'team.member-link'].includes(mutation.action) || mutation.action === 'team.device-resources' && mutation.args.bindingId === box(mutation.boxId).bindingId) {
        selected.targetProofs = await vault.signLedgerTarget({ payload: mutation, passphrase, guard });
      } else if (mutation.action === 'team.device-resources') {
        if (!selected.targetProofs) fail('LOCAL_TRUST_ADDITIONAL_PROOF_REQUIRED');
      } else if (mutation.action === 'team.member-admit') {
        const requestId = ledgerDigest(mutation.args.request);
        const current = (await read(box(mutation.boxId), 'team-request', requestId, guard)).body;
        if (!current.review || !same(verifyLedgerResponse(current.review, { descriptor: selected.descriptor,
          kind: 'mutation-review', now: now() }).body.mutation, mutation)) fail('TEAM_TARGET_CONSENT_REQUIRED');
        if (!current.targetAccessProof || !current.targetApprovalProof) fail('TEAM_TARGET_CONSENT_REQUIRED');
        selected.targetProofs = verifyLedgerTargetProofs({ targetAccessProof: current.targetAccessProof,
          targetApprovalProof: current.targetApprovalProof }, mutation, now());
      }
    },
    api: {
      prepareTeamKnowledgeResource: ({ boxId }) => run(guard => { const item = box(boxId); return prepare(boxId, 'team.resource-set', { resourceId: 'team:knowledge:' + randomUUID(), expectedRevision: 0, grants: [{ principalId: item.principalId, actions: ['read', 'write'] }] }, guard); }),
      prepareTeamResourceAccess: ({ boxId, resourceId, grants }) => run(async guard => {
        const current = (await read(box(boxId), 'team-state', null, guard)).body;
        const resource = current.resources.find(item => item.resourceId === resourceId); if (!resource) fail('TEAM_RESOURCE_UNKNOWN');
        return prepare(boxId, 'team.resource-set', { resourceId, expectedRevision: resource.revision, grants }, guard);
      }),
      exportTeamDeviceResourceInfo: ({ boxId }) => run(async guard => ({ resourceInfo: (await read(box(boxId), 'self-resources', null, guard)).jws })),
      prepareTeamRemoteDeviceResource: ({ boxId, resourceInfo, resourceId }) => run(async guard => {
        const item = box(boxId), response = verifyLedgerResponse(resourceInfo, { descriptor: item.descriptor, kind: 'self-resources', now: now() }).body;
        const grant = response.availableGrants.find(row => row.resourceId === resourceId); if (!grant) fail('TEAM_RESOURCE_APPROVAL_REQUIRED');
        const grants = [...response.approvedGrants.filter(row => row.resourceId !== resourceId), grant].sort((a, b) => a.resourceId < b.resourceId ? -1 : 1);
        const current = await principalState(item, guard); if (!same(current.context, response.context)) fail('LOCAL_TRUST_CHECKPOINT_CHANGED');
        return prepare(boxId, 'team.device-resources', { principalId: response.principalId, bindingId: response.bindingId, expectedBindingRevision: response.bindingRevision, grants }, guard);
      }),
      prepareTeamDeviceResource: ({ boxId, resourceId }) => run(async guard => {
        const item = box(boxId), response = (await read(item, 'self-resources', null, guard)).body;
        if (response.principalId !== item.principalId || response.bindingId !== item.bindingId) fail('LOCAL_LEDGER_SCOPE_MISMATCH');
        const grant = response.availableGrants.find(row => row.resourceId === resourceId); if (!grant) fail('TEAM_RESOURCE_APPROVAL_REQUIRED');
        const grants = [...response.approvedGrants.filter(row => row.resourceId !== resourceId), grant].sort((a, b) => a.resourceId < b.resourceId ? -1 : 1);
        return prepare(boxId, 'team.device-resources', { principalId: item.principalId, bindingId: item.bindingId, expectedBindingRevision: response.bindingRevision, grants }, guard);
      }),
      prepareTeamActivation: ({ boxId, deviceId }) => run(async outer => {
        const guard = cloudGuard(outer), item = box(boxId), current = await principalState(item, guard);
        const policy = effectiveTeamAuthority(current, now());
        policy.grants = [...policy.grants.filter(grant => grant.resourceId !== 'team:management'),
          { resourceId: 'team:management', actions: ['execute', 'read', 'write'] }].sort((a, b) => a.resourceId < b.resourceId ? -1 : 1);
        const request = requestFor(item.descriptor, current.context.ownershipEpoch, item.principalId, targetFor(requireProfile(), policy));
        const proof = await cloudProof(deviceId, item.descriptor, request, guard);
        const visible = await prepare(boxId, 'team.activate', { request, cloudProof: proof.proof, cloudPolicy: proof.cloudPolicy }, guard);
        reviews.get(visible.reviewHandle).cloudIdentity = cloudIdentity();
        return visible;
      }),
      prepareTeamLink: ({ boxId, deviceId }) => run(async outer => {
        const guard = cloudGuard(outer), item = box(boxId), current = await principalState(item, guard);
        const request = requestFor(item.descriptor, current.context.ownershipEpoch, item.principalId, targetFor(requireProfile(), effectiveTeamAuthority(current, now())));
        const proof = await cloudProof(deviceId, item.descriptor, request, guard);
        const visible = await prepare(boxId, 'team.member-link', { request, cloudProof: proof.proof }, guard);
        reviews.get(visible.reviewHandle).cloudIdentity = cloudIdentity(); return visible;
      }),
      refreshTeam: ({ boxId }) => run(async guard => {
        const item = box(boxId), self = (await read(item, 'self-resources', null, guard)).body;
        if (self.principalId !== item.principalId || self.bindingId !== item.bindingId) fail('LOCAL_LEDGER_SCOPE_MISMATCH');
        const membership = (await read(item, 'self-member', null, guard)).body;
        if (!membership.member || membership.member.status !== 'active') fail('TEAM_MEMBER_REQUIRED');
        const manageTeam = ['owner', 'manager'].includes(membership.member.roleId);
        const team = manageTeam ? (await read(item, 'team-state', null, guard)).body : { context: membership.context,
          members: [membership.member], invitations: [], requests: [], resources: [] };
        return { boxId, ...team, manageTeam, selfResources: self, authority: { grants: self.approvedGrants } };
      }),
      refreshTeamAssociation: ({ boxId }) => run(guard => syncAssociation(box(boxId), guard)),
      prepareTeamInvite: ({ boxId, roleId, grants, delegableGrants, capabilities, expiresAt, delegationExpiresAt }) => run(guard =>
        prepare(boxId, 'team.invite-create', { invitationId: id(), roleId,
          targetPolicy: { grants, delegableGrants, capabilities, expiresAt: delegationExpiresAt, delegationExpiresAt }, expiresAt }, guard)),
      prepareTeamInviteRevocation: ({ boxId, invitationId }) => run(guard => prepare(boxId, 'team.invite-revoke', { invitationId }, guard)),
      prepareTeamMemberRole: ({ boxId, principalId, roleId }) => run(guard => prepare(boxId, 'team.member-role', { principalId, roleId }, guard)),
      prepareTeamMemberSuspension: ({ boxId, principalId }) => run(guard => prepare(boxId, 'team.member-suspend', { principalId }, guard)),
      prepareTeamMemberRevocation: ({ boxId, principalId }) => run(guard => prepare(boxId, 'team.member-revoke', { principalId }, guard)),
      exportTeamInvitation: ({ boxId, requestId }) => run(async guard => {
        guard(); const item = box(boxId), saved = item.mutations?.[requestId];
        if (saved?.mutation.action !== 'team.invite-create' || !saved.ack) fail('LOCAL_TRUST_REQUEST_UNKNOWN');
        return { invitation: canonicalLedger({ schemaVersion: 1, type: 'centuarai-team-invitation', descriptor: item.descriptor,
          mutation: saved.mutation, receipt: saved.ack }) };
      }),
      prepareTeamJoin: ({ invitation, deviceId }) => run(async outer => {
        const guard = cloudGuard(outer); let packet;
        try { packet = JSON.parse(invitation); } catch { fail('TEAM_INVITATION_INVALID'); }
        if (!packet || Object.keys(packet).sort().join(',') !== 'descriptor,mutation,receipt,schemaVersion,type'
          || packet.schemaVersion !== 1 || packet.type !== 'centuarai-team-invitation') fail('TEAM_INVITATION_INVALID');
        const descriptor = validateDescriptor(packet.descriptor), mutation = validateLedgerMutation(packet.mutation);
        if (mutation.action !== 'team.invite-create' || mutation.boxId !== descriptor.boxId
          || mutation.boxKeyThumbprint !== publicKeyThumbprint(descriptor.boxKey) || mutation.args.expiresAt <= now()) fail('TEAM_INVITATION_INVALID');
        const ack = verifyLedgerResponse(packet.receipt, { descriptor, kind: 'mutation-ack', now: now(), expected: {
          requestId: mutation.requestId, mutationDigest: mutationDigest(mutation), action: mutation.action, effectsDigest: mutation.effectsDigest,
        } }).body;
        const known = state().boxes[descriptor.boxId];
        if (known && !same(known.descriptor, descriptor)) fail('LOCAL_TRUST_PIN_CHANGED');
        if (known?.bindingId) fail('LOCAL_TRUST_ALREADY_KNOWN');
        if (ack.ownershipEpoch !== mutation.ownershipEpoch || ack.rosterVersion <= mutation.rosterVersion) fail('TEAM_INVITATION_INVALID');
        const profile = requireProfile(), request = requestFor(descriptor, ack.ownershipEpoch, profile.principalId,
          targetFor(profile, mutation.args.targetPolicy), mutation.args.invitationId);
        const proof = await cloudProof(deviceId, descriptor, request, guard);
        const reviewHandle = id(), visible = { reviewHandle, kind: 'team-join', boxId: descriptor.boxId,
          boxKeyThumbprint: publicKeyThumbprint(descriptor.boxKey), principalId: request.principalId, subject: proof.subject,
          roleId: mutation.args.roleId, grants: request.target.grants, capabilities: request.target.capabilities,
          accessKeyThumbprint: publicKeyThumbprint(profile.accessKey), approvalKeyThumbprint: publicKeyThumbprint(profile.approvalKey),
          expiresAt: proof.expiresAt, requestId: ledgerDigest(request) };
        drafts.clear(); drafts.set(reviewHandle, { generation, descriptor, request, proof, visible, cloud: cloudIdentity() });
        return visible;
      }),
      submitTeamJoin: ({ reviewHandle, passphrase }) => run(async outer => {
        const guard = cloudGuard(outer), draft = drafts.get(reviewHandle);
        if (!draft || draft.generation !== generation || draft.proof.expiresAt <= now()
          || !same(draft.cloud, cloudIdentity())) fail('LOCAL_TRUST_REVIEW_EXPIRED');
        const proofs = await vault.signTeamRequest({ payload: draft.request, passphrase, guard }); guard();
        const requestId = ledgerDigest(draft.request), pending = { request: draft.request, cloudProof: draft.proof.proof,
          associationId: draft.proof.associationId, subject: draft.proof.subject, state: 'pending', proofs };
        await saveBox(draft.descriptor, item => ({ ...item, ledgerVersion: 2,
          teamRequests: { ...item.teamRequests, [requestId]: pending } }), guard);
        const result = (await send(draft.descriptor, '/team/requests', { ...proofs, cloudProof: pending.cloudProof },
          'team-request-receipt', guard, { requestId })).body;
        drafts.delete(reviewHandle); return { boxId: draft.descriptor.boxId, ...result };
      }),
      refreshTeamRequest: ({ boxId, requestId }) => run(async guard => {
        const item = box(boxId), pending = item.teamRequests?.[requestId];
        const result = await requestRead(item, requestId, guard);
        if (result.state === 'approved') return (await finishJoin(item, pending, result, guard)) || { boxId, requestId, state: 'approved', self: null };
        await saveBox(item.descriptor, value => ({ ...value, teamRequests: { ...value.teamRequests,
          [requestId]: { ...pending, state: result.state } } }), guard);
        if (!result.review) return { boxId, requestId, state: result.state };
        const review = verifyLedgerResponse(result.review, { descriptor: item.descriptor, kind: 'mutation-review', now: now() }).body;
        if (review.mutation.action !== 'team.member-admit' || !same(review.mutation.args.request, pending.request)
          || review.mutation.args.cloudProof !== pending.cloudProof) fail('TEAM_REQUEST_CHANGED');
        const visible = { ...visibleReview(item.descriptor, review), kind: 'team-target', teamRequestId: requestId };
        drafts.set(visible.reviewHandle, { generation, descriptor: item.descriptor, pending, ...review, visible });
        return visible;
      }),
      confirmTeamConsent: ({ reviewHandle, passphrase }) => run(async guard => {
        const draft = drafts.get(reviewHandle);
        if (!draft || draft.generation !== generation || draft.mutation.expiresAt <= now()) fail('LOCAL_TRUST_REVIEW_EXPIRED');
        const proofs = await vault.signLedgerTarget({ payload: draft.mutation, passphrase, guard }); guard();
        const requestId = draft.visible.teamRequestId;
        await saveBox(draft.descriptor, value => ({ ...value, teamRequests: { ...value.teamRequests, [requestId]: { ...value.teamRequests[requestId], consentedMutation: draft.mutation } } }), guard);
        const result = (await send(draft.descriptor, '/team/requests/consent', { requestId, ...proofs }, 'team-request-receipt', guard, { requestId })).body;
        drafts.delete(reviewHandle); return { boxId: draft.descriptor.boxId, ...result };
      }),
      prepareTeamAdmission: ({ boxId, requestId }) => run(async guard => {
        const result = (await read(box(boxId), 'team-request', requestId, guard)).body;
        if (result.state !== 'pending') fail('TEAM_REQUEST_TERMINAL');
        return prepare(boxId, 'team.member-admit', { request: result.request, cloudProof: result.cloudProof }, guard);
      }),
    },
  };
}
