import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { DATA_HEADER_FIELDS, DataProtocolError, signSession, signSessionIntent, signHeartbeat, signClose, signRequest, signRenewal,
  validateSessionPayload, validateSessionIntentPayload, validateRequestPayload, validateRawTarget, validateDataHeaders,
  verifyDataResponse } from '../device-trust/data-contract.mjs';

const v = JSON.parse(readFileSync(new URL('../../contracts/local-trust/data-v1/vectors.json', import.meta.url)));
const privateKey = name => createPrivateKey({ key: v.privateJwks[name], format: 'jwk' });
const opts = kind => ({ descriptor: v.descriptor, kind, nowMs: v.nowMs });
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const signedResponse = (value, key = privateKey('box')) => {
  const input = `${Buffer.from(canonical({ alg: 'ES256', typ: 'centuarai-local-data-response+jws' })).toString('base64url')}.${Buffer.from(canonical(value)).toString('base64url')}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
};
const responseValue = kind => JSON.parse(Buffer.from(v.responses[kind].jws.split('.')[1], 'base64url'));

for (const [kind, signer] of Object.entries({ session: signSession, 'session-intent': signSessionIntent, heartbeat: signHeartbeat, close: signClose, request: signRequest, renewal: signRenewal })) {
  test(`${kind}: generated Node and stored Python proofs share exact canonical payload and ECDSA`, () => {
    const key = privateKey(['session', 'session-intent'].includes(kind) ? 'access' : 'channel');
    for (const proof of [signer(v.payloads[kind], key), v.pythonProofs[kind], v.nodeProofs[kind]]) {
      const [header, payload, signature] = proof.split('.');
      assert.equal(Buffer.from(payload, 'base64url').toString(), canonical(v.payloads[kind]));
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', typ: `centuarai-local-data-${kind}+jws` });
      assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), { key: createPublicKey(key), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    }
  });
}

for (const kind of Object.keys(v.responses)) {
  test(`${kind}: Python box response verifies with exact expected context and frozen result`, () => {
    const result = verifyDataResponse(v.responses[kind].jws, { ...opts(kind), expected: v.responses[kind].body });
    assert.deepEqual(result.body, v.responses[kind].body);
    assert.equal(Object.isFrozen(result.body), true);
    assert.throws(() => verifyDataResponse(v.responses[kind].jws, { ...opts(kind), expected: { missing: null } }), DataProtocolError);
  });
}

test('signers reject wrong key purpose, private JWK injection and accessor input without invoking it', () => {
  const same = structuredClone(v.payloads.session); same.channelKey = createPublicKey(privateKey('access')).export({ format: 'jwk' });
  assert.throws(() => signSession(same, privateKey('access')), DataProtocolError);
  assert.throws(() => signRequest(v.payloads.request, createPublicKey(privateKey('channel'))), DataProtocolError);
  const bad = structuredClone(v.payloads.session); bad.channelKey = v.privateJwks.channel;
  assert.throws(() => validateSessionPayload(bad), DataProtocolError);
  let read = false; const getter = { ...v.payloads.request };
  Object.defineProperty(getter, 'method', { enumerable: true, get() { read = true; return 'GET'; } });
  assert.throws(() => signRequest(getter, privateKey('channel')), DataProtocolError); assert.equal(read, false);
});

test('all request/session fields are required and unknown fields rejected', () => {
  for (const [kind, validator] of [['session', validateSessionPayload], ['session-intent', validateSessionIntentPayload], ['request', validateRequestPayload]]) {
    const source = v.payloads[kind];
    for (const name of Object.keys(source)) {
      const bad = structuredClone(source); delete bad[name]; assert.throws(() => validator(bad), DataProtocolError, name);
      for (const wrong of [[], {}, true]) {
        const badType = { ...source, [name]: wrong }; assert.throws(() => validator(badType), DataProtocolError, name);
      }
    }
    assert.throws(() => validator({ ...source, other: null }), DataProtocolError);
  }
});

test('all twelve headers bind capabilities and actual body digest; missing/duplicate/CRLF/large selector denied', () => {
  assert.equal(DATA_HEADER_FIELDS.length, 12); assert.ok(v.payloads.request.headers.spaceLink); assert.ok(v.payloads.request.headers.contentSha256);
  for (const name of DATA_HEADER_FIELDS) {
    const bad = structuredClone(v.payloads.request.headers); delete bad[name]; assert.throws(() => validateDataHeaders(bad), DataProtocolError);
    for (const value of ['', 'a\r\nb', 'x'.repeat(4097), ['duplicate']]) {
      assert.throws(() => validateDataHeaders({ ...v.payloads.request.headers, [name]: value }), DataProtocolError);
    }
  }
});

test('ambiguous paths and credential query parameters reject identically to Python', () => {
  for (const path of ['//elsewhere', '/a/../b', '/a/./b', '/a//b', '/a%2fb', '/a%252fb', '/%41', '/a\\b', '/a#fragment', '/a?token=x', '/a?%61ccess_token=x', '/a?AUTHORIZATION=x', '/a?data_proof=x', '/a?gateway_proof=x', '/a%GG', '/%ff', '/a\nb']) {
    assert.throws(() => validateRawTarget(path), DataProtocolError, path);
  }
  for (const path of ['/', '/api/files/abc?offset=1&length=8', '/api/%E4%BD%A0', '/api/files?name=a%20b']) assert.equal(validateRawTarget(path), path);
});

test('websocket proof commits actual upgrade key/protocol and empty body', () => {
  const request = structuredClone(v.payloads.request);
  Object.assign(request, { transport: 'websocket', method: 'GET', bodyBytes: 0, bodySha256: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU' });
  request.headers.webSocketKey = 'synthetic-upgrade-key'; request.headers.webSocketProtocol = 'chat-v1';
  validateRequestPayload(request);
  assert.throws(() => validateRequestPayload({ ...request, bodyBytes: 1 }), DataProtocolError);
  assert.throws(() => validateRequestPayload({ ...request, headers: { ...request.headers, webSocketKey: null } }), DataProtocolError);
  assert.throws(() => validateRequestPayload({ ...request, transport: 'http' }), DataProtocolError);
});

test('response rejects attacker signing key, other kind, future/exact expiry and downgraded context', () => {
  const value = responseValue('session');
  assert.throws(() => verifyDataResponse(signedResponse(value, privateKey('channel')), opts('session')), DataProtocolError);
  assert.throws(() => verifyDataResponse(v.responses.session.jws, opts('heartbeat')), DataProtocolError);
  for (const nowMs of [v.nowMs - 1, v.nowMs + 3000]) assert.throws(() => verifyDataResponse(v.responses.session.jws, { ...opts('session'), nowMs }), DataProtocolError);
  assert.throws(() => verifyDataResponse(v.responses.session.jws, { ...opts('session'), expected: { authorization: { ...value.body.authorization, ownershipEpoch: 2 } } }), DataProtocolError);
  value.body.authorization.boxId = 'box:other';
  assert.throws(() => verifyDataResponse(signedResponse(value), opts('session')), DataProtocolError);
});

test('response rejects duplicate/noncanonical JSON, JOSE key selection, padding and unknown count fields', () => {
  const proof = v.responses.heartbeat.jws; const [header, payload, signature] = proof.split('.');
  const raw = Buffer.from(payload, 'base64url').toString();
  for (const altered of [` ${raw}`, `${raw.slice(0, -1)},"schemaVersion":1}`, raw.replace('"schemaVersion":1', '"schemaVersion":1.0')]) {
    assert.throws(() => verifyDataResponse(`${header}.${Buffer.from(altered).toString('base64url')}.${signature}`, opts('heartbeat')), DataProtocolError);
  }
  assert.throws(() => verifyDataResponse(`${proof}=`, opts('heartbeat')), DataProtocolError);
  const hdr = { alg: 'ES256', typ: 'centuarai-local-data-response+jws', kid: 'attacker' };
  assert.throws(() => verifyDataResponse(`${Buffer.from(canonical(hdr)).toString('base64url')}.${payload}.${signature}`, opts('heartbeat')), DataProtocolError);
  const effect = responseValue('effect'); effect.body.effectState = 'effective';
  assert.throws(() => verifyDataResponse(signedResponse(effect), opts('effect')), DataProtocolError);
});
