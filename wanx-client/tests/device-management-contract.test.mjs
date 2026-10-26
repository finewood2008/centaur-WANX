import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  firstRootDigest, parseDeliveryPacket, parseInvitation, parseJoinInfo, signFirstRoot,
  signRead, validateDescriptor, validateFirstRootPayload, validateReadPayload, verifyResponse,
} from '../device-trust/management-contract.mjs';
import { publicKeyThumbprint, requestDigest, signRequest } from '../device-trust/binding-contract.mjs';

const keyPair = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, jwk: pair.publicKey.export({ format: 'jwk' }) };
};
const box = keyPair(), access = keyPair(), approval = keyPair(), applicant = keyPair();
const bytes = (value) => Buffer.alloc(32, value).toString('base64url');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const now = 1780000000;
const descriptor = { boxId: 'box-1', baseUrl: 'https://127.0.0.1:9443', boxKey: box.jwk, tlsSpkiSha256: bytes(1) };
const ctx = { boxId: descriptor.boxId, boxKeyThumbprint: publicKeyThumbprint(box.jwk), ownershipEpoch: 1,
  rosterVersion: 1, rosterDigest: bytes(2), policyVersion: 1 };
const grants = [{ resourceId: 'personal-space', actions: ['read', 'write'] }];
const root = { schemaVersion: 1, purpose: 'centuarai.local-management.first-root',
  boxId: ctx.boxId, boxKeyThumbprint: ctx.boxKeyThumbprint, provisioningId: bytes(3), ownershipEpoch: 1,
  challenge: bytes(4), requestId: bytes(5), issuedAt: now, expiresAt: now + 300, principalId: 'person-1',
  clientId: 'manager-1', accessKey: access.jwk, approvalKey: approval.jwk, grants, grantExpiresAt: null,
  keyProtection: 'software-passphrase-v1' };
const read = { schemaVersion: 1, purpose: 'centuarai.local-management.read', boxId: ctx.boxId,
  boxKeyThumbprint: ctx.boxKeyThumbprint, ownershipEpoch: 1, nonce: bytes(6), issuedAt: now, expiresAt: now + 60,
  clientId: root.clientId, operation: 'state', requestId: null };
const manager = { bindingId: 'binding-1', principalId: root.principalId, clientId: root.clientId, role: 'manage',
  status: 'active', accessKey: access.jwk, approvalKey: approval.jwk, approvalKeyVersion: 1,
  canApproveUseDevices: true, delegableGrants: grants, expiresAt: null, delegationExpiresAt: null,
  establishedAt: now - 30, establishedVersion: 1 };
ctx.rosterDigest = createHash('sha256').update(canonical([manager])).digest('base64url');
const proposal = { schemaVersion: 1, purpose: 'centuarai.local-device-binding.request', ...ctx,
  requestId: bytes(7), challenge: bytes(8), issuedAt: now, expiresAt: now + 300, principalId: root.principalId,
  clientId: 'use-1', accessKey: applicant.jwk, approvalKey: null, role: 'use', grants,
  delegationAllowed: false, grantExpiresAt: null };
const requestJws = signRequest(proposal, applicant.privateKey);
const ack = { requestId: proposal.requestId, requestDigest: requestDigest(proposal), bindingId: 'binding-2',
  principalId: proposal.principalId, clientId: proposal.clientId, role: 'use',
  accessKeyThumbprint: publicKeyThumbprint(applicant.jwk), ownershipEpoch: 1, rosterVersion: 2,
  rosterDigest: bytes(9), policyVersion: 1, committedAt: now, recoveryConfigured: false };
