import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const fail = () => Object.assign(new Error('APPLICATION_DATA_CONTEXT_REQUIRED'), { code: 'APPLICATION_DATA_CONTEXT_REQUIRED' });

// Stable storage identity, deliberately excluding billing identity and session ID.
export function localApplicationProfile(identity) {
  if (!identity || typeof identity !== 'object') throw fail();
  const selected = identity.selected || identity;
  if (identity.phase && identity.phase !== 'unlocked') throw fail();
  if (![identity.profileId, selected.boxId, selected.boxKeyThumbprint, selected.principalId].every(value => typeof value === 'string' && value.length > 0)
    || !Number.isSafeInteger(selected.ownershipEpoch) || selected.ownershipEpoch < 1) throw fail();
  return createHash('sha256').update(JSON.stringify(['local-trust-v1', identity.profileId,
    selected.boxId, selected.boxKeyThumbprint, selected.ownershipEpoch, selected.principalId])).digest('hex');
}

export function applicationProfilePath(root, applicationId, profile) {
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(applicationId) || !/^[a-f0-9]{64}$/.test(profile)) throw fail();
  return path.join(root, '.runtime', 'local', profile, applicationId);
}

export async function prepareApplicationProfile(root, applicationId, profile) {
  applicationProfilePath(root, applicationId, profile);
  const resolved = await realpath(root);
  let current = resolved;
  for (const part of ['.runtime', 'local', profile, applicationId]) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw fail();
  }
  if (current !== applicationProfilePath(resolved, applicationId, profile)) throw fail();
  return current;
}
