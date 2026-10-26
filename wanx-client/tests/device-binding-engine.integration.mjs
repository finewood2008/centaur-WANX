import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  canonicalRequest, requestDigest, publicKeyThumbprint,
  signRequest, verifyRequestProof, validateRequestContext,
  signApproval, verifyApprovalSignature, signCancel, verifyCancelProof,
} from '../device-trust/binding-contract.mjs';

// Explicit integration test: requires the Bridge Python development environment.
// It never silently skips when Python or a crypto dependency is unavailable.
const root = fileURLToPath(new URL('../../', import.meta.url));
const vector = JSON.parse(readFileSync(new URL('../../contracts/local-trust/v1/vectors.json', import.meta.url)));
const clone = (value) => structuredClone(value);
const accessKey = createPrivateKey(vector.testKeys.accessPrivateKeyPem);
const approvalKey = createPrivateKey(vector.testKeys.approvalPrivateKeyPem);

function python(operations) {
  const helper = fileURLToPath(new URL('./fixtures/device-binding-engine.py', import.meta.url));
  const command = process.env.WANX_BINDING_TEST_PYTHON || 'uv';
  const args = process.env.WANX_BINDING_TEST_PYTHON ? [helper]
    : ['run', '--project', 'wanx-bridge', '--no-sync', 'python', helper];
  const result = spawnSync(command, args, {
    cwd: root, input: JSON.stringify(operations), encoding: 'utf8', timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rawCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(rawCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${rawCanonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rawProof(payload, { header, encoding = 'ieee-p1363', bytes } = {}) {
  const encodedHeader = Buffer.from(rawCanonical(header || {
    alg: 'ES256', typ: 'centuarai-device-binding-request+jws',
  })).toString('base64url');
  const encodedPayload = Buffer.from(bytes || rawCanonical(payload)).toString('base64url');
  const input = `${encodedHeader}.${encodedPayload}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: accessKey, dsaEncoding: encoding }).toString('base64url')}`;
}

function rejectInBoth(cases) {
  const replies = python(cases.map(({ operation }) => operation));
  cases.forEach(({ name, run }, i) => {
    assert.throws(run, (error) => /^LOCAL_BINDING_/.test(error.code), `JS accepted ${name}`);
    assert.equal(replies[i].ok, false, `Python accepted ${name}`);
    assert.match(replies[i].code, /^LOCAL_BINDING_/, name);
  });
}

test('both implementations consume identical fixed canonical bytes and golden signatures', () => {
  assert.equal(Buffer.from(canonicalRequest(vector.request)).toString('ascii'), vector.canonicalRequest);
  assert.equal(requestDigest(vector.request), vector.requestDigest);
  assert.equal(publicKeyThumbprint(vector.request.accessKey), vector.accessKeyThumbprint);
  const [meta, request, approval, cancel] = python([
    { op: 'metadata', request: vector.request },
    { op: 'verify_request', proof: vector.proofs.request, context: vector.context, now: vector.now },
    { op: 'verify_approval', approvalProof: vector.proofs.approval, requestProof: vector.proofs.request,
      trustedState: vector.trustedState, now: vector.now },
    { op: 'verify_cancel', proof: vector.proofs.cancel, request: vector.request, now: vector.now },
  ]);
  assert.deepEqual(meta.value, {
    canonical: vector.canonicalRequest, digest: vector.requestDigest, thumbprint: vector.accessKeyThumbprint,
  });
  assert.deepEqual(request.value, verifyRequestProof(vector.proofs.request));
  validateRequestContext(request.value, vector.context, vector.now);
  assert.deepEqual(approval.value,
    verifyApprovalSignature(vector.proofs.approval, vector.proofs.request, vector.trustedState, vector.now));
  assert.deepEqual(cancel.value, verifyCancelProof(vector.proofs.cancel, vector.request, vector.now));
  for (const result of [meta, request, approval, cancel]) assert.equal(result.ok, true);
});

test('fresh signatures verify in both directions without relying on deterministic ECDSA', () => {
  const request = signRequest(vector.request, accessKey);
  const approval = signApproval(vector.approval, approvalKey);
  const cancel = signCancel(vector.cancel, accessKey);
  const replies = python([
    { op: 'verify_request', proof: request, context: vector.context, now: vector.now },
    { op: 'verify_approval', approvalProof: approval, requestProof: request,
      trustedState: vector.trustedState, now: vector.now },
    { op: 'verify_cancel', proof: cancel, request: vector.request, now: vector.now },
    { op: 'sign', request: vector.request, approval: vector.approval, cancel: vector.cancel, ...vector.testKeys },
  ]);
  for (const result of replies) assert.equal(result.ok, true, JSON.stringify(result));
  const proofs = replies.at(-1).value;
  assert.deepEqual(verifyRequestProof(proofs.request), vector.request);
  assert.deepEqual(verifyApprovalSignature(proofs.approval, proofs.request, vector.trustedState, vector.now), vector.approval);
  assert.deepEqual(verifyCancelProof(proofs.cancel, vector.request, vector.now), vector.cancel);
});

test('request signers reject a private key that does not match the proposed access key', () => {
  assert.throws(() => signRequest(vector.request, approvalKey),
    (error) => /^LOCAL_BINDING_/.test(error.code));
  const [result] = python([{ op: 'sign', request: vector.request, approval: vector.approval,
    cancel: vector.cancel, ...vector.testKeys, accessPrivateKeyPem: vector.testKeys.approvalPrivateKeyPem }]);
  assert.equal(result.ok, false);
  assert.match(result.code, /^LOCAL_BINDING_/);
});

test('both implementations reject invalid trusted clock values and the exact expiry boundary', () => {
  const times = [0, -1, true, 1792886410.5, 9007199254740992, vector.request.expiresAt];
  rejectInBoth(times.map((now) => ({
    name: `clock:${now}`,
    run: () => verifyApprovalSignature(vector.proofs.approval, vector.proofs.request, vector.trustedState, now),
    operation: { op: 'verify_approval', approvalProof: vector.proofs.approval,
      requestProof: vector.proofs.request, trustedState: vector.trustedState, now },
  })));
});

test('changing any signed authority field cannot reuse the original approval', () => {
  const changes = {
    boxId: (r) => { r.boxId = 'box:other'; },
    boxKey: (r) => { r.boxKeyThumbprint = 'A'.repeat(43); },
    epoch: (r) => { r.ownershipEpoch += 1; },
    rosterVersion: (r) => { r.rosterVersion += 1; },
    rosterDigest: (r) => { r.rosterDigest = 'A'.repeat(43); },
    policyVersion: (r) => { r.policyVersion += 1; },
    requestId: (r) => { r.requestId = 'A'.repeat(43); },
    challenge: (r) => { r.challenge = 'A'.repeat(43); },
    member: (r) => { r.principalId = 'principal:bob'; },
    client: (r) => { r.clientId = 'client:substitution'; },
    accessKey: (r) => { r.accessKey = vector.trustedState.bindings[0].accessKey; },
    approvalKey: (r) => { r.approvalKey = vector.trustedState.bindings[0].approvalKey; },
    role: (r) => { r.role = 'manage'; },
    resource: (r) => { r.grants[0].resourceId = 'space:other'; },
    actions: (r) => { r.grants[0].actions = ['execute']; },
    delegation: (r) => { r.delegationAllowed = true; },
    issuedAt: (r) => { r.issuedAt += 1; },
    requestExpiry: (r) => { r.expiresAt -= 1; },
    grantExpiry: (r) => { r.grantExpiresAt = null; },
  };
  const cases = Object.entries(changes).map(([name, modify]) => {
    const request = clone(vector.request); modify(request);
    const proof = rawProof(request);
    return {
      name,
      run: () => verifyApprovalSignature(vector.proofs.approval, proof, vector.trustedState, vector.now),
      operation: { op: 'verify_approval', approvalProof: vector.proofs.approval, requestProof: proof,
        trustedState: vector.trustedState, now: vector.now },
    };
  });
  rejectInBoth(cases);
});

test('both implementations reject ambiguous encoding and algorithm/key injection', () => {
  const proofCases = {
    duplicateField: rawProof(null, { bytes: vector.canonicalRequest.replace('{', '{"schemaVersion":1,') }),
    whitespace: rawProof(null, { bytes: ` ${vector.canonicalRequest}` }),
    unicodeEscape: rawProof(null, { bytes: vector.canonicalRequest.replace('box:test-001', '\\u0062ox:test-001') }),
    exponentInteger: rawProof(null, { bytes: vector.canonicalRequest.replace('"schemaVersion":1', '"schemaVersion":1e0') }),
    DER: rawProof(vector.request, { encoding: 'der' }),
    wrongType: rawProof(vector.request, { header: { alg: 'ES256', typ: 'JWT' } }),
    wrongAlgorithm: rawProof(vector.request, { header: { alg: 'HS256', typ: 'centuarai-device-binding-request+jws' } }),
    headerKey: rawProof(vector.request, { header: { alg: 'ES256', typ: 'centuarai-device-binding-request+jws', jwk: vector.request.accessKey } }),
    unknownField: rawProof({ ...vector.request, verified: true }),
    missingNull: rawProof(Object.fromEntries(Object.entries(vector.request).filter(([key]) => key !== 'approvalKey'))),
    unsafeInteger: rawProof({ ...vector.request, ownershipEpoch: 9007199254740992 }),
    unicodeId: rawProof({ ...vector.request, clientId: 'client:设备' }),
    invalidUtf8: rawProof(null, { bytes: Buffer.from([0xff]) }),
    padding: vector.proofs.request.replace('.', '=.'),
    oversized: 'A'.repeat(16385),
  };
  rejectInBoth(Object.entries(proofCases).map(([name, proof]) => ({
    name, run: () => verifyRequestProof(proof),
    operation: { op: 'verify_request', proof, context: vector.context, now: vector.now },
  })));
});

test('current trusted state and delegated lifetime are checked by both implementations', () => {
  const changes = {
    emptyRoster: (s) => { s.bindings = []; },
    revoked: (s) => { s.bindings[0].status = 'revoked'; },
    suspended: (s) => { s.bindings[0].status = 'suspended'; },
    wrongPrincipal: (s) => { s.bindings[0].principalId = 'principal:bob'; },
    noApprovalCapability: (s) => { s.bindings[0].canApproveUseDevices = false; },
    useRole: (s) => { s.bindings[0].role = 'use'; },
    laterEstablished: (s) => { s.bindings[0].establishedAt = vector.request.issuedAt + 1; },
    laterVersion: (s) => { s.bindings[0].establishedVersion = vector.request.rosterVersion + 1; },
    staleRoster: (s) => { s.rosterVersion += 1; },
    stalePolicy: (s) => { s.policyVersion += 1; },
    expiredBinding: (s) => { s.bindings[0].expiresAt = vector.now; },
    expiredDelegation: (s) => { s.bindings[0].delegationExpiresAt = vector.now; },
    exceededDelegationTime: (s) => { s.bindings[0].delegationExpiresAt = vector.request.grantExpiresAt - 1; },
    scopeEscalation: (s) => { s.bindings[0].delegableGrants[0].actions = ['read']; },
    duplicateHistory: (s) => { s.bindings.push({ ...clone(s.bindings[0]), status: 'revoked' }); },
    keyPurposeConflict: (s) => { s.bindings[0].accessKey = s.bindings[0].approvalKey; },
    reusedTargetKey: (s) => { s.bindings[0].accessKey = vector.request.accessKey; },
    reusedClientId: (s) => { s.bindings[0].clientId = vector.request.clientId; },
  };
  rejectInBoth(Object.entries(changes).map(([name, modify]) => {
    const state = clone(vector.trustedState); modify(state);
    return {
      name,
      run: () => verifyApprovalSignature(vector.proofs.approval, vector.proofs.request, state, vector.now),
      operation: { op: 'verify_approval', approvalProof: vector.proofs.approval,
        requestProof: vector.proofs.request, trustedState: state, now: vector.now },
    };
  }));
});
