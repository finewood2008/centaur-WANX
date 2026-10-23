import {randomUUID} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
const base='/api/semantica/open/v1';
const scopes=['documents','evidence','graph','search'];
const actions=new Set(['share-details','create-share-key','reveal-share-key','copy-share-key','copy-share-value','release-share-key']);
const hostExample=`const response = await host.request("${base}/graph?limit=120", {\n  headers: { "X-Xingtu-Key": process.env.STARLINK_KEY }\n});`;
export function createDataShareAccess({identity,instance,writeClipboard,getMcpDetails}){
 const secrets=new Map();
 const clear=()=>secrets.clear();
 const active=k=>!k.revoked_at&&Number(k.expires_at)*1000>Date.now();
 async function action(action,input={}){
  if(action==='release-share-key'){secrets.delete(input.handle);return {released:true}}
  const {next}=await identity();
  const warehouseId=input.warehouseId;
  if(typeof warehouseId!=='string'||!/^[a-f0-9-]{36}$/.test(warehouseId))throw fail('TEAM_DATA_TARGET_INVALID');
  const service=await instance();
  const warehouse=await service.call('warehouse',{id:warehouseId});
  if(action==='share-details'){
   const runtime=await service.call('runtime');
   const keys=await service.call('keys',{warehouseId});
   const mcp=getMcpDetails?await getMcpDetails():null;
   const now=await identity();if(now.next!==next)throw fail('TEAM_SESSION_CHANGED');
   return {warehouse:{id:warehouse.id,name:warehouse.name},mcpUrl:mcp?.url||null,mcpConfiguration:mcp?.configuration||null,hostBase:base,localBase:runtime.api_base_url||null,hostExample,keys:keys.items||[],scopes};
  }
  if(action==='create-share-key'){
   const name=String(input.name||'').trim(),days=Number(input.days);
   if(!name||name.length>60||!Number.isInteger(days)||days<1||days>365)throw fail('TEAM_DATA_SHARE_INVALID');
   const grant=await service.call('create-key',{warehouseId,name,days,scopes,operationId:randomUUID()});
   const now=await identity();if(now.next!==next)throw fail('TEAM_SESSION_CHANGED');
   if(!grant.token)throw fail('TEAM_DATA_KEY_NOT_REPLAYABLE');
   const handle=randomUUID();secrets.clear();secrets.set(handle,{warehouseId,keyId:grant.key.id,token:grant.token,scope:next});
   return {key:grant.key,handle,oneTimeDisplay:true};
  }
  if(['reveal-share-key','copy-share-key'].includes(action)){
   const value=secrets.get(input.handle);
   if(!value||value.scope!==next||value.warehouseId!==warehouseId)throw fail('TEAM_DATA_KEY_NOT_REPLAYABLE');
   const keys=await service.call('keys',{warehouseId});
   if(!keys.items?.some(k=>k.id===value.keyId&&active(k))){secrets.delete(input.handle);throw fail('TEAM_DATA_KEY_REVOKED')}
   const now=await identity();if(now.next!==next)throw fail('TEAM_SESSION_CHANGED');
   if(action==='reveal-share-key')return {token:value.token};
   if(!writeClipboard)throw fail('TEAM_CLIPBOARD_UNAVAILABLE');
   writeClipboard(value.token);return {copied:true};
  }
  if(action==='copy-share-value'){
   let text=input.kind==='host-base'?base:input.kind==='host-example'?hostExample:null;
   if(input.kind==='local-base')text=(await service.call('runtime')).api_base_url;
   if(['mcp-url','mcp-config'].includes(input.kind)){const mcp=await getMcpDetails?.();text=input.kind==='mcp-url'?mcp?.url:mcp?.configuration?JSON.stringify(mcp.configuration,null,2):null}
   if(typeof text!=='string'||!text)throw fail('TEAM_DATA_SHARE_INVALID');
   const now=await identity();if(now.next!==next)throw fail('TEAM_SESSION_CHANGED');
   if(!writeClipboard)throw fail('TEAM_CLIPBOARD_UNAVAILABLE');
   writeClipboard(text);return {copied:true};
  }
  throw fail('TEAM_DATA_ACTION_DENIED');
 }
 return {supports:name=>actions.has(name),action,clear};
}
