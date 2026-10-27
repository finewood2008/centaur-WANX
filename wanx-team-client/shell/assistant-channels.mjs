import { randomUUID } from 'node:crypto';
import { channelQR } from './channel-qr.mjs';

export const ASSISTANT_CHANNEL_KINDS = ['weixin', 'wecom', 'feishu', 'dingtalk'];
const fields = {
  weixin: [],
  wecom: ['bot_id', 'secret'],
  feishu: ['app_id', 'app_secret', 'encrypt_key', 'verification_token'],
  dingtalk: ['client_id', 'client_secret'],
};
const secrets = new Set(['secret', 'app_secret', 'encrypt_key', 'verification_token', 'client_secret']);
const labels = { weixin: '微信', wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉' };
const fail = code => Object.assign(new Error(code), { code });
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fail('ASSISTANT_INVALID_INPUT');
  return value;
};
const kindOf = value => {
  if (!ASSISTANT_CHANNEL_KINDS.includes(value)) throw fail('ASSISTANT_INVALID_INPUT');
  return value;
};
const summary = row => ({ id: id(row.id), kind: kindOf(row.kind), name: String(row.name || labels[row.kind]).slice(0, 100),
  enabled: row.enabled === true, status: !row.enabled ? 'disabled' : row.runtime?.connected ? 'connected' : row.runtime?.error ? 'error' : 'connecting' });

