import { createHash, randomBytes, randomUUID } from 'node:crypto';
const fail = code => Object.assign(new Error(code), { code, status: 403 });
const warehouse = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = token => createHash('sha256').update(token).digest('base64url');
// Main-memory, session-bound capabilities for explicit local MCP sharing. Never
// serialized, never accepted as a cloud login or forwarded to the box.
export function createKnowledgeCapabilities({ client, clock = Date.now }) {
  const entries = new Map(); let closed = false;
  const scope = () => {
    const state = client.snapshot(), identity = state.dataIdentity, selected = identity?.selected;
    if (closed || state.phase !== 'ready' || state.connection?.authorization !== 'local-trust-v1'
      || identity?.phase !== 'unlocked' || !selected) return null;
    return JSON.stringify([identity.profileId, identity.generation, selected.boxId || state.connection.deviceId,
      selected.boxKeyThumbprint, selected.ownershipEpoch, selected.principalId, selected.bindingId]);
  };
  let previous = scope();
  const clear = () => entries.clear();
  const unsubscribe = client.subscribe(() => { const next = scope(); if (next !== previous) { previous = next; clear(); } });
  const current = entry => {
    if (!scope() || entry.scope !== scope() || entry.expires_at * 1000 <= clock() || entry.revoked_at) throw fail('TEAM_DATA_KEY_REVOKED');
  };
  const linkFor = async warehouseId => {
    if (!warehouse(warehouseId) || !scope()) throw fail('TEAM_DATA_TARGET_INVALID');
    const captured = scope(), connection = await client.applicationConnection();
    if (captured !== scope()) throw fail('TEAM_SESSION_CHANGED');
    const context = connection.context(), resourceId = 'team:knowledge:' + warehouseId;
    if (context.authorization !== 'local-trust-v1' || !context.dataIdentity?.grants?.some(grant => grant.resourceId === resourceId && grant.actions.includes('read')))
      throw fail('TEAM_RESOURCE_APPROVAL_REQUIRED');
    return { captured, connection, resourceId };
  };
  const fence = connection => { const value = connection.context().dataIdentity; if (!value?.sessionId || !Number.isSafeInteger(value.authorizationVersion)) throw fail('TEAM_SESSION_CHANGED'); return JSON.stringify([value.sessionId, value.authorizationVersion, value.principalId, value.bindingId, value.ownershipEpoch]); };
  const publicEntry = entry => Object.fromEntries(['id', 'name', 'prefix', 'scopes', 'expires_at', 'revoked_at'].map(key => [key, structuredClone(entry[key])]));
  return {
    async create({ warehouseId, name, days }) {
      if (typeof name !== 'string' || !name.trim() || name.length > 60 || !Number.isInteger(days) || days < 1 || days > 365) throw fail('TEAM_DATA_SHARE_INVALID');
      const { captured, connection } = await linkFor(warehouseId);
      for (const [key, entry] of entries) if (entry.expires_at * 1000 <= clock() || entry.scope !== captured) entries.delete(key);
      if (entries.size >= 32) throw fail('TEAM_DATA_KEY_CAPACITY');
      const token = 'wmcp_' + randomBytes(32).toString('base64url'), entry = { id: randomUUID(), name: name.trim(), prefix: token.slice(0, 12),
        warehouseId, scope: captured, fence: fence(connection), scopes: ['documents', 'graph', 'search', 'evidence'], expires_at: Math.floor(clock() / 1000) + Math.min(days, 1) * 86400, revoked_at: null };
      entries.set(digest(token), entry); return { key: publicEntry(entry), token };
    },
    async list(warehouseId) { const { captured, connection } = await linkFor(warehouseId); const currentFence = fence(connection); for (const [key, entry] of entries) if (entry.fence !== currentFence) entries.delete(key); return { items: [...entries.values()].filter(entry => entry.scope === captured && entry.warehouseId === warehouseId).map(publicEntry) }; },
    async revoke({ warehouseId, id }) { await linkFor(warehouseId); const entry = [...entries.values()].find(value => value.id === id && value.warehouseId === warehouseId); if (!entry) throw fail('TEAM_DATA_KEY_REVOKED'); entry.revoked_at = Math.floor(clock() / 1000); return { revoked: true }; },
    async resolve(token) {
      if (typeof token !== 'string' || !/^wmcp_[A-Za-z0-9_-]{43}$/.test(token)) throw fail('MCP_KEY_INVALID');
      const entry = entries.get(digest(token)); if (!entry) throw fail('MCP_KEY_INVALID'); current(entry);
      const { connection, resourceId } = await linkFor(entry.warehouseId); current(entry);
      if (entry.fence !== fence(connection)) { entries.delete(digest(token)); throw fail('TEAM_DATA_KEY_REVOKED'); }
      return { warehouseId: entry.warehouseId, connection, resourceId,
        check() { current(entry); if (entry.fence !== fence(connection)) { entries.delete(digest(token)); throw fail('TEAM_DATA_KEY_REVOKED'); } const context = connection.context(); if (!context.dataIdentity?.grants?.some(grant => grant.resourceId === resourceId && grant.actions.includes('read'))) throw fail('TEAM_RESOURCE_APPROVAL_REQUIRED'); } };
    },
    clear,
    close() { closed = true; clear(); unsubscribe(); },
  };
}
