import test from 'node:test';
import assert from 'node:assert/strict';
import { dataOwnerKey, dataInteractionKey } from '../device-trust/data-context.mjs';

const state = () => ({ phase: 'ready', account: { phase: 'anonymous' },
  connection: { authorization: 'local-trust-v1', deviceId: 'box-a' },
  dataIdentity: { phase: 'unlocked', profileId: 'profile-a', clientId: 'client-a', generation: 1,
    selected: { boxId: 'box-a', boxKeyThumbprint: 'box-pin-a', principalId: 'principal-a', bindingId: 'binding-a', ownershipEpoch: 1,
      authorizationVersion: 1, sessionId: 'session-a' } } });

test('local cache identity is independent from cloud billing and connection lease', () => {
  const original = state(); const changed = structuredClone(original);
  changed.account = { phase: 'authenticated', accountId: 'cloud-b', clientId: 'cloud-client' };
  changed.dataIdentity.selected.sessionId = 'session-b'; changed.dataIdentity.generation++;
  assert.equal(dataOwnerKey(original, 'cloud-a'), dataOwnerKey(changed, 'cloud-b'));
  assert.notEqual(dataInteractionKey(original), dataInteractionKey(changed));
  for (const field of ['boxId', 'boxKeyThumbprint', 'principalId', 'ownershipEpoch']) {
    const other = state();
    other.dataIdentity.selected[field] = field === 'ownershipEpoch' ? 2 : 'other';
    if (field === 'boxId') other.connection.deviceId = 'other';
    assert.notEqual(dataOwnerKey(original), dataOwnerKey(other));
  }
});

test('local lock or damaged selection cannot fall back to a signed-in cloud identity', () => {
  for (const mutate of [value => { value.dataIdentity.phase = 'locked'; },
    value => { value.dataIdentity.selected = null; },
    value => { value.dataIdentity.selected = null; value.connection = null; },
    value => { value.dataIdentity.selected.principalId = ''; },
    value => { value.connection.deviceId = 'different-box'; }]) {
    const value = state(); value.account = { phase: 'authenticated', accountId: 'cloud-a' }; mutate(value);
    assert.equal(dataOwnerKey(value), null); assert.equal(dataInteractionKey(value), null);
  }
});

test('a stale legacy connection cannot act for an unlocked local identity', () => {
  const value = state(); value.connection = { deviceId: 'box-a' };
  assert.equal(dataInteractionKey(value), null);
});

test('legacy namespaces remain distinct and unchanged before local protection', () => {
  const value = { phase: 'ready', account: { phase: 'authenticated', accountId: 'cloud-a', clientId: 'cloud-client' },
    connection: { deviceId: 'box-a', gatewayURL: 'http://127.0.0.1:12345' } };
  assert.equal(dataOwnerKey(value, 'cloud-origin'), JSON.stringify(['cloud-origin', 'cloud-a']));
  assert.notEqual(dataOwnerKey(value), dataOwnerKey(state()));
  assert.equal(dataOwnerKey({ account: { phase: 'anonymous' } }), null);
});
