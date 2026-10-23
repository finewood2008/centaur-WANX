import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createWanxMcpBridge} from '../integration/team-client/wanx-mcp-bridge.mjs';
const token='xg_synthetic_mcp_key_never_a_real_credential',spaceKey='S'.repeat(43);
const fail=(code,status=403)=>Object.assign(Error(code),{code,status});
async function fixture(t){
 let bound='a',revoked=false,spaceRevoked=false,late;
 const calls=[],state={port:0,links:[{id:'id1',key:spaceKey,scope:'a',token:'private-backend-token'}]};
 const assertScope=s=>{if(!bound||s!==bound)throw fail('SPACE_CONTEXT_CHANGED')};
 const text=Buffer.from('合成空间资料'),digest=createHash('sha256').update(text).digest('hex');
 const access=async(record,args)=>{
  assertScope(record.scope);if(spaceRevoked)throw fail('SPACE_LINK_REVOKED');calls.push(['space',args]);
  if(args.target==='outside')throw fail('SPACE_ACCESS_DENIED');
  if(args.action==='stat')return {value:{kind:'file',size:text.length,version:1,digest}};
  if(args.action==='read')return {bytes:text,headers:{etag:'1','x-file-sha256':digest}};
  return {value:{id:'authorized-root',name:'合成资料'}};
 };
 const client={applicationConnection:async()=>({context:()=>assertScope('a'),request:async input=>{
  calls.push(['knowledge',input]);assertScope('a');
  if(input.headers['X-Xingtu-Key']!==token||revoked)return {status:403,body:Buffer.from('{"code":"ACCESS_KEY_INVALID"}')};
  if(late&&input.path.includes('/graph'))await late;
  return {status:200,body:Buffer.from(JSON.stringify({id:'authorized-warehouse',nodes:[{id:'real-id'}],edges:[]}))};
 }})};
 const bridge=createWanxMcpBridge({client,state,scope:()=>bound,assertScope,access,remote:async()=>({value:spaceRevoked?[]:[{id:'id1',name:'文件',expires:null}]})});
 const server=http.createServer((req,res)=>void bridge.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));state.port=server.address().port;
 t.after(()=>{server.closeAllConnections();server.close()});
 const root=`http://127.0.0.1:${state.port}`,url=root+'/mcp/starlink',spaceUrl=root+'/mcp/space';
 async function rpc(key,method='tools/list',params,headers={},verb='POST',endpoint=key?.startsWith('xg_')||!key?url:spaceUrl){
  const r=await fetch(endpoint,{method:verb,headers:{accept:'application/json, text/event-stream','content-type':'application/json',...(key?{authorization:'Bearer '+key}:{}),...headers},...(verb==='POST'?{body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})}:{})});
  return {status:r.status,body:r.status===204?null:await r.json()};
 }
 return {rpc,url,spaceUrl,root,bridge,calls,revoke:()=>revoked=true,revokeSpace:()=>spaceRevoked=true,switch:()=>bound='b',hold:()=>{let done;late=new Promise(r=>done=r);return done}};
}
test('independent HTTP MCP endpoints negotiate distinct server identities and expose only their tools',async t=>{
 const f=await fixture(t),init=await f.rpc(token,'initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}});assert.equal(init.body.result.protocolVersion,'2025-11-25');assert.equal(init.body.result.serverInfo.name,'xingtu');
 const a=(await f.rpc(token)).body.result.tools,b=(await f.rpc(spaceKey)).body.result.tools;
 assert(a.some(t=>t.name==='xingtu_graph'));assert(!a.some(t=>t.name==='space'));assert(b.some(t=>t.name==='space_read_text'));assert(!b.some(t=>t.name==='xingtu_graph'));
 assert.equal((await f.rpc(token,'tools/call',{name:'space',arguments:{action:'list'}})).body.error.message,'MCP_TOOL_DENIED');
 assert.equal((await f.rpc(spaceKey,'tools/call',{name:'xingtu_graph',arguments:{}})).body.error.message,'MCP_TOOL_DENIED');
});
test('real HTTP requests require a Key; reject browser origins, invalid versions and unsupported methods',async t=>{
 const f=await fixture(t);assert.equal((await f.rpc(null)).status,401);assert.equal((await f.rpc('wrong_key_that_is_not_valid')).status,401);
 assert.equal((await f.rpc(token,'tools/list',null,{origin:'https://example.test'})).status,403);
 assert.equal((await f.rpc(token,'tools/list',null,{'mcp-protocol-version':'invalid'})).status,400);
 assert.equal((await f.rpc(token,'tools/list',null,{},'GET')).status,405);
});
test('knowledge reads reuse authenticated public routes with current caller; cannot inject a warehouse or URL',async t=>{
 const f=await fixture(t),graph=await f.rpc(token,'tools/call',{name:'xingtu_graph',arguments:{limit:100}});assert.equal(graph.body.result.structuredContent.nodes[0].id,'real-id');
 const call=f.calls.find(([k,v])=>k==='knowledge'&&v.path.endsWith('/graph?limit=100'))[1];assert.equal(call.headers['X-Xingtu-Key'],token);assert.equal(call.method,'GET');
 assert.equal((await f.rpc(token,'tools/call',{name:'xingtu_graph',arguments:{warehouseId:'another'}})).status,400);
 f.revoke();assert.equal((await f.rpc(token)).status,403);
});
test('space text read retains checksum and file version; rejects another root and revoked grants',async t=>{
 const f=await fixture(t),r=await f.rpc(spaceKey,'tools/call',{name:'space_read_text',arguments:{target:'file1'}});assert.equal(r.body.result.structuredContent.text,'合成空间资料');assert.equal(r.body.result.structuredContent.version,1);
 assert((await f.rpc(spaceKey,'tools/call',{name:'space',arguments:{action:'read',target:'outside'}})).body.result.isError);
 assert((await f.rpc(spaceKey,'tools/call',{name:'space',arguments:{action:'list',grant_id:'extra'}})).body.result.isError);
 const d=await f.bridge.details();assert.equal(d.url,f.spaceUrl);assert(!JSON.stringify(d).includes(spaceKey));assert.equal(await f.bridge.spaceKey('id1'),spaceKey);
 f.revokeSpace();assert.equal((await f.rpc(spaceKey)).status,403);await assert.rejects(f.bridge.spaceKey('id1'));
});
test('account/box switch suppresses late knowledge results and the old space Key',async t=>{
 const f=await fixture(t),done=f.hold(),pending=f.rpc(token,'tools/call',{name:'xingtu_graph',arguments:{}});
 while(!f.calls.some(([k,v])=>k==='knowledge'&&v.path.endsWith('/graph')))await new Promise(r=>setTimeout(r,5));
 f.switch();done();const r=await pending;assert(r.body.result.isError);assert(!JSON.stringify(r).includes('real-id'));assert.equal((await f.rpc(spaceKey)).status,401);
});
test('cross-endpoint Keys fail authentication and the retired unified endpoint cannot operate',async t=>{
 const f=await fixture(t);
 assert.equal((await f.rpc(token,'tools/list',null,{},'POST',f.spaceUrl)).status,401);
 assert.equal((await f.rpc(spaceKey,'tools/list',null,{},'POST',f.url)).status,401);
 assert.equal(f.calls.length,0);
 for(const key of [token,spaceKey])assert.equal((await f.rpc(key,'tools/list',null,{},'POST',f.root+'/mcp')).status,410);
 const space=await f.bridge.details('space'),starlink=await f.bridge.details('starlink');
 assert.notEqual(space.url,starlink.url);assert(space.configuration.mcpServers['wanx-space']);assert(starlink.configuration.mcpServers.xingtu);
 assert.deepEqual(space.capabilities,['空间文件访问']);assert.deepEqual(starlink.capabilities,['星图知识读取']);
 const init=await f.rpc(spaceKey,'initialize',{protocolVersion:'2025-11-25'});assert.equal(init.body.result.serverInfo.name,'wanx-space');
});
