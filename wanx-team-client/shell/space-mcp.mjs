// Server-hosted, vendor-independent MCP. This module only manages scoped keys;
// it never reads Agent logs or puts the desktop on the MCP data path.
import {randomBytes} from 'node:crypto';
const PREFIX='/api/_client/space-mcp';
const fail=code=>Object.assign(Error(code),{code});
export function createSpaceMcp({state,persist,scope,storageScope=scope,assertScope,remote,client,copyText,team=false}) {
 state.spaceMcp ||= [];
 const endpoint=()=>{const u=new URL(client.snapshot().connection.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw fail('MCP_ADDRESS_INVALID');u.pathname='/mcp/space';return u.href;};
 const call=async(bound,path='',options={})=>(await remote(bound,path,{prefix:PREFIX,...options})).value;
 return {
  contextChanged(){},close(){},
  async handle(_req,res){res.writeHead(410,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'MCP_SERVER_HOSTED'}}));},
  async manage(action,input={}) {
   const bound=scope();assertScope(bound);
   const owner=storageScope(),record=id=>state.spaceMcp.find(r=>r.scope===owner&&r.id===id);
   const destination=team?'company':'personal';
   for(const field of ['id','grant'])if(input[field]!==undefined&&!/^[a-f0-9]{32}$/.test(input[field]))throw fail('SPACE_INVALID_ID');
   if(action==='mcp-copy'&&!['url','key','config','prompt'].includes(input.kind))throw fail('SPACE_ACTION_INVALID');
   if(action==='mcp-drives')return call(bound,'/drives');
   if(action==='mcp-manage')return call(bound,`/connections/${input.id}/manage`,{method:'POST',body:{action:input.action,name:input.name||''}});
   if(action==='mcp-rotate'){
    const r=record(input.id)||{scope:owner,id:input.id};if(!state.spaceMcp.includes(r))state.spaceMcp.push(r);
    r.rotation ||= {operation_id:randomBytes(16).toString('hex'),credential:randomBytes(32).toString('base64url')};await persist();
    const value=await call(bound,`/connections/${input.id}/rotate`,{method:'POST',body:r.rotation});assertScope(bound);r.credential=r.rotation.credential;delete r.rotation;await persist();assertScope(bound);return value;
   }
   if(action==='mcp-state') {const value=await call(bound,'?destination='+destination);assertScope(bound);return {...value,url:endpoint(),connections:value.connections.map(c=>({...c,localKey:!!record(c.id)?.credential}))};}
   if(action==='mcp-issue') {
    let pending=state.spaceMcp.find(r=>r.scope===owner&&!r.id&&r.name===input.name);
    if(!pending){pending={scope:owner,name:String(input.name||'我的 MCP 接入').slice(0,80),operation_id:randomBytes(16).toString('hex'),credential:randomBytes(32).toString('base64url'),destination};state.spaceMcp.push(pending);await persist();}
    const value=await call(bound,'/connections',{method:'POST',body:{operation_id:pending.operation_id,credential:pending.credential,name:pending.name,destination:pending.destination}});assertScope(bound);pending.id=value.id;await persist();assertScope(bound);return {...value,localKey:true};
   }
   if(action==='mcp-revoke') {const v=await call(bound,'/connections/'+input.id,{method:'DELETE'});assertScope(bound);const r=record(input.id);if(r){delete r.credential;await persist();assertScope(bound);}return v;}
   if(action==='mcp-grant')return call(bound,`/connections/${input.id}/grants`,{method:'POST',body:{domain:input.domain,root:input.root,purpose:input.purpose||'reference'}});
   if(action==='mcp-revoke-grant')return call(bound,`/connections/${input.id}/grants/${input.grant}`,{method:'DELETE'});
   if(action==='mcp-folders')return call(bound,`/folders?domain=${encodeURIComponent(input.domain||'personal')}&parent=${encodeURIComponent(input.parent||'')}`);
   if(action==='mcp-archive')return call(bound,'/archives/'+input.id);
   if(action==='mcp-prompt')return call(bound,`/connections/${input.id}/prompt`);
   if(action==='mcp-copy') {
    let text;
    if(input.kind==='url') text=endpoint();
    else if(input.kind==='prompt')text=(await call(bound,`/connections/${input.id}/prompt`)).prompt;
    else {
     const overview=await call(bound,'?destination='+destination),connection=overview.connections.find(c=>c.id===input.id&&c.status==='active');
     const r=record(input.id);if(!connection||!r?.credential)throw fail('MCP_KEY_NOT_ON_THIS_CLIENT');
     text=input.kind==='key'?r.credential:JSON.stringify({mcpServers:{'wanx-space':{url:endpoint(),headers:{Authorization:'Bearer '+r.credential}}}},null,2);
    }
    assertScope(bound);if(!copyText)throw fail('MCP_CLIPBOARD_UNAVAILABLE');await copyText(text);return {copied:true};
   }
   throw fail('SPACE_ACTION_INVALID');
  }
 };
}
