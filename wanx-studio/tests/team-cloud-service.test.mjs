import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamService } from '../integration/team-client/service.mjs';
const appId = 'ai.wanx.selfmade.' + 'a'.repeat(32), resource = 'team:application:' + appId;
function fixture({ permissions = [], role = 'user' } = {}) {
  const calls = [], membershipId = Buffer.alloc(32, 0x6d).toString('base64url'), principalId = 'synthetic-member';
  const me = { id: 42, username: 'cloud-member', role, application_id: 'wanx', team: { boxId: 'box', principalId, membershipId, roleId: 'member', permissions } };
  const context = { user: { id: 42 }, authorization: 'local-trust-v1', boxId: 'box', principalId,
    dataIdentity: { bindingId: 'binding', generation: 1, grants: [{ resourceId: resource, actions: ['read'] }] } };
  const client = { applicationConnection: async id => { assert.equal(id, undefined); return { context: () => context, request: async input => {
    calls.push(input); const body = input.path === '/api/admin/applications/' + appId + '/access' ? { accepted: true } : input.path === '/api/auth/me' ? me : input.path === '/api/app-studio/apps/' + appId ? { project: { id: 'a'.repeat(32), name: 'approved', installed: { artifactHash: 'c'.repeat(64) } } } : null;
    return { status: body ? 200 : 403, body: Buffer.from(JSON.stringify(body)), headers: {} };
  } }; } };
  const service = createTeamService({ client, applications: {}, deviceTrust: { refreshTeam: async () => ({ members: [{ membershipId, principalId, subject: 'cloud-account', roleId: 'member', status: 'active' }], invitations: [] }) }, openDeviceTrust: async input => calls.push(input) });
  return { service, calls, membershipId };
}
test('ordinary member catalog derives each precise approved application selector, never drafts or broad directory', async () => {
  const f = fixture(); const identity = await f.service.identity();
  assert.equal(identity.membershipId, f.membershipId); assert.deepEqual(identity.permissions, []); assert.equal('role' in identity, false);
  const catalog = await f.service.action('catalog'); assert.equal(catalog[0].appId, appId);
  const request = f.calls.find(input => input.path === '/api/app-studio/apps/' + appId);
  assert.equal(request.headers['x-wanx-data-context'], resource);
  assert.equal(f.calls.some(input => input.path?.includes('/projects') || input.path === '/api/users'), false);
  await assert.rejects(f.service.action('members'), { code: 'TEAM_ADMIN_REQUIRED' });
});
test('native admin flag cannot authorize a cloud team; trusted security surface handles invitations', async () => {
  const legacy = fixture({ role: 'admin', permissions: ['applications.manage'] });
  await assert.rejects(legacy.service.identity(), { code: 'TEAM_IDENTITY_INVALID' });
  const f = fixture(); assert.deepEqual(await f.service.action('join', { password: 'ignored' }), { opened: true });
  assert.deepEqual(f.calls, [{ view: 'team' }]);
});

test('application access accepts canonical membership digests with underscore or dash prefixes and rejects noncanonical tail bits', async () => {
  const f = fixture({ permissions: ['applications.manage'] });
  for (const first of [0xfc, 0xf8]) {
    const bytes = Buffer.alloc(32); bytes[0] = first;
    const membershipId = bytes.toString('base64url');
    assert.match(membershipId, /^[_-]/);
    assert.deepEqual(await f.service.action('access', { applicationId: appId, membershipId, enabled: true }), { accepted: true });
    assert.deepEqual(JSON.parse(f.calls.at(-1).body), { membership_id: membershipId, enabled: true });
    const before = f.calls.filter(call => call.path.endsWith('/access')).length;
    for (const invalid of [membershipId.slice(0, -1) + 'B', membershipId + '=', membershipId.slice(1), membershipId + 'A'])
      await assert.rejects(f.service.action('access', { applicationId: appId, membershipId: invalid, enabled: true }), { code: 'TEAM_INPUT_INVALID' });
    assert.equal(f.calls.filter(call => call.path.endsWith('/access')).length, before);
  }
});
