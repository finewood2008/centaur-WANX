import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../client.mjs';

function fixture({delay}={}){
 const targets=[],gateways=[];let token='first',parentClosed=0;
 const network={snapshot:()=>({}),subscribe:()=>()=>{},resolveEndpoint:async input=>{targets.push(input);return {url:input.url,agent:input.url};},close(){}};
 const client=createClient({network,probe:async()=>{},createGateway:async options=>{
  if(options.businessService&&delay)await delay;
  const g={url:'http://127.0.0.1:18888',closed:false,async request(input){return {body:options.session?.getToken(),path:input.path};},async close(){this.closed=true;options.session?.close();}};
  gateways.push({options,g});return g;
 }});
 return {client,targets,gateways,setToken:v=>token=v,closed:()=>parentClosed,session:{getToken:()=>token,close(){parentClosed++;}}};
}
const input={deviceId:'box-a',url:'http://100.90.1.2:8088',mode:'netbird'};
test('platform clipboard shares the authenticated ingress, parent token and connection lifetime',async()=>{
 const f=fixture();await f.client.connect(input,{createSession:async()=>f.session});
 const conn=f.client.applicationConnection();
 assert.equal((await conn.businessRequest('clipboard',{path:'/api/clipboard/v1'})).body,'first');
 assert.equal(f.targets.length,1);
 assert.equal(f.targets[0].url,'http://100.90.1.2:8088');
 f.setToken('renewed');assert.equal((await conn.businessRequest('clipboard',{path:'/api/clipboard/v1?kind=text'})).body,'renewed');
 assert.equal(f.gateways.length,1);
 await f.client.disconnect();assert.ok(f.gateways.every(({g})=>g.closed));assert.equal(f.closed(),1);
 await assert.rejects(conn.businessRequest('clipboard',{path:'/api/clipboard/v1'}),/SESSION_CLOSED/);
});
test('direct local cores retain the fixed independent business port without a platform ingress',async()=>{
 const f=fixture();await f.client.connect({...input,url:'http://127.0.0.1:8089',mode:'direct'});
 await f.client.applicationConnection().businessRequest('clipboard',{path:'/api/clipboard/v1/note'});
 assert.equal(f.targets[1].url,'http://127.0.0.1:8092');
 assert.equal(f.gateways[1].options.businessService,'clipboard');
 await f.client.close();assert.ok(f.gateways.every(({g})=>g.closed));
});
test('no arbitrary business name, path, port or application credential can use owner clipboard connection',async()=>{
 const f=fixture();await f.client.connect(input,{createSession:async()=>f.session});const conn=f.client.applicationConnection();
 for(const [service,path]of [['other','/api/clipboard/v1'],['clipboard','/api/auth/me'],['clipboard','/api/clipboard/v1/../auth'],['clipboard','/api/clipboard/v1/%2e%2e/auth'],['clipboard','/api/clipboard/v1\\evil']])
  await assert.rejects(conn.businessRequest(service,{path}),{code:'BUSINESS_SERVICE_SCOPE'});
 await assert.rejects(f.client.applicationConnection('untrusted-app').businessRequest('clipboard',{path:'/api/clipboard/v1'}),{code:'BUSINESS_SERVICE_SCOPE'});
 assert.equal(f.gateways.length,1);await f.client.close();
});
test('switching box while a direct business gateway is opening closes it and never returns old data',async()=>{
 let release;const f=fixture({delay:new Promise(r=>release=r)});await f.client.connect(input);
 const request=f.client.applicationConnection().businessRequest('clipboard',{path:'/api/clipboard/v1'});const denied=assert.rejects(request,/SESSION_CLOSED/);
 await new Promise(r=>setImmediate(r));const disconnect=f.client.disconnect();release();await denied;await disconnect;
 assert.ok(f.gateways.every(({g})=>g.closed));
});
test('platform business replies arriving after a box switch are rejected without another port attempt',async()=>{
 let release;const f=fixture();await f.client.connect(input,{createSession:async()=>f.session});
 f.gateways[0].g.request=()=>new Promise(r=>release=r);
 const reply=f.client.applicationConnection().businessRequest('clipboard',{path:'/api/clipboard/v1/note'});
 const denied=assert.rejects(reply,/SESSION_CLOSED/);
 await f.client.disconnect();release({status:200});await denied;
 assert.equal(f.targets.length,1);
});

for (const platform of [false, true]) {
 test(`clipboard resumes through fresh ${platform ? 'platform ingress' : 'local business gateway'} after network recovery`, async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let agent={}, failNext=false, sessions=0;
  const gateways=[];
  const network={snapshot:()=>({}),subscribe:()=>()=>{},close(){},networkChanged:async()=>{},
   resolveEndpoint:async value=>({url:value.url,agent})};
  const client=createClient({network,probe:async()=>{
   if(failNext){failNext=false;agent={};throw new Error('network_unavailable');}
  },createGateway:async options=>{
   const gateway={url:'http://127.0.0.1:18888',closed:false,
    async request(){return {token:options.session?.getToken()};},
    async close(){this.closed=true;await options.session?.close();}};
   gateways.push({options,gateway});return gateway;
  }});
  t.after(()=>client.close());
  await client.connect({...input,mode:platform?'netbird':'direct'},platform?{createSession:async()=>{
   const token=`session-${++sessions}`;return {getToken:()=>token,close(){}};
  }}:{});
  const old=client.applicationConnection();
  await old.businessRequest('clipboard',{path:'/api/clipboard/v1/note'});
  const previous=gateways.map(item=>item.gateway);
  failNext=true;t.mock.timers.tick(30_000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(client.snapshot().phase,'ready');
  assert.ok(previous.every(gateway=>gateway.closed));
  await assert.rejects(old.businessRequest('clipboard',{path:'/api/clipboard/v1/note'}),/SESSION_CLOSED/);
  const result=await client.applicationConnection().businessRequest('clipboard',{path:'/api/clipboard/v1/note'});
  assert.equal(result.token,platform?'session-2':undefined);
  assert.equal(gateways.length,platform?2:4);
  assert.equal(gateways.at(-1).options.agent,agent);
  assert.equal(Boolean(gateways.at(-1).options.businessService),!platform);
 });
}
