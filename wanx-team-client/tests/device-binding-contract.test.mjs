import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  BindingProtocolError,
  canonicalRequest,
  decodeCancelPayload,
  publicKeyThumbprint,
  requestDigest,
  signApproval,
  signCancel,
  signRequest,
  validateRequestContext,
  verifyApprovalSignature,
  verifyCancelProof,
  verifyRequestProof,
} from '../device-trust/binding-contract.mjs';

const vector = JSON.parse(readFileSync(new URL('../../contracts/local-trust/v1/vectors.json', import.meta.url)));
const makeKey = () => {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { ...key, jwk: key.publicKey.export({ format: 'jwk' }) };
};
const applicant = makeKey();
const managerAccess = makeKey();
const managerApproval = makeKey();
const another = makeKey();
const clone = (value) => structuredClone(value);
const differentDigest = Buffer.alloc(32, 99).toString('base64url');
const expectError = (code, operation) => assert.throws(operation, (error) => {
  assert.ok(error instanceof BindingProtocolError);
  assert.equal(error.code, `LOCAL_BINDING_${code}`);
  return true;
});

function fixture() {
  const request = clone(vector.request);
  request.accessKey = clone(applicant.jwk);
  const state = clone(vector.trustedState);
  state.bindings[0].accessKey = clone(managerAccess.jwk);
  state.bindings[0].approvalKey = clone(managerApproval.jwk);
  const approval = { ...clone(vector.approval), requestDigest: requestDigest(request) };
  return { request, state, approval };
}

function approve(f, { requestKey = applicant.privateKey, approvalKey = managerApproval.privateKey, now = vector.now } = {}) {
  return verifyApprovalSignature(signApproval(f.approval, approvalKey), signRequest(f.request, requestKey), f.state, now);
}

function canonicalForTest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rawRequest(payload, header = { alg: 'ES256', typ: 'centuarai-device-binding-request+jws' }, encoding = 'ieee-p1363', key = applicant.privateKey) {
  const headerText = typeof header === 'string' ? header : canonicalForTest(header);
  const payloadText = typeof payload === 'string' ? payload : canonicalForTest(payload);
  const input = `${Buffer.from(headerText).toString('base64url')}.${Buffer.from(payloadText).toString('base64url')}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: encoding }).toString('base64url')}`;
}

function historicalBinding() {
  return {
    ...fixture().state.bindings[0],
    bindingId: 'binding:historical',
    clientId: 'client:historical',
    role: 'use',
    status: 'revoked',
    accessKey: clone(another.jwk),
    approvalKey: null,
    approvalKeyVersion: null,
    canApproveUseDevices: false,
    delegableGrants: [],
  };
}

test('independent shared vectors fix canonical bytes, digest, thumbprint and all three JWS formats', () => {
  assert.deepEqual(canonicalRequest(vector.request), Buffer.from(vector.canonicalRequest, 'utf8'));
  assert.equal(requestDigest(vector.request), vector.requestDigest);
  assert.equal(publicKeyThumbprint(vector.request.accessKey), vector.accessKeyThumbprint);
  assert.deepEqual(verifyRequestProof(vector.proofs.request), vector.request);
  assert.equal(validateRequestContext(vector.request, vector.context, vector.now), undefined);
  assert.deepEqual(verifyApprovalSignature(vector.proofs.approval, vector.proofs.request, vector.trustedState, vector.now), vector.approval);
  assert.deepEqual(decodeCancelPayload(vector.proofs.cancel), vector.cancel);
  assert.deepEqual(verifyCancelProof(vector.proofs.cancel, vector.request, vector.now), vector.cancel);
  assert.deepEqual(verifyRequestProof(signRequest(vector.request, vector.testKeys.accessPrivateKeyPem)), vector.request);
  assert.deepEqual(verifyApprovalSignature(signApproval(vector.approval, vector.testKeys.approvalPrivateKeyPem),
    vector.proofs.request, vector.trustedState, vector.now), vector.approval);
});

