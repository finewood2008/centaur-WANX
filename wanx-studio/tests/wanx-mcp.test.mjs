import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {createWanxMcpBridge} from '../integration/team-client/wanx-mcp-bridge.mjs';
import {createKnowledgeCapabilities} from '../../wanx-team-client/device-trust/knowledge-capabilities.mjs';
const legacyToken='xg_synthetic_mcp_key_never_a_real_credential',spaceKey='S'.repeat(43);
const warehouseId='12345678-1234-1234-1234-123456789abc',resourceId='team:knowledge:'+warehouseId;
const fail=(code,status=403)=>Object.assign(Error(code),{code,status});
const timeout={timeout:10000};
async function waitFor(predicate){
 const deadline=Date.now()+3000;
 while(!predicate()){
  if(Date.now()>=deadline)throw Error('MCP_FIXTURE_WAIT_TIMEOUT');
  await new Promise(resolve=>setTimeout(resolve,5));
 }
}
async function fixture(t){
 let bound='a',revoked=false,spaceRevoked=false,late,holdTimer,releaseHold;
 const listeners=new Set(),calls=[],state={port:0,links:[{id:'id1',key:spaceKey,scope:'a',token:'private-backend-token'}]};
 const assertScope=s=>{if(!bound||s!==bound)throw fail('SPACE_CONTEXT_CHANGED')};
 const text=Buffer.from('合成空间资料'),digest=createHash('sha256').update(text).digest('hex');
 const access=async(record,args)=>{
  assertScope(record.scope);if(spaceRevoked)throw fail('SPACE_LINK_REVOKED');calls.push(['space',args]);
  if(args.target==='outside')throw fail('SPACE_ACCESS_DENIED');
  if(args.action==='stat')return {value:{kind:'file',size:text.length,version:1,digest}};
  if(args.action==='read')return {bytes:text,headers:{etag:'1','x-file-sha256':digest}};
  return {value:{id:'authorized-root',name:'合成资料'}};
 };
 const client={
  snapshot:()=>({phase:'ready',connection:{authorization:'local-trust-v1',deviceId:'box-'+bound},dataIdentity:{
   phase:'unlocked',profileId:'synthetic-profile',clientId:'synthetic-client',generation:1,selected:{boxId:'box-'+bound,
    boxKeyThumbprint:'synthetic-pin',ownershipEpoch:1,principalId:'principal-'+bound,bindingId:'binding',sessionId:'session-'+bound,authorizationVersion:revoked?2:1}}}),
  subscribe:listener=>(listeners.add(listener),()=>listeners.delete(listener)),
  applicationConnection:async()=>{
   const captured=bound;
   return {context:()=>{assertScope(captured);return {authorization:'local-trust-v1',dataIdentity:{
    sessionId:'session-'+captured,authorizationVersion:revoked?2:1,principalId:'principal-'+captured,bindingId:'binding',ownershipEpoch:1,
    grants:revoked?[]:[{resourceId,actions:['read']}]}}},request:async input=>{
    calls.push(['knowledge',input]);assertScope(captured);
    assert.equal(input.headers['x-wanx-data-context'],resourceId);
    assert.equal(Object.keys(input.headers).some(name=>name.toLowerCase()==='x-xingtu-key'),false);
    if(revoked)return {status:403,body:Buffer.from('{"code":"RESOURCE_GRANT_REQUIRED"}')};
    const url=new URL(input.path,'https://synthetic.invalid');let result;
    if(url.pathname==='/api/semantica/warehouses/'+warehouseId)result={id:warehouseId,name:'合成获准仓库'};
    else if(url.pathname==='/api/semantica/documents')result={items:[{id:'doc-id',name:'合成材料'}]};
    else if(url.pathname==='/api/semantica/graph')result={nodes:[{id:'graph-node'}],edges:[]};
    else if(url.pathname==='/api/semantica/evidence/evidence_1')result={id:'evidence_1',text:'受保护的证据'};
    else if(url.pathname.startsWith('/api/semantica/evidence/'))return {status:404,body:Buffer.from('{"code":"EVIDENCE_NOT_FOUND"}')};
    else if(url.pathname==='/api/semantica/search'){
     assert.equal(input.method,'POST');const body=JSON.parse(Buffer.from(input.body).toString('utf8'));
     assert.equal(body.query,'masked query');assert.deepEqual(Object.keys(body).sort(),['limit','query']);
     if(late)await late;result={items:[{id:'real-id',text:'受保护的摘要'}]};
    }else throw Error('MCP_FIXTURE_UNEXPECTED_ROUTE');
    return {status:200,body:Buffer.from(JSON.stringify(result))};
   }};
  }
 };
 const knowledgeCapabilities=createKnowledgeCapabilities({client});
 const {token}=await knowledgeCapabilities.create({warehouseId,name:'synthetic local agent',days:1});
 const bridge=createWanxMcpBridge({client,state,scope:()=>bound,assertScope,access,knowledgeCapabilities,
  remote:async()=>({value:spaceRevoked?[]:[{id:'id1',name:'文件',expires:null}]})});
 const server=http.createServer((req,res)=>void bridge.handle(req,res));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MCP_FIXTURE_LISTEN_TIMEOUT')),3000);
  server.once('error',error=>{clearTimeout(timer);reject(error)});server.listen(0,'127.0.0.1',()=>{clearTimeout(timer);resolve()})});
 state.port=server.address().port;
 t.after(()=>{clearTimeout(holdTimer);releaseHold?.();knowledgeCapabilities.close();server.closeAllConnections();server.close()});
 const root=`http://127.0.0.1:${state.port}`,url=root+'/mcp/starlink',spaceUrl=root+'/mcp/space';
 async function rpc(key,method='tools/list',params,headers={},verb='POST',endpoint=key===spaceKey?spaceUrl:url){
  const r=await fetch(endpoint,{method:verb,signal:AbortSignal.timeout(4000),headers:{accept:'application/json, text/event-stream','content-type':'application/json',...(key?{authorization:'Bearer '+key}:{}),...headers},...(verb==='POST'?{body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})}:{})});
  return {status:r.status,body:r.status===204?null:await r.json()};
 }
 return {rpc,token,url,spaceUrl,root,bridge,calls,revoke:()=>revoked=true,revokeSpace:()=>spaceRevoked=true,
  switch:()=>{bound='b';for(const listener of listeners)listener()},
  hold:()=>{late=new Promise(resolve=>{releaseHold=()=>{clearTimeout(holdTimer);resolve()};holdTimer=setTimeout(releaseHold,3000)});return releaseHold}};
}
test('independent HTTP MCP endpoints negotiate distinct server identities and expose only their finite tools',timeout,async t=>{
 const f=await fixture(t),init=await f.rpc(f.token,'initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}});
 assert.equal(init.body.result.protocolVersion,'2025-11-25');assert.equal(init.body.result.serverInfo.name,'xingtu');
 const a=(await f.rpc(f.token)).body.result.tools,b=(await f.rpc(spaceKey)).body.result.tools;
 assert.deepEqual(a.map(tool=>tool.name),['xingtu_warehouse','xingtu_documents','xingtu_graph','xingtu_search','xingtu_evidence']);
 assert(!a.some(tool=>tool.name==='space'));assert(b.some(tool=>tool.name==='space_read_text'));assert(!b.some(tool=>tool.name.startsWith('xingtu_')));
 for(const name of ['space','owner_graph','create_key','write_document'])assert.equal((await f.rpc(f.token,'tools/call',{name,arguments:{}})).body.error.message,'MCP_TOOL_DENIED');
 assert.equal((await f.rpc(spaceKey,'tools/call',{name:'xingtu_search',arguments:{query:'masked query'}})).body.error.message,'MCP_TOOL_DENIED');
});
test('real HTTP requests require a current session capability; old xg keys, browser origins and invalid protocol are rejected',timeout,async t=>{
 const f=await fixture(t);assert.match(f.token,/^wmcp_[A-Za-z0-9_-]{43}$/);
 assert.equal((await f.rpc(null)).status,401);assert.equal((await f.rpc('wrong_key_that_is_not_valid')).status,403);
 assert.equal((await f.rpc(legacyToken)).status,403);assert.equal(f.calls.length,0);
 assert.equal((await f.rpc(f.token,'tools/list',null,{origin:'https://example.test'})).status,403);
 assert.equal((await f.rpc(f.token,'tools/list',null,{'mcp-protocol-version':'invalid'})).status,400);
 assert.equal((await f.rpc(f.token,'tools/list',null,{},'GET')).status,405);
});
test('knowledge read/search use current local data scope; caller cannot inject a warehouse, URL, unsafe identifier or raw privacy mode',timeout,async t=>{
 const f=await fixture(t);
 const warehouse=await f.rpc(f.token,'tools/call',{name:'xingtu_warehouse',arguments:{}});assert.equal(warehouse.body.result.structuredContent.id,warehouseId);
 const documents=await f.rpc(f.token,'tools/call',{name:'xingtu_documents',arguments:{limit:100,offset:0}});assert.equal(documents.body.result.structuredContent.items[0].id,'doc-id');
 const search=await f.rpc(f.token,'tools/call',{name:'xingtu_search',arguments:{query:'masked query',limit:5}});assert.equal(search.body.result.structuredContent.items[0].id,'real-id');
 const graph=await f.rpc(f.token,'tools/call',{name:'xingtu_graph',arguments:{limit:100,entity_id:'entity_1'}});assert.equal(graph.body.result.structuredContent.nodes[0].id,'graph-node');
 const evidence=await f.rpc(f.token,'tools/call',{name:'xingtu_evidence',arguments:{evidence_id:'evidence_1'}});assert.equal(evidence.body.result.structuredContent.id,'evidence_1');
 assert((await f.rpc(f.token,'tools/call',{name:'xingtu_evidence',arguments:{evidence_id:'another_warehouse_evidence'}})).body.result.isError);
 for(const evidence_id of ['../outside','bad/id','https://evil.invalid','percent%2Fslash'])assert.equal((await f.rpc(f.token,'tools/call',{name:'xingtu_evidence',arguments:{evidence_id}})).status,400);
 const call=f.calls.find(([kind,input])=>kind==='knowledge'&&input.path==='/api/semantica/documents?limit=100&offset=0')[1];
 assert.equal(call.headers['x-wanx-data-context'],resourceId);assert.equal(call.method,'GET');
 assert(!JSON.stringify(f.calls).includes(f.token));assert(!JSON.stringify(f.calls).includes(legacyToken));
 for(const extra of [{warehouseId:'another'},{url:'https://untrusted.invalid'},{privacy_mode:'raw'}])
  assert.equal((await f.rpc(f.token,'tools/call',{name:'xingtu_search',arguments:{query:'masked query',...extra}})).status,400);
 const before=f.calls.length;
 assert.equal((await f.rpc(f.token,'tools/call',{name:'owner_graph',arguments:{}})).body.error.message,'MCP_TOOL_DENIED');
 assert(!f.calls.slice(before).some(([kind,input])=>kind==='knowledge'&&input.path.includes('/owner/graph')));
 f.revoke();assert.equal((await f.rpc(f.token)).status,403);
});
test('space text read retains checksum and file version; rejects another root and revoked grants',timeout,async t=>{
 const f=await fixture(t),r=await f.rpc(spaceKey,'tools/call',{name:'space_read_text',arguments:{target:'file1'}});assert.equal(r.body.result.structuredContent.text,'合成空间资料');assert.equal(r.body.result.structuredContent.version,1);
 assert((await f.rpc(spaceKey,'tools/call',{name:'space',arguments:{action:'read',target:'outside'}})).body.result.isError);
 assert((await f.rpc(spaceKey,'tools/call',{name:'space',arguments:{action:'list',grant_id:'extra'}})).body.result.isError);
 const d=await f.bridge.details();assert.equal(d.url,f.spaceUrl);assert(!JSON.stringify(d).includes(spaceKey));assert.equal(await f.bridge.spaceKey('id1'),spaceKey);
 f.revokeSpace();assert.equal((await f.rpc(spaceKey)).status,403);await assert.rejects(f.bridge.spaceKey('id1'));
});
test('account/box switch suppresses late knowledge results and the old space Key with bounded waits',timeout,async t=>{
 const f=await fixture(t),done=f.hold(),pending=f.rpc(f.token,'tools/call',{name:'xingtu_search',arguments:{query:'masked query',limit:5}});
 try{await waitFor(()=>f.calls.some(([kind,input])=>kind==='knowledge'&&input.path==='/api/semantica/search'));f.switch()}finally{done()}
 const r=await pending;assert(r.body.result.isError);assert(!JSON.stringify(r).includes('real-id'));assert.equal((await f.rpc(spaceKey)).status,401);assert.equal((await f.rpc(f.token)).status,403);
});
test('cross-endpoint capabilities fail authentication and the retired unified endpoint cannot operate',timeout,async t=>{
 const f=await fixture(t);
 assert.equal((await f.rpc(f.token,'tools/list',null,{},'POST',f.spaceUrl)).status,401);
 assert.equal((await f.rpc(spaceKey,'tools/list',null,{},'POST',f.url)).status,403);
 assert.equal(f.calls.length,0);
 for(const key of [f.token,spaceKey])assert.equal((await f.rpc(key,'tools/list',null,{},'POST',f.root+'/mcp')).status,410);
 const space=await f.bridge.details('space'),starlink=await f.bridge.details('starlink');
 assert.notEqual(space.url,starlink.url);assert(space.configuration.mcpServers['wanx-space']);assert(starlink.configuration.mcpServers.xingtu);
 assert.deepEqual(space.capabilities,['空间文件访问']);assert.deepEqual(starlink.capabilities,['星图知识读取']);
 const init=await f.rpc(spaceKey,'initialize',{protocolVersion:'2025-11-25'});assert.equal(init.body.result.serverInfo.name,'wanx-space');
});
