// Presentation/cache namespaces only. These helpers never authorize a request.
// The data session and the box's current authority remain the enforcement points.
const text = value => typeof value === 'string' && value.length > 0;
export function localDataSelection(state) {
  const identity = state?.dataIdentity;
  const selected = identity?.selected;
  if (identity?.phase !== 'unlocked' || !text(identity.profileId) || !text(identity.clientId)
    || !Number.isSafeInteger(identity.generation) || identity.generation < 0
    || !selected || !['boxId', 'boxKeyThumbprint', 'principalId', 'bindingId', 'sessionId'].every(key => text(selected[key]))
    || !Number.isSafeInteger(selected.ownershipEpoch) || selected.ownershipEpoch < 1
    || !Number.isSafeInteger(selected.authorizationVersion) || selected.authorizationVersion < 1) return null;
  if (state.connection?.authorization === 'local-trust-v1'
    && state.connection.deviceId !== selected.boxId) return null;
  return selected;
}

export function dataOwnerKey(state, serviceURL = '') {
  // Locking an established local identity also hides cached private data while
  // the asynchronous connection shutdown is still publishing its final state.
  if (state?.dataIdentity?.profileId || state?.connection?.authorization === 'local-trust-v1' || state?.dataIdentity?.selected) {
    const selected = localDataSelection(state);
    return selected ? JSON.stringify(['local-trust-v1', state.dataIdentity.profileId,
      selected.boxId, selected.boxKeyThumbprint, selected.ownershipEpoch, selected.principalId]) : null;
  }
  return state?.account?.phase === 'authenticated' && text(state.account.accountId)
    ? JSON.stringify([serviceURL, state.account.accountId]) : null;
}

export function dataInteractionKey(state, serviceURL = '') {
  const owner = dataOwnerKey(state, serviceURL);
  if (!owner || state?.phase !== 'ready' || !text(state.connection?.deviceId)) return null;
  if (state?.dataIdentity?.profileId || state.connection.authorization === 'local-trust-v1') {
    if (state.connection.authorization !== 'local-trust-v1') return null;
    const selected = localDataSelection(state);
    return selected ? JSON.stringify([owner, state.dataIdentity.clientId, state.dataIdentity.generation,
      selected.bindingId, selected.authorizationVersion, selected.sessionId]) : null;
  }
  return JSON.stringify([owner, state.account.clientId, state.connection.deviceId, state.connection.gatewayURL]);
}