test('request identity depends on complete canonical content, not object order or ECDSA randomness', () => {
  const { request } = fixture();
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  assert.deepEqual(canonicalRequest(reordered), canonicalRequest(request));
  const first = signRequest(request, applicant.privateKey);
  const second = signRequest(reordered, applicant.privateKey);
  assert.equal(requestDigest(verifyRequestProof(first)), requestDigest(verifyRequestProof(second)));
  for (const mutate of [
    (r) => { r.clientId = 'client:different'; },
    (r) => { r.boxId = 'box:different'; },
    (r) => { r.grants[0].actions = ['read']; },
    (r) => { r.grantExpiresAt += 1; },
    (r) => { r.approvalKey = null; r.challenge = differentDigest; },
  ]) {
    const changed = clone(request);
    mutate(changed);
    assert.notEqual(requestDigest(changed), requestDigest(request));
    const parts = first.split('.');
    parts[1] = canonicalRequest(changed).toString('base64url');
    expectError('SIGNATURE_INVALID', () => verifyRequestProof(parts.join('.')));
  }
});

test('request proof is possession only; freshness and current context are separate required checks', () => {
  const { request } = fixture();
  const proof = signRequest(request, applicant.privateKey);
  assert.deepEqual(verifyRequestProof(proof), request);
  expectError('EXPIRED', () => validateRequestContext(request, vector.context, request.expiresAt));
  expectError('EXPIRED', () => validateRequestContext(request, vector.context, request.issuedAt - 1));
  for (const field of Object.keys(vector.context)) {
    const context = clone(vector.context);
    context[field] = typeof context[field] === 'number' ? context[field] + 1
      : field === 'boxId' ? 'box:different' : differentDigest;
    expectError('CONTEXT_MISMATCH', () => validateRequestContext(request, context, vector.now));
  }
  for (const now of [NaN, Infinity, -1, 0, true, '1792886410', vector.now + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expectError('INVALID', () => validateRequestContext(request, vector.context, now));
  }
  expectError('INVALID', () => validateRequestContext(request, { ...vector.context, verified: true }, vector.now));
});

const malformedRequests = [
  ['unknown field', (r) => { r.verified = true; }],
  ['omitted explicit null', (r) => { delete r.approvalKey; }],
  ['manager role', (r) => { r.role = 'manage'; }],
  ['approval key capability', (r) => { r.approvalKey = managerApproval.jwk; }],
  ['delegation capability', (r) => { r.delegationAllowed = true; }],
  ['boolean version', (r) => { r.schemaVersion = true; }],
  ['float', (r) => { r.ownershipEpoch = 1.5; }],
  ['unsafe integer', (r) => { r.rosterVersion = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative zero', (r) => { r.issuedAt = -0; }],
  ['unicode', (r) => { r.principalId = 'member:张'; }],
  ['token terminal newline', (r) => { r.clientId += '\n'; }],
  ['too long token', (r) => { r.boxId = 'a'.repeat(129); }],
  ['padded digest', (r) => { r.challenge += '='; }],
  ['short digest', (r) => { r.requestId = 'AA'; }],
  ['long lifetime', (r) => { r.expiresAt = r.issuedAt + 301; }],
  ['equal issue/expiry', (r) => { r.expiresAt = r.issuedAt; }],
  ['grant expires before evidence', (r) => { r.grantExpiresAt = r.expiresAt - 1; }],
  ['empty grants', (r) => { r.grants = []; }],
  ['too many grants', (r) => { r.grants = Array.from({ length: 17 }, (_, i) => ({ resourceId: `r${String(i).padStart(2, '0')}`, actions: ['read'] })); }],
  ['duplicate resources', (r) => { r.grants.push(clone(r.grants[0])); }],
  ['unsorted resources', (r) => { r.grants.push({ resourceId: 'a', actions: ['read'] }); }],
  ['unsorted actions', (r) => { r.grants[0].actions = ['write', 'read']; }],
  ['duplicate actions', (r) => { r.grants[0].actions = ['read', 'read']; }],
  ['unknown action', (r) => { r.grants[0].actions = ['admin']; }],
  ['empty actions', (r) => { r.grants[0].actions = []; }],
  ['unknown grant field', (r) => { r.grants[0].scope = '*'; }],
];
for (const [name, mutate] of malformedRequests) {
  test(`request rejects ${name}`, () => {
    const { request } = fixture();
    mutate(request);
    expectError('INVALID', () => canonicalRequest(request));
    expectError('INVALID', () => signRequest(request, applicant.privateKey));
    expectError('INVALID', () => verifyRequestProof(rawRequest(request)));
  });
}

test('public keys have exact public-only P-256 coordinates and a valid curve point', () => {
  for (const mutate of [
    (key) => { key.d = differentDigest; },
    (key) => { key.kid = 'untrusted'; },
    (key) => { key.alg = 'ES256'; },
    (key) => { key.crv = 'P-384'; },
    (key) => { key.kty = 'RSA'; },
    (key) => { key.x += '='; },
    (key) => { key.y = 'AA'; },
    (key) => { key.x = Buffer.alloc(32).toString('base64url'); key.y = key.x; },
  ]) {
    const key = clone(applicant.jwk);
    mutate(key);
    expectError('INVALID', () => publicKeyThumbprint(key));
  }
  const { request } = fixture();
  expectError('INVALID', () => signRequest(request, another.privateKey));
  expectError('SIGNATURE_INVALID', () => verifyRequestProof(rawRequest(request, undefined, undefined, another.privateKey)));
  expectError('INVALID', () => signRequest(request, applicant.publicKey));
  expectError('INVALID', () => signRequest(request, generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey));
});

test('wire encoding rejects unknown or selectable headers, DER, padding and noncanonical JSON', () => {
  const { request } = fixture();
  const expected = { alg: 'ES256', typ: 'centuarai-device-binding-request+jws' };
  for (const header of [
    { ...expected, alg: 'none' }, { ...expected, alg: 'HS256' }, { ...expected, alg: 'ES384' },
    { ...expected, typ: 'centuarai-device-binding-approval+jws' },
    { ...expected, jwk: applicant.jwk }, { ...expected, kid: 'manager' }, { ...expected, crit: [] },
    JSON.stringify(expected, null, 2), '{"typ":"centuarai-device-binding-request+jws","alg":"ES256"}',
  ]) expectError('INVALID', () => verifyRequestProof(rawRequest(request, header)));
  const canonical = canonicalRequest(request).toString();
  for (const payload of [
    JSON.stringify(request), ` ${canonical}`, `${canonical}\n`,
    canonical.replace('"boxId":', '"boxId":"box:duplicate","boxId":'),
    canonical.replace('"clientId"', '"client\\u0049d"'),
    canonical.replace(`"issuedAt":${request.issuedAt}`, `"issuedAt":${request.issuedAt}.0`),
    canonical.replace('"schemaVersion":1', '"schemaVersion":1e0'),
    canonical.replace('"ownershipEpoch":2', '"ownershipEpoch":-0'),
  ]) expectError('INVALID', () => verifyRequestProof(rawRequest(payload)));
  expectError('INVALID', () => verifyRequestProof(rawRequest(request, expected, 'der')));
  const parts = signRequest(request, applicant.privateKey).split('.');
  for (let index = 0; index < 3; index += 1) {
    const padded = [...parts];
    padded[index] += '=';
    expectError('INVALID', () => verifyRequestProof(padded.join('.')));
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonical = [...parts];
  const last = parts[2].at(-1);
  noncanonical[2] = parts[2].slice(0, -1) + alphabet[alphabet.indexOf(last) + 1];
  expectError('INVALID', () => verifyRequestProof(noncanonical.join('.')));
  expectError('INVALID', () => verifyRequestProof(`${parts.join('.')}.extra`));
  expectError('INVALID', () => verifyRequestProof('A'.repeat(16385)));
  expectError('INVALID', () => verifyRequestProof(rawRequest('['.repeat(5000) + ']'.repeat(5000))));
});

test('same-principal use-device approval returns only signature evidence and accepts bounded authority', () => {
  const f = fixture();
  f.state.bindings[0].expiresAt = f.request.grantExpiresAt;
  f.state.bindings[0].delegationExpiresAt = f.request.grantExpiresAt;
  assert.deepEqual(approve(f), f.approval);
  assert.equal(Object.hasOwn(approve(f), 'verified'), false);
  f.request.grantExpiresAt = null;
  f.approval.requestDigest = requestDigest(f.request);
  f.state.bindings[0].expiresAt = null;
  f.state.bindings[0].delegationExpiresAt = null;
  assert.deepEqual(approve(f), f.approval);
});

test('approval rejects stale request, wrong checkpoint, changed digest and invalid evidence time', () => {
  for (const field of Object.keys(vector.trustedState).filter((key) => key !== 'bindings')) {
    const f = fixture();
    f.state[field] = typeof f.state[field] === 'number' ? f.state[field] + 1
      : field === 'boxId' ? 'box:other' : differentDigest;
    expectError('CONTEXT_MISMATCH', () => approve(f));
  }
  const wrongDigest = fixture();
  wrongDigest.approval.requestDigest = differentDigest;
  expectError('CONTEXT_MISMATCH', () => approve(wrongDigest));
  for (const mutate of [
    (f) => { f.approval.approvedAt = f.request.issuedAt - 1; },
    (f) => { f.approval.approvedAt = vector.now + 1; },
    (f) => { f.approval.approvedAt = f.request.issuedAt; f.approval.expiresAt = vector.now; },
    (f) => { f.approval.expiresAt = f.request.expiresAt + 1; },
  ]) {
    const f = fixture();
    mutate(f);
    expectError('EXPIRED', () => approve(f));
  }
  expectError('EXPIRED', () => approve(fixture(), { now: vector.request.expiresAt }));
});

test('approval cannot bootstrap from empty roster, another principal, use role, or later authority', () => {
  for (const mutate of [
    (f) => { f.state.bindings = []; },
    (f) => { f.approval.approverBindingId = 'binding:missing'; },
    (f) => { f.state.bindings[0].principalId = 'principal:bob'; },
    (f) => { f.state.bindings[0].role = 'use'; },
    (f) => { f.state.bindings[0].status = 'revoked'; },
    (f) => { f.state.bindings[0].status = 'suspended'; },
    (f) => { f.state.bindings[0].canApproveUseDevices = false; },
    (f) => { f.state.bindings[0].approvalKey = null; f.state.bindings[0].approvalKeyVersion = null; },
    (f) => { f.state.bindings[0].approvalKeyVersion += 1; },
    (f) => { f.state.bindings[0].establishedAt = f.request.issuedAt + 1; },
    (f) => { f.state.bindings[0].establishedVersion = f.request.rosterVersion + 1; },
  ]) {
    const f = fixture();
    mutate(f);
    expectError('APPROVAL_FORBIDDEN', () => approve(f));
  }
  expectError('SIGNATURE_INVALID', () => approve(fixture(), { approvalKey: managerAccess.privateKey }));
  expectError('SIGNATURE_INVALID', () => approve(fixture(), { approvalKey: applicant.privateKey }));
});

test('target client and access key cannot reuse revoked history or self-approve', () => {
  const clientReuse = fixture();
  const history = historicalBinding();
  history.clientId = clientReuse.request.clientId;
  clientReuse.state.bindings.push(history);
  expectError('CLIENT_REUSE', () => approve(clientReuse));
  for (const key of [managerAccess, managerApproval, another]) {
    const f = fixture();
    f.state.bindings.push(historicalBinding());
    f.request.accessKey = clone(key.jwk);
    f.approval.requestDigest = requestDigest(f.request);
    expectError('KEY_REUSE', () => approve(f, { requestKey: key.privateKey }));
  }
  const self = fixture();
  self.state.bindings[0].clientId = self.request.clientId;
  expectError('CLIENT_REUSE', () => approve(self));
});

test('whole roster rejects duplicate IDs and cross-purpose keys even outside the selected approver', () => {
  for (const mutate of [
    (f, row) => { row.bindingId = f.state.bindings[0].bindingId; },
    (f, row) => { row.clientId = f.state.bindings[0].clientId; },
    (f, row) => { row.accessKey = clone(f.state.bindings[0].accessKey); },
    (f, row) => { row.accessKey = clone(f.state.bindings[0].approvalKey); },
    (f, row) => { row.approvalKey = clone(f.state.bindings[0].accessKey); row.approvalKeyVersion = 1; },
    (f, row) => { row.approvalKey = clone(row.accessKey); row.approvalKeyVersion = 1; },
  ]) {
    const f = fixture();
    const row = historicalBinding();
    mutate(f, row);
    f.state.bindings.push(row);
    expectError('INVALID', () => approve(f));
    f.state.bindings.reverse();
    expectError('INVALID', () => approve(f));
  }
  for (const mutate of [
    (f) => { f.state.verified = true; },
    (f) => { f.state.bindings[0].verified = true; },
    (f) => { delete f.state.bindings[0].delegationExpiresAt; },
    (f) => { f.state.bindings[0].approvalKeyVersion = null; },
    (f) => { f.state.bindings[0].approvalKey = null; },
    (f) => { f.state.bindings[0].approvalKey = clone(f.state.bindings[0].accessKey); },
  ]) {
    const f = fixture();
    mutate(f);
    expectError('INVALID', () => approve(f));
  }
});

test('requested resources, actions and lifetime stay within both binding and delegation bounds', () => {
  for (const delegableGrants of [[], [{ resourceId: 'space:other', actions: ['read', 'write'] }],
    [{ resourceId: 'space:personal', actions: ['read'] }]]) {
    const f = fixture();
    f.state.bindings[0].delegableGrants = delegableGrants;
    expectError('SCOPE_EXCEEDED', () => approve(f));
  }
  for (const field of ['expiresAt', 'delegationExpiresAt']) {
    const f = fixture();
    f.state.bindings[0][field] = vector.now;
    expectError('EXPIRED', () => approve(f));
    f.state.bindings[0][field] = f.request.grantExpiresAt - 1;
    expectError('LIFETIME_EXCEEDED', () => approve(f));
    f.request.grantExpiresAt = null;
    f.approval.requestDigest = requestDigest(f.request);
    expectError('LIFETIME_EXCEEDED', () => approve(f));
  }
});

test('cancel decoding is unverified; saved request key and digest must authorize the cancellation', () => {
  const { request } = fixture();
  const cancel = { ...clone(vector.cancel), requestDigest: requestDigest(request) };
  const proof = signCancel(cancel, applicant.privateKey);
  assert.deepEqual(decodeCancelPayload(proof), cancel);
  assert.deepEqual(verifyCancelProof(proof, request, vector.now), cancel);
  const wrongKey = signCancel(cancel, another.privateKey);
  assert.deepEqual(decodeCancelPayload(wrongKey), cancel);
  expectError('SIGNATURE_INVALID', () => verifyCancelProof(wrongKey, request, vector.now));
  for (const field of ['requestId', 'requestDigest']) {
    const changed = { ...cancel, [field]: differentDigest };
    expectError('CONTEXT_MISMATCH', () => verifyCancelProof(signCancel(changed, applicant.privateKey), request, vector.now));
  }
  expectError('EXPIRED', () => verifyCancelProof(proof, request, cancel.expiresAt));
  expectError('EXPIRED', () => verifyCancelProof(proof, request, cancel.issuedAt - 1));
  const later = { ...cancel, issuedAt: request.expiresAt, expiresAt: request.expiresAt + 30 };
  assert.deepEqual(verifyCancelProof(signCancel(later, applicant.privateKey), request, later.issuedAt), later);
  expectError('INVALID', () => signCancel({ ...cancel, expiresAt: cancel.issuedAt + 301 }, applicant.privateKey));
  expectError('INVALID', () => signCancel({ ...cancel, grants: request.grants }, applicant.privateKey));
  expectError('INVALID', () => decodeCancelPayload(signRequest(request, applicant.privateKey)));
  expectError('INVALID', () => signApproval({ ...fixture().approval, verified: true }, managerApproval.privateKey));
  for (const expiresAt of [vector.approval.approvedAt, vector.approval.approvedAt - 1]) {
    expectError('INVALID', () => signApproval({ ...fixture().approval, expiresAt }, managerApproval.privateKey));
  }
});
