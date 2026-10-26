import { randomUUID } from 'node:crypto';
const fail = code => Object.assign(new Error(code), { code });
const actions = new Set(['share-details', 'create-share-key', 'revoke-share-key', 'reveal-share-key', 'copy-share-key', 'copy-share-value', 'release-share-key']);
export function createDataShareAccess({ identity, instance, writeClipboard, getMcpDetails, knowledgeCapabilities }) {
  const secrets = new Map();
  const clear = () => { secrets.clear(); knowledgeCapabilities?.clear(); };
  async function action(action, input = {}) {
    if (action === 'release-share-key') { secrets.delete(input.handle); return { released: true }; }
    if (!knowledgeCapabilities) throw fail('TEAM_DATA_CAPABILITY_UNAVAILABLE');
    const { next } = await identity(), warehouseId = input.warehouseId;
    if (typeof warehouseId !== 'string' || !/^[a-f0-9-]{36}$/.test(warehouseId)) throw fail('TEAM_DATA_TARGET_INVALID');
    const live = async () => { if ((await identity()).next !== next) throw fail('TEAM_SESSION_CHANGED'); };
    const service = await instance(), warehouse = await service.call('warehouse', { id: warehouseId });
    await live();
    if (action === 'share-details') {
      const keys = await knowledgeCapabilities.list(warehouseId), mcp = await getMcpDetails?.(); await live();
      return { warehouse: { id: warehouse.id, name: warehouse.name }, mcpUrl: mcp?.url || null, mcpConfiguration: mcp?.configuration || null,
        hostBase: 'session-bound-mcp', localBase: null, hostExample: '仅本机 MCP；关闭会话或锁定后 Key 立即失效。',
        keys: keys.items, scopes: ['documents', 'graph', 'search', 'evidence'], sessionBound: true };
    }
    if (action === 'create-share-key') {
      const grant = await knowledgeCapabilities.create({ warehouseId, name: String(input.name || '').trim(), days: Number(input.days) }); await live();
      const handle = randomUUID(); secrets.clear(); secrets.set(handle, { warehouseId, keyId: grant.key.id, token: grant.token, scope: next });
      return { key: grant.key, handle, oneTimeDisplay: true };
    }
    if (action === 'revoke-share-key') return knowledgeCapabilities.revoke({ warehouseId, id: input.keyId });
    if (['reveal-share-key', 'copy-share-key'].includes(action)) {
      const value = secrets.get(input.handle);
      if (!value || value.scope !== next || value.warehouseId !== warehouseId) throw fail('TEAM_DATA_KEY_NOT_REPLAYABLE');
      const keys = await knowledgeCapabilities.list(warehouseId);
      if (!keys.items.some(key => key.id === value.keyId && !key.revoked_at && key.expires_at * 1000 > Date.now())) { secrets.delete(input.handle); throw fail('TEAM_DATA_KEY_REVOKED'); }
      await live();
      if (action === 'reveal-share-key') return { token: value.token };
      if (!writeClipboard) throw fail('TEAM_CLIPBOARD_UNAVAILABLE'); writeClipboard(value.token); return { copied: true };
    }
    if (action === 'copy-share-value') {
      if (!['mcp-url', 'mcp-config'].includes(input.kind)) throw fail('TEAM_DATA_SHARE_INVALID');
      const mcp = await getMcpDetails?.(), text = input.kind === 'mcp-url' ? mcp?.url : mcp?.configuration ? JSON.stringify(mcp.configuration, null, 2) : null;
      if (typeof text !== 'string' || !text) throw fail('TEAM_DATA_SHARE_INVALID');
      await live(); if (!writeClipboard) throw fail('TEAM_CLIPBOARD_UNAVAILABLE'); writeClipboard(text); return { copied: true };
    }
    throw fail('TEAM_DATA_ACTION_DENIED');
  }
  return { supports: name => actions.has(name), action, clear };
}
