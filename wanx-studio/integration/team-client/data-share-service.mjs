import { randomUUID } from 'node:crypto';
const fail = code => Object.assign(new Error(code), { code });
const actions = new Set(['share-details', 'create-share-key', 'revoke-share-key', 'reveal-share-key', 'copy-share-key', 'copy-share-value', 'release-share-key']);
const nativeBase='/api/semantica/open/v1',nativeScopes=['documents','evidence','graph','search'];
const nativeExample=`const response = await host.request("${nativeBase}/graph?limit=120", {\n  headers: { "X-Xingtu-Key": process.env.STARLINK_KEY }\n});`;
export function createDataShareAccess({ identity, instance, writeClipboard, getMcpDetails, knowledgeCapabilities, identitySecurityEnabled=true }) {
  const secure=identitySecurityEnabled!==false;
  const secrets = new Map();
  const clear = () => { secrets.clear(); if(secure)knowledgeCapabilities?.clear(); };
  async function action(action, input = {}) {
    if (action === 'release-share-key') { secrets.delete(input.handle); return { released: true }; }
    if (secure&&!knowledgeCapabilities) throw fail('TEAM_DATA_CAPABILITY_UNAVAILABLE');
    const { next } = await identity(), warehouseId = input.warehouseId;
    if (typeof warehouseId !== 'string' || !/^[a-f0-9-]{36}$/.test(warehouseId)) throw fail('TEAM_DATA_TARGET_INVALID');
    const live = async () => { if ((await identity()).next !== next) throw fail('TEAM_SESSION_CHANGED'); };
    const service = await instance(), warehouse = await service.call('warehouse', { id: warehouseId });
    const listKeys=()=>secure?knowledgeCapabilities.list(warehouseId):service.call('keys',{warehouseId});
    await live();
    if (action === 'share-details') {
      const keys = await listKeys(), mcp = await getMcpDetails?.(); await live();
      if(!secure){const runtime=await service.call('runtime');await live();return {warehouse:{id:warehouse.id,name:warehouse.name},mcpUrl:mcp?.url||null,mcpConfiguration:mcp?.configuration||null,hostBase:nativeBase,localBase:runtime.api_base_url||null,hostExample:nativeExample,keys:keys.items||[],scopes:nativeScopes,sessionBound:false}}
      return { warehouse: { id: warehouse.id, name: warehouse.name }, mcpUrl: mcp?.url || null, mcpConfiguration: mcp?.configuration || null,
        hostBase: 'session-bound-mcp', localBase: null, hostExample: '仅本机 MCP；关闭会话或锁定后 Key 立即失效。',
        keys: keys.items, scopes: ['documents', 'graph', 'search', 'evidence'], sessionBound: true };
    }
    if (action === 'create-share-key') {
      const name=String(input.name||'').trim(),days=Number(input.days);
      if(!secure&&(!name||name.length>60||!Number.isInteger(days)||days<1||days>365))throw fail('TEAM_DATA_SHARE_INVALID');
      const grant = secure?await knowledgeCapabilities.create({ warehouseId, name, days }):await service.call('create-key',{warehouseId,name,days,scopes:nativeScopes,operationId:randomUUID()}); await live();
      if(!grant.token)throw fail('TEAM_DATA_KEY_NOT_REPLAYABLE');
      const handle = randomUUID(); secrets.clear(); secrets.set(handle, { warehouseId, keyId: grant.key.id, token: grant.token, scope: next });
      return { key: grant.key, handle, oneTimeDisplay: true };
    }
    if (action === 'revoke-share-key') {const result=secure?await knowledgeCapabilities.revoke({ warehouseId, id: input.keyId }):await service.call('revoke-key',{warehouseId,id:input.keyId,operationId:randomUUID()});await live();return result;}
    if (['reveal-share-key', 'copy-share-key'].includes(action)) {
      const value = secrets.get(input.handle);
      if (!value || value.scope !== next || value.warehouseId !== warehouseId) throw fail('TEAM_DATA_KEY_NOT_REPLAYABLE');
      const keys = await listKeys();
      if (!keys.items.some(key => key.id === value.keyId && !key.revoked_at && key.expires_at * 1000 > Date.now())) { secrets.delete(input.handle); throw fail('TEAM_DATA_KEY_REVOKED'); }
      await live();
      if (action === 'reveal-share-key') return { token: value.token };
      if (!writeClipboard) throw fail('TEAM_CLIPBOARD_UNAVAILABLE'); writeClipboard(value.token); return { copied: true };
    }
    if (action === 'copy-share-value') {
      if(!secure&&['host-base','host-example','local-base'].includes(input.kind)){const text=input.kind==='host-base'?nativeBase:input.kind==='host-example'?nativeExample:(await service.call('runtime')).api_base_url;await live();if(typeof text!=='string'||!text)throw fail('TEAM_DATA_SHARE_INVALID');if(!writeClipboard)throw fail('TEAM_CLIPBOARD_UNAVAILABLE');writeClipboard(text);return {copied:true}}
      if (!['mcp-url', 'mcp-config'].includes(input.kind)) throw fail('TEAM_DATA_SHARE_INVALID');
      const mcp = await getMcpDetails?.(), text = input.kind === 'mcp-url' ? mcp?.url : mcp?.configuration ? JSON.stringify(mcp.configuration, null, 2) : null;
      if (typeof text !== 'string' || !text) throw fail('TEAM_DATA_SHARE_INVALID');
      await live(); if (!writeClipboard) throw fail('TEAM_CLIPBOARD_UNAVAILABLE'); writeClipboard(text); return { copied: true };
    }
    throw fail('TEAM_DATA_ACTION_DENIED');
  }
  return { supports: name => actions.has(name), action, clear };
}
