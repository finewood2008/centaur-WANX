import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '../../wanx-team-client/client.mjs';
import {createStudioEntry} from '../integration/host-entry.mjs';

async function fixture(t, request, probe=async()=>({ok:true})) {
 const network={snapshot:()=>({enabled:true,phase:'ready',peers:[]}),subscribe:()=>()=>{},
  resolveEndpoint:async input=>({url:input.url}),networkChanged:async()=>{},close(){}};
 const client=createClient({network,probe,createGateway:async()=>({
  url:'http://127.0.0.1:1',request,close(){},
 })});
 t.after(()=>client.close());
 await client.connect({deviceId:'builder-test',url:'http://127.0.0.1:8088',mode:'direct'});
 const entry=createStudioEntry({createConnection:async()=>({
  ...client.applicationConnection('ai.wanx.studio'),
  context:()=>({accountId:'test-account',boxId:'builder-test',user:{id:1}}),
 })});
 return {client,entry};
}

for(const status of [404,503])test(`Builder HTTP ${status} leaves the current box connected`,async t=>{
 const {client,entry}=await fixture(t,async()=>({status,body:Buffer.from('{}')}));
 const outcomes=await Promise.allSettled([entry.overview(),entry.enginesList()]);
 for(const result of outcomes){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'STUDIO_UNAVAILABLE')}
 assert.equal(client.snapshot().phase,'ready');assert.equal(client.snapshot().recovery,null);
 assert.equal(client.snapshot().connection.deviceId,'builder-test');
});

test('Builder transport failure with an unhealthy box starts recovery without replaying the request',{timeout:3000},async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let requests=0,down=false;
 const {client,entry}=await fixture(t,async()=>{requests++;throw Object.assign(new Error('socket reset'),{code:'ECONNRESET'})},async()=>{
  if(down)throw Object.assign(new Error('health unavailable'),{code:'health_unavailable'});return{ok:true};
 });
 down=true;
 await assert.rejects(entry.enginesList(),{code:'ECONNRESET'});
 assert.equal(client.snapshot().phase,'ready');assert.equal(client.snapshot().recovery,null);
 t.mock.timers.tick(0);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(client.snapshot().phase,'recovering');assert.equal(client.snapshot().connection.deviceId,'builder-test');
 assert.equal(requests,1);
});
