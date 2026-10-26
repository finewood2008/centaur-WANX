import {createWanxMcp,mcpConfiguration} from './wanx-mcp.mjs';
import {knowledgeMcpAccess} from './wanx-mcp-knowledge.mjs';
import {createHash,timingSafeEqual} from 'node:crypto';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const fail=(code,status=403)=>Object.assign(Error(code),{code,status});
export function createWanxMcpBridge({client,state,scope,assertScope,access,remote,knowledgeCapabilities}){
 async function resolveSpace(key){
  const bound=scope();assertScope(bound);
  const link=state.links.find(r=>same(r.key,key)&&r.scope===bound&&!r.revoked);
  if(!link)throw fail('MCP_KEY_INVALID',401);
  const execute=input=>access(link,{...input,action:input.action==='access'?'describe':input.action});
  const check=async()=>{await execute({action:'describe'});assertScope(bound)};
  await check();
  return {kind:'space',check,request:async input=>{
   if(input.grant_id)throw fail('SPACE_ACCESS_DENIED');
   const {grant_id,...rest}=input;
   const response=await execute(rest);assertScope(bound);
   if(input.action==='read')return {data:response.bytes.toString('base64'),size:response.bytes.length,encoding:'base64',version:Number(response.headers.etag),digest:response.headers['x-file-sha256']};
   return response.value;
  }};
 }
 async function details(kind='space'){
  if(!['space','starlink'].includes(kind))throw fail('MCP_SURFACE_INVALID',400);
  const bound=scope();assertScope(bound);
  const url=`http://127.0.0.1:${state.port}/mcp/${kind}`;
  if(kind==='starlink')return {url,transport:'Streamable HTTP',authentication:'Authorization: Bearer <本机会话 Key>',configuration:mcpConfiguration(url,'knowledge'),keys:[],capabilities:['星图知识读取'],localOnly:true};
  const links=await remote(bound,'/agent-links');assertScope(bound);
  const keys=state.links.filter(r=>r.scope===bound&&!r.revoked).flatMap(r=>{const live=links.value.find(v=>v.id===r.id&&!v.revoked&&(!v.expires||v.expires*1000>Date.now()));return live?[{id:r.id,name:live.name||'文件访问授权',prefix:r.key.slice(0,8),kind:'文件范围',status:'有效'}]:[]});
  return {url,transport:'Streamable HTTP',authentication:'Authorization: Bearer <空间 Key>',configuration:mcpConfiguration(url,'space'),keys,capabilities:['空间文件访问'],localOnly:true};
 }
 async function spaceKey(id){
  const d=await details();if(!d.keys.some(k=>k.id===id&&k.status==='有效'))throw fail('MCP_KEY_INVALID',401);
  const bound=scope(),r=state.links.find(r=>r.id===id&&r.scope===bound);if(!r)throw fail('MCP_KEY_INVALID',401);
  await resolveSpace(r.key);assertScope(bound);return r.key;
 }
 const handlers={
  '/mcp/space':createWanxMcp({kind:'space',resolve:resolveSpace}),
  '/mcp/starlink':createWanxMcp({kind:'knowledge',resolve:async key=>{if(!knowledgeCapabilities)throw fail('MCP_KEY_INVALID',401);return knowledgeMcpAccess({capability:await knowledgeCapabilities.resolve(key)})}}),
 };
 async function handle(req,res){
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(handlers[path])return handlers[path](req,res);
  res.writeHead(path==='/mcp'?410:404,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify({error:{code:path==='/mcp'?'MCP_SEPARATE_ENDPOINTS_REQUIRED':'MCP_NOT_FOUND'}}));
 }
 return {handle,details,spaceKey};
}