function wire(kind, body, { payload = {}, header = {}, signingKey = box.privateKey, json = canonical } = {}) {
  const h = Buffer.from(json({ alg: 'ES256', typ: 'centuarai-local-management-response+jws', ...header })).toString('base64url');
  const p = Buffer.from(json({ schemaVersion: 1, purpose: 'centuarai.local-management.response',
    boxId: ctx.boxId, boxKeyThumbprint: ctx.boxKeyThumbprint, kind, issuedAt: now, body, ...payload })).toString('base64url');
  const input = `${h}.${p}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const firstChallenge = { provisioningId: root.provisioningId, ownershipEpoch: 1, challenge: root.challenge,
  issuedAt: now, expiresAt: now + 300, grants };
const bodies = {
  'first-root-challenge': firstChallenge,
  'auth-challenge': { nonce: read.nonce, issuedAt: now, expiresAt: now + 60, ownershipEpoch: 1 },
  'binding-challenge': { context: ctx, challenge: proposal.challenge, issuedAt: now, expiresAt: now + 300 },
  state: { context: ctx, bindings: [manager], recoveryConfigured: false },
  'request-receipt': { requestId: proposal.requestId, requestDigest: requestDigest(proposal), state: 'pending', expiresAt: proposal.expiresAt },
  request: { requestId: proposal.requestId, requestDigest: requestDigest(proposal), state: 'pending', requestJws, ack: null },
  'binding-ack': ack,
};

test('protected delivery, public join and invitation import preserve exact immutable boundaries', () => {
  const delivery = { schemaVersion: 1, type: 'centuarai-local-trust-delivery', ...descriptor,
    provisioningId: root.provisioningId, ownershipEpoch: 1, claimSecret: bytes(10) };
  const join = { schemaVersion: 1, type: 'centuarai-local-trust-join', descriptor, principalId: root.principalId,
    grants, grantExpiresAt: null };
  const invitation = { schemaVersion: 1, type: 'centuarai-local-trust-invitation', descriptor,
    requestId: proposal.requestId, requestDigest: requestDigest(proposal) };
  for (const [parser, value] of [[parseDeliveryPacket, delivery], [parseJoinInfo, join], [parseInvitation, invitation]]) {
    const result = parser(JSON.stringify(value, null, 2));
    assert.deepEqual(result, value);
    assert.ok(Object.isFrozen(result));
    assert.throws(() => parser(JSON.stringify({ ...value, unexpected: true })));
    assert.throws(() => parser(JSON.stringify(value).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')));
    assert.throws(() => parser(' '.repeat(8193)));
  }
  assert.throws(() => parseJoinInfo(JSON.stringify({ ...join, claimSecret: bytes(10) })));
  assert.throws(() => parseInvitation(JSON.stringify({ ...invitation, claimSecret: bytes(10) })));
  assert.throws(() => parseDeliveryPacket(JSON.stringify({ ...delivery, claimSecret: `${bytes(10)}=` })));
});

for (const baseUrl of ['http://127.0.0.1', 'https://user:password@localhost', 'https://localhost?redirect=x',
  'https://localhost#x', 'https://localhost?', 'https://localhost#', 'https://localhost/path',
  'https://localhost/../', 'https://localhost\\evil', ' https://localhost', 'https://localhost\n']) {
  test(`management descriptor rejects ambiguous or untrusted URL syntax ${JSON.stringify(baseUrl)}`, () => {
    assert.throws(() => validateDescriptor({ ...descriptor, baseUrl }), /LOCAL_MANAGEMENT_URL_INVALID/);
  });
}

test('first-root signs identical canonical bytes with distinct matching ES256 keys and hashed secret HS256', () => {
  const secret = bytes(10);
  const proofs = signFirstRoot(root, { accessPrivateKey: access.privateKey, approvalPrivateKey: approval.privateKey, claimSecret: secret });
  const payloadSegments = Object.values(proofs).map((proof) => proof.split('.')[1]);
  assert.equal(new Set(payloadSegments).size, 1);
  assert.equal(Buffer.from(payloadSegments[0], 'base64url').toString(), canonical(root));
  for (const [name, pair, typ] of [['accessProof', access, 'access'], ['approvalProof', approval, 'approval']]) {
    const [h, p, signature] = proofs[name].split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', typ: `centuarai-first-root-${typ}+jws` });
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: pair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  }
  const [h, p, signature] = proofs.secretProof.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'centuarai-first-root-secret+jws' });
  assert.equal(signature, createHmac('sha256', createHash('sha256').update(Buffer.from(secret, 'base64url')).digest()).update(`${h}.${p}`).digest('base64url'));
  assert.equal(firstRootDigest(root), createHash('sha256').update(canonical(root)).digest('base64url'));
  assert.throws(() => signFirstRoot(root, { accessPrivateKey: approval.privateKey, approvalPrivateKey: access.privateKey, claimSecret: secret }), /KEY_MISMATCH/);
  assert.throws(() => validateFirstRootPayload({ ...root, approvalKey: root.accessKey }));
  assert.throws(() => validateFirstRootPayload({ ...root, keyProtection: 'hardware-attested' }));
  assert.throws(() => validateFirstRootPayload({ ...root, expiresAt: now + 301 }));
  assert.throws(() => validateFirstRootPayload({ ...root, principalId: 'person-1\n' }));
});

test('read proof purpose and request discriminator are closed schemas', () => {
  const proof = signRead(read, access.privateKey), [h, p, sig] = proof.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', typ: 'centuarai-local-management-read+jws' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: access.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.deepEqual(validateReadPayload({ ...read, operation: 'request', requestId: proposal.requestId }).requestId, proposal.requestId);
  for (const changes of [{ operation: 'arbitrary' }, { requestId: proposal.requestId }, { expiresAt: now + 61 },
    { ownershipEpoch: 1.5 }, { nonce: bytes(2) + '=' }, { verified: true }, { purpose: root.purpose }]) {
    assert.throws(() => signRead({ ...read, ...changes }, access.privateKey));
  }
});

for (const [kind, body] of Object.entries(bodies)) {
  test(`management verifies exact ${kind} response with expected body binding`, () => {
    const result = verifyResponse(wire(kind, body), { descriptor, kind, now, expected: body });
    assert.deepEqual(result.body, body); assert.ok(Object.isFrozen(result.body));
    assert.throws(() => verifyResponse(wire(kind, { ...body, arbitrary: true }), { descriptor, kind, now }));
    assert.throws(() => verifyResponse(wire(kind, body), { descriptor, kind, now, expected: { nonexistent: null } }), /CONTEXT_MISMATCH/);
  });
}

test('valid signature never overrides algorithm, type, canonical encoding, box or operation context', () => {
  for (const options of [{ header: { alg: 'HS256' } }, { header: { typ: 'other+jws' } },
    { header: { kid: 'external-key' } }, { payload: { kind: 'state' } },
    { payload: { boxId: 'other-box' } }, { payload: { boxKeyThumbprint: bytes(99) } },
    { payload: { issuedAt: now + 1 } }, { signingKey: access.privateKey }, { json: JSON.stringify }]) {
    assert.throws(() => verifyResponse(wire('binding-ack', ack, options), { descriptor, kind: 'binding-ack', now }));
  }
  const signed = wire('binding-ack', ack);
  assert.throws(() => verifyResponse(`${signed}=`, { descriptor, kind: 'binding-ack', now }));
  assert.throws(() => verifyResponse(signed + '.extra', { descriptor, kind: 'binding-ack', now }));
  assert.throws(() => verifyResponse(wire('binding-ack', { ...ack, principalId: '人物' }), { descriptor, kind: 'binding-ack', now }));
  assert.throws(() => verifyResponse('x'.repeat(262145), { descriptor, kind: 'binding-ack', now }));
});

test('challenges enforce freshness/lifetime; stored ACK can be verified after its commit time', () => {
  for (const kind of ['first-root-challenge', 'auth-challenge', 'binding-challenge']) {
    const body = bodies[kind];
    assert.throws(() => verifyResponse(wire(kind, body), { descriptor, kind, now: body.expiresAt }), /EXPIRED/);
    assert.throws(() => verifyResponse(wire(kind, { ...body, expiresAt: now + 301 }), { descriptor, kind, now }));
  }
  assert.deepEqual(verifyResponse(wire('binding-ack', ack), { descriptor, kind: 'binding-ack', now: now + 86400 }).body, ack);
});

test('ACK matches every expected request, key, principal, role and authority field', () => {
  for (const field of ['requestId', 'requestDigest', 'principalId', 'clientId', 'role', 'accessKeyThumbprint', 'ownershipEpoch', 'policyVersion']) {
    const wrong = typeof ack[field] === 'number' ? ack[field] + 1 : ack[field] + 'x';
    assert.throws(() => verifyResponse(wire('binding-ack', ack), { descriptor, kind: 'binding-ack', now,
      expected: { [field]: wrong } }), /CONTEXT_MISMATCH/);
  }
});

test('request read verifies applicant proof and committed nested receipt before exposing approval', () => {
  const body = { ...bodies.request, state: 'approved', ack: wire('binding-ack', ack) };
  assert.equal(verifyResponse(wire('request', body), { descriptor, kind: 'request', now }).body.state, 'approved');
  for (const changes of [{ ack: null }, { requestDigest: bytes(99) }, { requestId: bytes(99) },
    { requestJws: signRequest({ ...proposal, principalId: 'other' }, applicant.privateKey) },
    { ack: wire('binding-ack', { ...ack, clientId: 'wrong' }) },
    { ack: wire('binding-ack', { ...ack, rosterVersion: proposal.rosterVersion }) }]) {
    assert.throws(() => verifyResponse(wire('request', { ...body, ...changes }), { descriptor, kind: 'request', now }));
  }
  assert.throws(() => verifyResponse(wire('request', { ...body, state: 'pending' }), { descriptor, kind: 'request', now }));
});

test('signed state rejects duplicate identity/key history and delegate rights on use bindings', () => {
  for (const allBindings of [[manager, manager], [manager, { ...manager, bindingId: 'binding-2', clientId: 'new' }],
    [{ ...manager, role: 'use' }], [{ ...manager, establishedVersion: 2 }]]) {
    assert.throws(() => verifyResponse(wire('state', { ...bodies.state, bindings: allBindings }), { descriptor, kind: 'state', now }));
  }
});

test('state recomputes the complete roster digest before accepting a signed checkpoint', () => {
  assert.throws(() => verifyResponse(wire('state', { ...bodies.state,
    context: { ...ctx, rosterDigest: bytes(99) } }), { descriptor, kind: 'state', now }), /CONTEXT_MISMATCH/);
  assert.throws(() => verifyResponse(wire('state', { ...bodies.state,
    bindings: [{ ...manager, status: 'revoked' }] }), { descriptor, kind: 'state', now }), /CONTEXT_MISMATCH/);
  assert.throws(() => verifyResponse(wire('state', { ...bodies.state, bindings: [] }), { descriptor, kind: 'state', now }), /CONTEXT_MISMATCH/);
});