// Fixed, owner-bound native routes. Raw configs, QR tokens and creator events
// stay here; IPC only returns a small public projection and locally rendered QR.
export function createAssistantChannels({ request, base, assertScope, cleanup }) {
  const sessions = new Map();
  let serial = Promise.resolve();
  const mutate = fn => {
    const pending = serial.catch(() => {}).then(fn);
    serial = pending;
    return pending;
  };
  const active = (key, ticket) => {
    assertScope(key);
    if (sessions.get(ticket.handle) !== ticket || ticket.expires < Date.now()) throw fail('ASSISTANT_CHANNEL_EXPIRED');
  };
  async function existing(key, channelId) {
    const route = `${base()}/${id(channelId)}`, row = await request(key, route);
    summary(row); // Reject unsupported kinds even if a caller guesses an ID.
    if (row.id !== channelId) throw fail('ASSISTANT_INVALID_INPUT');
    return { row, route };
  }
  function cancel(ticket) {
    sessions.delete(ticket.handle);
    if (ticket.kind === 'feishu') void cleanup(ticket.key, ticket.route + '/feishu/bot-creator/stop').catch(() => {});
  }
  function reset() { for (const ticket of [...sessions.values()]) cancel(ticket); }
  const agentId = () => id(base().split('/').at(-2));
  async function ownerBinding(key, channelId) {
    const rows = await request(key, '/api/loops/channel-bindings');
    assertScope(key);
    const rank = {active:0,awaiting_confirmation:1,awaiting_message:2,invalid:3,expired:4,revoked:5};
    return rows.filter(row => row.channel_id === channelId && row.agent_id === agentId())
      .sort((a,b)=>(rank[a.status]??6)-(rank[b.status]??6)||Number(b.created_at||0)-Number(a.created_at||0)||String(b.binding_id).localeCompare(String(a.binding_id)))[0];
  }
  function verification(binding) {
    const pending = binding?.status?.startsWith('awaiting_');
    const status = pending && Number(binding.expires_at)*1000 <= Date.now() ? 'expired' : binding?.status || 'unverified';
    return {status,
      ...(pending ? {expiresAt:Number(binding.expires_at)} : {}),
      ...(status === 'awaiting_confirmation' ? {name:String(binding.display_name||'收到私聊').slice(0,100),preview:String(binding.message_preview||'').slice(0,300)} : {})};
  }
  async function verifyAction(method, input, key) {
    const channelId = id(input.id), {row} = await existing(key, channelId);
    let binding = await ownerBinding(key, channelId);
    if (method === 'channels-verify-start') {
      if (!row.enabled) throw fail('ASSISTANT_CHANNEL_DISABLED');
      const current = verification(binding);
      if (['active','awaiting_confirmation','awaiting_message'].includes(current.status)) return {verification:current};
      if (binding?.status?.startsWith('awaiting_')) await request(key, '/api/loops/channel-bindings/'+id(binding.binding_id), {method:'DELETE'});
      await request(key, '/api/loops/channel-bindings', {method:'POST',body:{agent_id:agentId(),channel_id:channelId}});
      assertScope(key);
      binding = await ownerBinding(key, channelId);
    } else if (method === 'channels-verify-confirm') {
      if (verification(binding).status !== 'awaiting_confirmation') throw fail('ASSISTANT_CHANNEL_VERIFICATION_CHANGED');
      await request(key, '/api/loops/channel-bindings/'+id(binding.binding_id)+'/confirm', {method:'POST'});
      binding = await ownerBinding(key, channelId);
    } else if (method === 'channels-verify-revoke') {
      const bindings=await request(key,'/api/loops/channel-bindings');
      for(const owned of bindings.filter(b=>b.channel_id===channelId&&b.agent_id===agentId()&&['active','awaiting_message','awaiting_confirmation'].includes(b.status)))await request(key, '/api/loops/channel-bindings/'+id(owned.binding_id), {method:'DELETE'});
      binding = await ownerBinding(key, channelId);
    }
    return {verification:verification(binding)};
  }
  async function saveQR(ticket, config) {
    active(ticket.key, ticket);
    // Keep credentials privately for a retry if saving fails after phone approval.
    ticket.config = config;
    const rows = await request(ticket.key, ticket.route);
    active(ticket.key, ticket);
    const credential = { weixin: 'bot_uin', wecom: 'bot_id', feishu: 'app_id' }[ticket.kind];
    for (const row of rows.filter(row => row.kind === ticket.kind)) {
      const detail = await request(ticket.key, ticket.route + '/' + id(row.id));
      active(ticket.key, ticket);
      if (detail.config?.[credential] === config[credential]) {
        // Re-scanning an existing bot refreshes its credentials in place.
        const saved = await request(ticket.key, ticket.route + '/' + id(row.id), {method:'PATCH',body:{config:{...detail.config,...config},enabled:true}});
        active(ticket.key, ticket);
        ticket.result = { status:'success', channel:summary(saved) };
        ticket.config = null;
        return ticket.result;
      }
    }
    const saved = await request(ticket.key, ticket.route, {method:'POST',body:{kind:ticket.kind,name:labels[ticket.kind],config:{response_mode:'stream',show_thinking:false,show_tool_hints:false,...config}}});
    active(ticket.key, ticket);
    ticket.result = {status:'success',channel:summary(saved)};
    ticket.config = null;
    return ticket.result;
  }
  async function poll(key, ticket) {
    active(key, ticket);
    if (ticket.result) return ticket.result;
    if (ticket.config) return mutate(()=>saveQR(ticket, ticket.config));
    const kind = ticket.kind, creator = kind === 'feishu';
    const body = creator ? undefined : kind === 'wecom' ? {scode:ticket.token} : kind === 'dingtalk' ? {registration_id:ticket.token} : {qrcode_token:ticket.token};
    const result = await request(key, ticket.route + '/' + kind + (creator ? '/bot-creator/poll' : '/qrcode/poll'), {method:'POST',body,timeout:50_000});
    active(key, ticket);
    if (kind === 'dingtalk' && result.status === 'success') {
      const {row} = await existing(key,result.channel_id); active(key,ticket);
      return ticket.result = {status:'success',channel:summary(row)};
    }
    if (kind === 'weixin' && result.status === 'success' && result.account_id && result.token) {
      const config = {bot_uin:result.account_id,token:result.token,base_url:result.base_url || 'https://ilinkai.weixin.qq.com'};
      config.accounts = [{...config,account_id:result.account_id}];
      return mutate(()=>saveQR(ticket,config));
    }
    if (kind === 'wecom' && result.status === 'success' && result.bot_id && result.secret) return mutate(()=>saveQR(ticket,{bot_id:result.bot_id,secret:result.secret}));
    if (creator && result.status === 'finished' && result.app_id && result.app_secret) return mutate(()=>saveQR(ticket,{app_id:result.app_id,app_secret:result.app_secret}));
    if (['failed','error','expired','not_started'].includes(result.status) || (creator && result.status === 'finished')) {
      cancel(ticket); return {status:result.status === 'expired' ? 'expired' : 'failed'};
    }
    return {status:'waiting',...(creator && result.qr_url ? {qr:channelQR(result.qr_url)} : {})};
  }
  return {
    reset,
    async action(method, input, key) {
      if (['channels-verification','channels-verify-start','channels-verify-confirm','channels-verify-revoke'].includes(method)) return mutate(()=>verifyAction(method,input,key));
      if (method === 'channels-list') {
        const rows = await request(key,base());
        return {items:await Promise.all(rows.filter(row => ASSISTANT_CHANNEL_KINDS.includes(row.kind)).map(async row=>({...summary(row),verification:verification(await ownerBinding(key,row.id))})))};
      }
      if (method === 'channels-detail') {
        const {row} = await existing(key,input.id), config = row.config || {};
        return {channel:{...summary(row),verification:verification(await ownerBinding(key,row.id))},values:Object.fromEntries(fields[row.kind].filter(f=>!secrets.has(f)).map(f=>[f,String(config[f]||'')])),
          configured:fields[row.kind].filter(f=>secrets.has(f) && !!config[f])};
      }
      if (method === 'channels-save') return mutate(async () => {
        assertScope(key);
        const previous = input.id ? await existing(key,input.id) : null;
        const kind = previous ? previous.row.kind : kindOf(input.kind);
        if (kind === 'weixin') throw fail('ASSISTANT_INVALID_INPUT');
        const config = {...(previous?.row.config || {response_mode:'stream',show_thinking:false,show_tool_hints:false})};
        if (!input.values || typeof input.values !== 'object' || Array.isArray(input.values)) throw fail('ASSISTANT_INVALID_INPUT');
        for (const [field,value] of Object.entries(input.values)) {
          if (!fields[kind].includes(field) || typeof value !== 'string' || value.length > 4096) throw fail('ASSISTANT_INVALID_INPUT');
          if (secrets.has(field) && !value.trim()) continue;
          config[field] = value.trim();
        }
        for (const field of fields[kind].slice(0,2)) if (!config[field]) throw fail('ASSISTANT_CHANNEL_INCOMPLETE');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw fail('ASSISTANT_INVALID_INPUT');
        const row = await request(key,previous?.route || base(), {method:previous ? 'PATCH' : 'POST',body:{...(previous ? {} : {kind}),name:input.name.trim(),config}});
        return {channel:summary(row)};
      });
      if (method === 'channels-toggle' || method === 'channels-delete' || method === 'channels-test') return mutate(async () => {
        const {route} = await existing(key,input.id);
        if (method === 'channels-test') {
          const result = await request(key,route+'/test',{method:'POST'});
          return {valid:result.ok === true};
        }
        if (method === 'channels-delete') { await request(key,route,{method:'DELETE'}); return {}; }
        if (typeof input.enabled !== 'boolean') throw fail('ASSISTANT_INVALID_INPUT');
        return {channel:summary(await request(key,route,{method:'PATCH',body:{enabled:input.enabled}}))};
      });
      if (method === 'channels-start') return mutate(async () => {
        assertScope(key); reset();
        const kind = kindOf(input.kind), ticket = {key,kind,route:base(),handle:randomUUID(),expires:Date.now()+600_000};
        sessions.set(ticket.handle,ticket);
        try {
          const result = await request(key,ticket.route+'/'+kind+(kind==='feishu'?'/bot-creator/start':'/qrcode/generate'),{method:'POST',...(kind==='feishu'?{body:{platform:'feishu'}}:{})});
          active(key,ticket);
          ticket.token = result.qrcode_token || result.scode || result.registration_id;
          return {handle:ticket.handle,status:'waiting',interval:kind==='dingtalk'?Math.max(1,Math.min(Number(result.interval)||5,30))*1000:2000,
            ...(result.qrcode_url || result.auth_url ? {qr:channelQR(result.qrcode_url || result.auth_url)} : {})};
        } catch(error) { cancel(ticket); throw error; }
      });
      if (method === 'channels-poll' || method === 'channels-cancel') {
        const ticket = sessions.get(input.handle);
        if (!ticket || ticket.key !== key) throw fail('ASSISTANT_CHANNEL_EXPIRED');
        if (method === 'channels-cancel') { cancel(ticket); return {}; }
        active(key,ticket);
        if (!ticket.pending) ticket.pending = poll(key,ticket).finally(()=>{ticket.pending=null;});
        return ticket.pending;
      }
      throw fail('ASSISTANT_INVALID_INPUT');
    },
  };
}
