import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createWanxMcpBridge} from '../integration/team-client/wanx-mcp-bridge.mjs';

const key='xg_synthetic_warehouse_key_never_a_real_credential';
const timeout={timeout:10000};
async function fixture(t,options={identitySecurityEnabled:false}){
 let current='account-a:box-a',denied=false,hold,entered;
 const calls=[],state={port:0,links:[]};
 const assertScope=bound=>{if(bound!==current)throw Object.assign(Error('SPACE_CONTEXT_CHANGED'),{code:'SPACE_CONTEXT_CHANGED',status:403})};
 const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:current,clientId:'cloud-client'},connection:{deviceId:'box-'+current}}),applicationConnection:async applicationId=>{
  assert.equal(applicationId,'wanx');
  const bound=current;
  return {context:()=>{assertScope(bound);return {accountId:bound,clientId:'cloud-client',boxId:'box-'+bound,user:{id:7,role:'user'},authorization:'platform'}},request:async input=>{
   assertScope(bound);calls.push(input);
   assert.equal(input.headers['X-Xingtu-Key'],key);
   assert.equal(input.headers['x-wanx-data-context'],undefined);
   assert.equal(input.headers.authorization,undefined);
   if(denied)return {status:403,body:Buffer.from('{"code":"WAREHOUSE_KEY_REVOKED"}')};
   const url=new URL(input.path,'https://fixture.invalid');
   assert(url.pathname.startsWith('/api/semantica/open/v1/'));
   if(url.pathname.endsWith('/search')&&hold){entered();await hold}
   return {status:200,body:Buffer.from(JSON.stringify({id:'authorized-warehouse',path:url.pathname}))};
  }};
 }};
 const bridge=createWanxMcpBridge({client,state,scope:()=>current,assertScope,...options});
 const server=http.createServer((req,res)=>void bridge.handle(req,res));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 state.port=server.address().port;
 t.after(()=>{server.closeAllConnections();server.close()});
 async function rpc(token=key,method='tools/list',params){
  const response=await fetch(`http://127.0.0.1:${state.port}/mcp/starlink`,{method:'POST',signal:AbortSignal.timeout(4000),
   headers:{accept:'application/json, text/event-stream','content-type':'application/json',authorization:'Bearer '+token},
   body:JSON.stringify({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})});
  return {status:response.status,body:await response.json()};
 }
 return {rpc,bridge,calls,revoke:()=>{denied=true},switch:()=>{current='account-b:box-b'},holdSearch:()=>{
  let release;hold=new Promise(resolve=>{release=resolve});
  return {entered:new Promise(resolve=>{entered=resolve}),release};
 }};
}

test('disabled identity security uses the existing authenticated warehouse Key API without local capabilities',timeout,async t=>{
 const f=await fixture(t),details=await f.bridge.details('starlink');
 assert.equal(details.authentication,'Authorization: Bearer <仓库 Key>');
 assert.match(details.url,/\/mcp\/starlink$/);assert(details.configuration.mcpServers.xingtu);
 assert(!JSON.stringify(details).includes(key));
 const listed=await f.rpc();assert.equal(listed.status,200);
 assert.deepEqual(listed.body.result.tools.map(row=>row.name),['xingtu_warehouse','xingtu_documents','xingtu_graph','xingtu_search','xingtu_evidence']);
 for(const [name,args,path] of [
  ['xingtu_warehouse',{},'/warehouse'],
  ['xingtu_documents',{limit:10,offset:0},'/documents?limit=10&offset=0'],
  ['xingtu_graph',{entity_id:'entity_1'},'/graph?entity_id=entity_1'],
  ['xingtu_evidence',{evidence_id:'evidence_1'},'/evidence/evidence_1'],
  ['xingtu_search',{query:'fixture query',limit:5},'/search'],
 ]){
  const result=await f.rpc(key,'tools/call',{name,arguments:args});
  assert.equal(result.status,200);assert.equal(result.body.result.structuredContent.id,'authorized-warehouse');
  assert(f.calls.some(input=>input.path==='/api/semantica/open/v1'+path));
 }
 const search=f.calls.find(input=>input.path.endsWith('/search'));
 assert.equal(search.method,'POST');assert.deepEqual(JSON.parse(search.body.toString()),{query:'fixture query',limit:5});
 assert(!JSON.stringify(listed).includes(key));
});

test('default identity security still rejects warehouse Keys without a current local capability',timeout,async t=>{
 const f=await fixture(t,{});
 assert.equal((await f.rpc()).status,401);assert.equal(f.calls.length,0);
 assert.equal((await f.bridge.details('starlink')).authentication,'Authorization: Bearer <本机会话 Key>');
});

test('cloud MCP keeps server revocation and the finite read-only tool boundary',timeout,async t=>{
 const f=await fixture(t);
 assert.equal((await f.rpc('wmcp_'+ 'a'.repeat(43))).status,401);assert.equal(f.calls.length,0);
 const invalid=await f.rpc(key,'tools/call',{name:'xingtu_search',arguments:{query:'fixture',warehouseId:'outside'}});
 assert.equal(invalid.status,400);assert(!f.calls.some(input=>input.path.endsWith('/search')));
 const write=await f.rpc(key,'tools/call',{name:'create_key',arguments:{}});
 assert.equal(write.body.error.message,'MCP_TOOL_DENIED');
 f.revoke();const revoked=await f.rpc();
 assert.equal(revoked.status,403);assert.equal(revoked.body.error.message,'WAREHOUSE_KEY_REVOKED');
});

test('cloud MCP suppresses a late server result after account or box switch',timeout,async t=>{
 const f=await fixture(t),wait=f.holdSearch();
 const pending=f.rpc(key,'tools/call',{name:'xingtu_search',arguments:{query:'fixture'}});
 try{await wait.entered;f.switch()}finally{wait.release()}
 const result=await pending;
 assert.equal(result.body.result.isError,true);
 assert(!JSON.stringify(result).includes('authorized-warehouse'));
});
