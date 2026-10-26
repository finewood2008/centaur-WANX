import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamConnection } from '../shell/team-connection.mjs';
function fixture(legacy) {
  const calls = [];
  let state = { phase: 'disconnected', account: { phase: 'signed_out' }, dataIdentity: { phase: 'locked' } };
  const base = { snapshot: () => state, initialize: async () => calls.push('cloud.restore'), subscribe: () => () => {},
    connectLocalBox: async id => { calls.push('local:' + id); state = { ...state, dataIdentity: { phase: 'unlocked' }, connection: { authorization: 'local-trust-v1' } }; },
    connectBox: () => assert.fail('legacy connector must not run'), applicationRequest: async value => value,
    logout: async () => { calls.push('cloud.logout'); } };
  const client = createTeamConnection({ base, localDataAccess: { isProtectedBox: id => id === 'approved-box' },
    deviceTrust: { lock: () => calls.push('local.lock') }, store: { load: async () => legacy, clear: () => assert.fail('migration input must be preserved') } });
  return { client, calls, set: value => state = value };
}
test('legacy team JWT only marks migration; cloud restore never sends it to a box', async () => {
  const f = fixture({ origin: 'https://retired.invalid', token: 'never-transmit', expiresAt: Date.now() + 10000 });
  const value = await f.client.initialize();
  assert.equal(value.team.legacyMigrationRequired, true); assert.deepEqual(f.calls, ['cloud.restore']);
  await assert.rejects(f.client.teamLogin({ username: 'old', password: 'secret' }), { code: 'TEAM_CLOUD_LOGIN_REQUIRED' });
  await assert.rejects(f.client.teamJoin({ code: 'old' }), { code: 'TEAM_DEVICE_APPROVAL_REQUIRED' });
  await assert.rejects(f.client.connectBox('unknown'), { code: 'TEAM_DEVICE_APPROVAL_REQUIRED' });
  await assert.rejects(f.client.applicationRequest({ path: '/api/auth/me' }), { code: 'TEAM_DEVICE_APPROVAL_REQUIRED' });
});
test('approved local binding gates business access and logout locks signing before awaiting cloud', async () => {
  const f = fixture(null); await f.client.connectBox('approved-box');
  assert.deepEqual(await f.client.applicationRequest({ path: '/api/auth/me' }), { path: '/api/auth/me' });
  await f.client.logout(); assert.deepEqual(f.calls, ['local:approved-box', 'local.lock', 'cloud.logout']);
  f.set({ dataIdentity: { phase: 'unlocked' }, connection: { authorization: 'legacy-jwt' } });
  await assert.rejects(f.client.applicationRequest({ path: '/api/auth/me' }), { code: 'TEAM_DEVICE_APPROVAL_REQUIRED' });
});
