import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeamDataService,starlinkTarget} from '../integration/team-client/data-service.mjs';
function setup(){let role='admin',account='a';const requests=[],listeners=new Set();
 const client={snapshot:()=>({phase:'ready',account:{accountId:account,clientId:'c'},connection:{deviceId:'b'}}),subscribe:f=>(listeners.add(f),()=>listeners.delete(f)),applicationConnection:async()=>({context:()=>({boxId:'b',user:{id:1}}),subscribe:()=>()=>{},request:async i=>{requests.push(i);return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(i.path==='/api/auth/me'?{id:1,role,application_id:'wanx'}:{items:[]}))}}})};
 const service=createTeamDataService({client,applications:{listInstalled:async()=>[]}});
 return {service,requests,role:r=>role=r,switch:()=>{account='b';for(const f of listeners)f()}};
}
test('team requests use the private selector and recheck live admin identity',async()=>{
 const s=setup();await s.service.action('warehouses');assert.equal(s.requests.at(-1).headers['x-wanx-data-context'],'team');
 s.role('user');await assert.rejects(s.service.action('warehouses'),{code:'TEAM_ADMIN_REQUIRED'});assert.equal(s.requests.at(-1).path,'/api/auth/me');s.service.close();
});
test('old connection cannot read after account switch',async()=>{const s=setup(),link=await s.service.connection();s.switch();await assert.rejects(link.request({path:'/api/semantica/warehouses'}),{code:'TEAM_SESSION_CHANGED'});s.service.close()});
test('arbitrary management actions and malformed launch targets are rejected',async()=>{const s=setup();await assert.rejects(s.service.action('delete-warehouse'),{code:'TEAM_DATA_ACTION_DENIED'});assert.throws(()=>starlinkTarget({warehouseId:'../../other',view:'graph'}));assert.throws(()=>starlinkTarget({view:'models',token:'secret'}));await assert.rejects(s.service.action('open-starlink',{view:'warehouses'}),{code:'TEAM_STARLINK_NOT_INSTALLED'});s.service.close()});
function platformSetup(){let generation=0,role='admin';const snapshots=new Set(),leases=new Set();
 const client={snapshot:()=>({phase:'ready',account:{accountId:'platform',clientId:'stable'},connection:{deviceId:'same-box'}}),subscribe:fn=>(snapshots.add(fn),()=>snapshots.delete(fn)),applicationConnection:async()=>{
  const captured=generation;const live=()=>{if(captured!==generation)throw Object.assign(Error('NETWORK_CHANGED'),{code:'NETWORK_CHANGED'})};
  return {context:()=>{live();return {boxId:'same-box',user:{id:1}}},subscribe:fn=>(leases.add(fn),()=>leases.delete(fn)),request:async input=>{live();return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(input.path==='/api/auth/me'?{id:1,role,application_id:'wanx'}:{items:[{id:'warehouse',name:'真实连接仓'}]}))}}};
 }};
 const service=createTeamDataService({client,applications:{}});
 const emit=()=>{for(const f of [...snapshots])f(client.snapshot());for(const f of [...leases])f(client.snapshot())};
 return {service,emit,reconnect:()=>{generation++;emit()},downgrade:()=>{role='user';emit()}};
}
test('normal platform health snapshots do not invalidate data or poison later requests',async()=>{
 const s=platformSetup();await s.service.action('warehouses');s.emit();assert.equal((await s.service.action('warehouses')).items[0].name,'真实连接仓');s.service.close();
});
test('same-account same-box reconnection rebuilds the cached data connection and keeps old leases invalid',async()=>{
 const s=platformSetup();await s.service.action('warehouses');const old=await s.service.connection();s.reconnect();assert.equal((await s.service.action('warehouses')).items.length,1);await assert.rejects(old.request({path:'/api/semantica/warehouses'}),{code:'NETWORK_CHANGED'});s.downgrade();await assert.rejects(s.service.action('warehouses'),{code:'TEAM_ADMIN_REQUIRED'});s.service.close();
});
test('current-model reprocessing keeps document versions and config signature on the existing authorized API',async()=>{
 const s=setup(),wid='12345678-1234-1234-1234-123456789abc';
 await s.service.action('reprocess-models',{warehouseId:wid,documents:[{id:'doc',version_id:'version'}],expectedSignature:'a'.repeat(64)});
 const request=s.requests.find(r=>r.path==='/api/semantica/processing/reprocess'),body=JSON.parse(request.body.toString());
 assert.equal(request.headers['x-wanx-data-context'],'team');assert.equal(body.warehouse_id,wid);assert.equal(body.expected_signature,'a'.repeat(64));assert.deepEqual(body.documents,[{id:'doc',version_id:'version'}]);assert.match(body.operation_id,/^[a-f0-9-]{36}$/);
 s.role('user');await assert.rejects(s.service.action('reprocess-models',{warehouseId:wid}),{code:'TEAM_ADMIN_REQUIRED'});s.service.close();
});
