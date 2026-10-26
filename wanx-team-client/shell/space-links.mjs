// Space MCP runs on the box; session-bound team knowledge keeps its local endpoint.
import path from 'node:path';
import {createSpaceMcp} from './space-mcp.mjs';
import {createLocalKnowledgeMcp} from './local-knowledge-mcp.mjs';
import {dataInteractionKey,dataOwnerKey} from '../device-trust/data-context.mjs';
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const id=value=>{if(!/^[a-f0-9]{32}$/.test(value||''))throw fail('SPACE_INVALID_ID',400);return value;};
export async function createSpaceLinkBridge({client,store,serviceURL,onChanged=()=>{},chooseStorageDirectory,copyText,agentHubOptions={},knowledgeCapabilities}){
 const state=(await store.load())||{version:1,spaceMcp:[]};
 let closed=false,generation=0,writes=Promise.resolve();const controllers=new Set();
 // Keep keys across one owner's session renewals, but bind every operation to
 // the exact interaction so a late request cannot reuse renewed authority.
 const storageScope=()=>{const s=client.snapshot(),owner=dataOwnerKey(s,serviceURL);if(!owner||!dataInteractionKey(s,serviceURL))return null;return s.dataIdentity?.profileId||s.connection?.authorization==='local-trust-v1'?JSON.stringify([owner,s.connection.deviceId]):JSON.stringify([serviceURL,s.account.accountId,s.connection.deviceId]);};
 const interaction=()=>dataInteractionKey(client.snapshot(),serviceURL);
 const scope=()=>{const key=interaction();return !closed&&key?JSON.stringify([key,generation]):null;};
 const assertScope=bound=>{if(closed||!scope())throw fail('BOX_CONNECTION_REQUIRED',503);if(bound!==scope())throw fail('SPACE_CONTEXT_CHANGED');};
 const persist=()=>{const copy=structuredClone(state);writes=writes.catch(()=>{}).then(()=>store.save(copy));return writes;};
 let previous=interaction();const unsubscribe=client.subscribe(()=>{const next=interaction();if(next===previous)return;previous=next;generation++;for(const c of controllers)c.abort();});
 async function remote(bound,route,{method='GET',body,prefix='/api/personal-space'}={}){
  assertScope(bound);const epoch=generation,connection=await client.applicationConnection();const controller=new AbortController();controllers.add(controller);
  try{assertScope(bound);const response=await connection.request({path:prefix+route,method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(120000)])});assertScope(bound);if(epoch!==generation)throw fail('SPACE_CONTEXT_CHANGED');let value;try{value=JSON.parse(Buffer.from(response.body||'').toString());}catch{}if(response.status<200||response.status>=300)throw fail(value?.detail?.code||value?.code||(response.status===404?'SPACE_LINK_UPGRADE_REQUIRED':'SPACE_REQUEST_FAILED'),response.status);return {value};}finally{controllers.delete(controller);connection.close?.();}
 }
 const mcp=createSpaceMcp({state,persist,scope,storageScope,assertScope,remote,client,copyText,team:agentHubOptions.team===true});
 const localKnowledge=knowledgeCapabilities?createLocalKnowledgeMcp({client,knowledgeCapabilities,scope,assertScope}):null;
 return {
  async manage(action,input={}){
   const bound=scope();assertScope(bound);
   if(action.startsWith('mcp-')){const v=await mcp.manage(action,input);assertScope(bound);if(['mcp-issue','mcp-revoke','mcp-manage','mcp-rotate'].includes(action))onChanged();return v;}
   if(action==='spaces'){const own=(await remote(bound,'/spaces')).value.filter(s=>s.id==='personal');assertScope(bound);const drives=client.snapshot().connection.authorization==='local-trust-v1'?[]:await mcp.manage('mcp-drives');assertScope(bound);return [...own,...drives].map(s=>({...s,connections:[]}));}
   if(action==='space-manage')return (await remote(bound,`/spaces/${id(input.id)}/manage`,{method:'POST',body:{action:input.action,name:input.name||''}})).value;
   if(action==='file-transfer'){if(input.space_id!=='personal')id(input.space_id);const v=await remote(bound,`/files/${id(input.id)}/transfer`,{method:'POST',body:{parent:input.parent||'',space_id:input.space_id,copy:input.copy===true}});onChanged();return v.value;}
   if(action==='storage-set'){if(input.id!=='personal')id(input.id);const v=await remote(bound,`/spaces/${input.id}/storage`,{method:'POST',body:{path:String(input.path||'')}});onChanged();return v.value;}
   if(action==='storage-choose'){
    if(client.snapshot().connection.mode==='local'){if(!chooseStorageDirectory)throw fail('SPACE_DIRECTORY_PICKER_UNAVAILABLE');const e=generation,chosen=await chooseStorageDirectory();assertScope(bound);if(e!==generation)throw fail('SPACE_CONTEXT_CHANGED');return chosen?{path:chosen}:{canceled:true};}
    const defaults=(await remote(bound,'/filesystem/defaults',{prefix:'/api'})).value,selected=input.path||defaults.default_root_dir;
    if(typeof selected!=='string'||selected.length>4096)throw fail('SPACE_STORAGE_PATH_INVALID');
    const listing=(await remote(bound,'/filesystem/dirs?path='+encodeURIComponent(selected),{prefix:'/api'})).value,paths=/^[A-Za-z]:[\\/]/.test(listing.path)?path.win32:path.posix;let parent=paths.dirname(listing.path);const relative=paths.relative(defaults.tree_root,parent);if(relative==='..'||relative.startsWith('..'+paths.sep)||paths.isAbsolute(relative))parent=defaults.tree_root;return {browse:true,...listing,root:defaults.tree_root,parent};
   }
   throw fail('SPACE_ACTION_INVALID',400);
  },
  async mcpDetails(kind='space'){
   if(!['space','starlink'].includes(kind))throw fail('MCP_SURFACE_INVALID');const bound=scope();assertScope(bound);
   if(kind==='starlink'&&client.snapshot().connection.authorization==='local-trust-v1'){if(!localKnowledge)throw fail('TEAM_DATA_CAPABILITY_UNAVAILABLE');return localKnowledge.details();}
   const u=new URL(client.snapshot().connection.url);u.pathname='/mcp/'+kind;u.search='';u.hash='';
   return {url:u.href,transport:'Streamable HTTP',authentication:'Authorization: Bearer <访问 Key>',configuration:{mcpServers:{[kind==='space'?'wanx-space':'wanx-starlink']:{url:u.href,headers:{Authorization:'Bearer <访问 Key>'}}}},serverHosted:true,localOnly:false};
  },
  async close(){closed=true;unsubscribe();for(const c of controllers)c.abort();await localKnowledge?.close();await writes.catch(()=>{});}
 };
}
