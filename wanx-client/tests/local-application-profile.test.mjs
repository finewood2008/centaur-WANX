import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localApplicationProfile, prepareApplicationProfile, applicationProfilePath } from '../applications/data-profile.mjs';
import { createApplicationSession } from '../app-host/session.mjs';

const identity = () => ({ profileId: 'profile-a', boxId: 'box-a', boxKeyThumbprint: 'box-pin-a', ownershipEpoch: 1, principalId: 'principal-a' });
test('local application profiles isolate identity and epoch, while reconnecting preserves data', () => {
  const original = identity(), key = localApplicationProfile(original);
  assert.equal(localApplicationProfile({ ...original, sessionId: 'new-session', billingAccountId: 'different' }), key);
  for (const field of Object.keys(original)) assert.notEqual(localApplicationProfile({ ...original, [field]: field === 'ownershipEpoch' ? 2 : 'other' }), key);
  assert.throws(() => localApplicationProfile({ profileId: 'profile-a', phase: 'locked' }));
  assert.throws(() => applicationProfilePath('/tmp', '../app', key));
});
test('local application directories cannot adopt shared profiles or follow symlinks', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'local-app-profile-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = localApplicationProfile(identity());
  const directory = await prepareApplicationProfile(root, 'test.app', key);
  assert.equal(directory, applicationProfilePath(root, 'test.app', key));
  assert.notEqual(directory, path.join(root, '.runtime', 'test.app'));
  if (process.platform === 'win32') return;
  await rm(directory, { recursive: true }); const other = path.join(root, 'other'); await mkdir(other); await symlink(other, directory);
  await assert.rejects(prepareApplicationProfile(root, 'test.app', key), { code: 'APPLICATION_DATA_CONTEXT_REQUIRED' });
});
test('Host owns its independent local launch session and revokes immediately on data invalidation', async t => {
  let input, listener, closes = 0, invalidations = 0, live = true;
  const session = await createApplicationSession({ hostApplicationId: 'wanx-host', applicationId: 'test.app',
    capabilities: ['http.request'], installPath: '/synthetic', createConnection: async options => {
      input = options;
      return { kind: 'local-trust-v1', context() { if (!live) throw Error('closed'); return { connection: 'ready', dataIdentity: identity() }; },
        onInvalidated(fn) { listener = fn; return () => { listener = null; }; }, close() { closes++; live = false; } };
    } });
  t.after(() => session.close());
  assert.equal(input.launchId, session.launchId); assert.match(input.launchId, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(input.capabilities, ['http.request']);
  assert.equal(session.dataProfile, localApplicationProfile(identity()));
  session.onInvalidated(() => invalidations++);
  listener();
  assert.equal(invalidations, 1); assert.equal(closes, 1);
  assert.throws(() => session.assertLive(), { code: 'HOST_SESSION_EXPIRED' });
  await session.close(); assert.equal(closes, 1);
});
