const fail = code => Object.assign(new Error(code), { code });

// Team login always authenticates a Consumer account. A legacy local JWT is
// retained only as a migration signal; it is never restored or exchanged.
export function createTeamConnection({ base, localDataAccess, deviceTrust, store }) {
  let migrationRequired = false;
  const snapshot = () => ({ ...base.snapshot(), team: { legacyMigrationRequired: migrationRequired } });
  const trusted = () => {
    const state = base.snapshot();
    if (state.connection?.authorization !== 'local-trust-v1' || state.dataIdentity?.phase !== 'unlocked')
      throw fail('TEAM_DEVICE_APPROVAL_REQUIRED');
  };
  const connect = async (deviceId, options) => {
    if (typeof deviceId !== 'string' || !deviceId || !localDataAccess?.isProtectedBox(deviceId))
      throw fail('TEAM_DEVICE_APPROVAL_REQUIRED');
    await base.connectLocalBox(deviceId, options);
    trusted();
    return snapshot();
  };
  const own = {
    snapshot,
    isTeamDirect: () => false,
    async initialize() {
      // Do not clear a damaged store or try its bearer against any server. The
      // user may still need the old association for the explicit migration.
      try { migrationRequired = Boolean(await store?.load()); }
      catch { migrationRequired = true; }
      await base.initialize();
      return snapshot();
    },
    async teamLogin() { throw fail('TEAM_CLOUD_LOGIN_REQUIRED'); },
    async teamJoin() { throw fail('TEAM_DEVICE_APPROVAL_REQUIRED'); },
    connect: input => connect(input?.deviceId),
    connectBox: connect,
    connectLocalBox: connect,
    async applicationContext(...args) { trusted(); return base.applicationContext(...args); },
    async applicationConnection(...args) { trusted(); return base.applicationConnection(...args); },
    async applicationRequest(...args) { trusted(); return base.applicationRequest(...args); },
    async applicationStream(...args) { trusted(); return base.applicationStream(...args); },
    async logout() {
      // End local signing intents before waiting for a cloud logout response.
      deviceTrust?.lock('team-logout');
      await base.logout();
      return snapshot();
    },
    subscribe(listener) { return base.subscribe(() => listener(snapshot())); },
  };
  return new Proxy(base, { get(target, key) {
    return key in own ? own[key] : typeof target[key] === 'function' ? target[key].bind(target) : target[key];
  } });
}
