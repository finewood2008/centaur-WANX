import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const fail = (code, status = 409) => Object.assign(new Error(code), {code, status});
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const valid = value => /^[A-Za-z0-9_-]{43}$/.test(value || '');
const cleanName = value => String(value || 'Agent').trim().slice(0, 80) || 'Agent';

// The encrypted client store owns pending approval and the fixed account/box binding.
// A locally generated profile secret authenticates reconnects; clientInfo is display-only.
export function createAgentSpaces({state, scope, assertScope, remote, persist, onChanged, mcpConfig, profileDirectory}) {
  state.agents ||= [];
  const publicRecord = record => ({id: record.id, profile: record.profile, name: record.name, status: record.status, connection: record.connection, space_id: record.space_id, created: record.created});
  const lookup = key => state.agents.find(a => same(a.key, key));
  async function enroll(input) {
    const bound = scope(); assertScope(bound);
    if (!/^[a-f0-9]{32}$/.test(input.profile || '') || !valid(input.key)) throw fail('SPACE_INVALID_PROFILE', 400);
    const existing = state.agents.find(a => a.profile === input.profile);
    if (existing) {
      if (!same(existing.key, input.key)) throw fail('SPACE_PROFILE_MISMATCH', 403);
      assertScope(existing.scope);
      if (existing.status === 'approved') {
        const spaces=(await remote(existing.scope,'/spaces')).value;
        const connection=spaces.flatMap(space=>space.connections).find(c=>c.id===existing.connection);
        if(!connection || connection.state==='disconnected') {existing.status='disconnected';delete existing.token;await persist();}
        else return {...publicRecord(existing),accessState:connection.state};
      }
      return publicRecord(existing);
    }
    if (state.agents.filter(a => a.status === 'pending').length >= 32) throw fail('SPACE_APPROVAL_QUEUE_FULL', 429);
    const record = {id: randomUUID().replaceAll('-', ''), profile: input.profile, key: input.key, name: cleanName(input.name), status:'pending', scope:bound, created:Date.now()};
    state.agents.push(record);
    try { await persist(); } catch(error) { state.agents.splice(state.agents.indexOf(record),1); throw error; }
    onChanged(); return publicRecord(record);
  }
  async function access(key, input) {
    const record = lookup(key);
    if (!record) throw fail('SPACE_AGENT_UNKNOWN', 403);
    assertScope(record.scope);
    if (input.action === 'connection-status') return {value: publicRecord(record)};
    if (record.status !== 'approved') throw fail(record.status === 'rejected' ? 'SPACE_AGENT_REJECTED' : 'SPACE_APPROVAL_REQUIRED', 403);
    const response = await remote(record.scope, '/connection-access', {method:'POST',token:record.token,body:input});
    if (!['access','describe','stat','list','read','write-status'].includes(input.action)) onChanged();
    return response;
  }
  async function manage(action, input = {}) {
    const bound = scope(); assertScope(bound);
    if (action === 'agent-config') {
      if (!profileDirectory) throw fail('SPACE_AGENT_CONFIG_UNAVAILABLE');
      const base = mcpConfig.mcpServers?.['wanx-space'];
      return {mcpServers:{'wanx-space':{...base,args:[...(base?.args || []),'--profile',path.join(profileDirectory,randomUUID()+'.json'),'--endpoint',`http://127.0.0.1:${state.port}`]}}};
    }
    if (action === 'spaces') return (await remote(bound, '/spaces')).value;
    if (action === 'requests') return state.agents.filter(a => a.scope === bound && a.status !== 'approved').map(publicRecord);
    if (action === 'approve' || action === 'reject') {
      const record = state.agents.find(a => a.id === input.id && a.scope === bound);
      if (!record) throw fail('SPACE_AGENT_UNKNOWN',404);
      if (record.status === 'approved') throw fail('SPACE_ALREADY_CONNECTED');
      if (action === 'reject') { record.status='rejected'; await persist(); onChanged(); return publicRecord(record); }
      record.token ||= randomBytes(32).toString('base64url');
      await persist(); // Keep the owner-issued credential before the box commits approval.
      const approved = (await remote(bound,'/connections',{method:'POST',body:{profile:record.profile,name:cleanName(input.name || record.name),space_id:input.space_id || '',credential:record.token}})).value;
      Object.assign(record,{status:'approved',connection:approved.id,space_id:approved.space_id,token:approved.token,name:cleanName(input.name || record.name)});
      await persist(); onChanged(); return publicRecord(record);
    }
    const id = value => { if (!/^[a-f0-9]{32}$/.test(value || '')) throw fail('SPACE_INVALID_ID',400); return value; };
    if (action === 'space-manage') return (await remote(bound,`/spaces/${id(input.id)}/manage`,{method:'POST',body:{action:input.action,name:input.name || ''}})).value;
    if (action === 'connection-manage') {
      const result=(await remote(bound,`/connections/${id(input.id)}/manage`,{method:'POST',body:{action:input.action}})).value;
      if(input.action==='disconnect') {
        const record=state.agents.find(a=>a.connection===input.id && a.scope===bound);
        if(record){record.status='disconnected';delete record.token;await persist();}
      }
      onChanged(); return result;
    }
    if (action === 'grants' || action === 'connection-audit') return (await remote(bound,`/connections/${id(input.id)}/${action === 'grants' ? 'grants' : 'audit'}`)).value;
    if (action === 'grant') return (await remote(bound,`/connections/${id(input.id)}/grants`,{method:'POST',body:{root:id(input.root)}})).value;
    if (action === 'grant-revoke') return (await remote(bound,`/connections/${id(input.id)}/grants/${id(input.grant)}`,{method:'DELETE'})).value;
    if (action === 'file-transfer') {
      if(input.space_id!=='personal')id(input.space_id);
      return (await remote(bound,`/files/${id(input.id)}/transfer`,{method:'POST',body:{parent:input.parent || '',space_id:input.space_id,copy:input.copy===true}})).value;
    }
    throw fail('SPACE_ACTION_INVALID',400);
  }
  return {enroll,access,manage};
}
