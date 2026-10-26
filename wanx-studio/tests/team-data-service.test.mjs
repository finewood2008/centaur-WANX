import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeamDataService,starlinkTarget} from '../integration/team-client/data-service.mjs';
const wid='12345678-1234-1234-1234-123456789abc';
const grants=[{resourceId:'team:knowledge:'+wid,actions:['read','write']}];
const local=(generation=0)=>({profileId:'synthetic',generation,selected:{principalId:'principal',bindingId:'binding'}});
const context=boxId=>({boxId,authorization:'local-trust-v1',dataIdentity:{grants},user:{id:1}});
const me=role=>({id:1,role:'user',application_id:'wanx',team:{permissions:role==='admin'?['resources.manage']:[]}});
function setup(){let role='admin',account='a';const requests=[],listeners=new Set();
 const client={snapshot:()=>({phase:'ready',account:{accountId:account,clientId:'c'},dataIdentity:local(account),connection:{deviceId:'b'}}),subscribe:f=>(listeners.add(f),()=>listeners.delete(f)),applicationConnection:async()=>({context:()=>context('b'),subscribe:()=>()=>{},request:async i=>{requests.push(i);return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(i.path==='/api/auth/me'?me(role):{items:[]}))}}})};
 const service=createTeamDataService({client,applications:{listInstalled:async()=>[]}});
 return {service,requests,role:r=>role=r,switch:()=>{account='b';for(const f of listeners)f()}};
}
test('team requests use the private selector and recheck live admin identity',async()=>{
 const s=setup();await s.service.action('warehouses');assert.equal(s.requests.at(-1).headers['x-wanx-data-context'],'team:knowledge:'+wid);
 s.role('user');await assert.rejects(s.service.action('warehouses'),{code:'TEAM_ADMIN_REQUIRED'});assert.equal(s.requests.at(-1).path,'/api/auth/me');s.service.close();
});
test('old connection cannot read after account switch',async()=>{const s=setup(),link=await s.service.connection();s.switch();await assert.rejects(link.request({path:'/api/semantica/warehouses'}),{code:'TEAM_SESSION_CHANGED'});s.service.close()});
test('arbitrary management actions and malformed launch targets are rejected',async()=>{const s=setup();await assert.rejects(s.service.action('delete-warehouse'),{code:'TEAM_DATA_ACTION_DENIED'});assert.throws(()=>starlinkTarget({warehouseId:'../../other',view:'graph'}));assert.throws(()=>starlinkTarget({view:'models',token:'secret'}));await assert.rejects(s.service.action('open-starlink',{view:'warehouses'}),{code:'TEAM_STARLINK_NOT_INSTALLED'});s.service.close()});
function platformSetup(){let generation=0,role='admin';const snapshots=new Set(),leases=new Set();
 const client={snapshot:()=>({phase:'ready',account:{accountId:'platform',clientId:'stable'},dataIdentity:local(generation),connection:{deviceId:'same-box'}}),subscribe:fn=>(snapshots.add(fn),()=>snapshots.delete(fn)),applicationConnection:async()=>{
  const captured=generation;const live=()=>{if(captured!==generation)throw Object.assign(Error('NETWORK_CHANGED'),{code:'NETWORK_CHANGED'})};
  return {context:()=>{live();return context('same-box')},subscribe:fn=>(leases.add(fn),()=>leases.delete(fn)),request:async input=>{live();return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(input.path==='/api/auth/me'?me(role):{items:[{id:'warehouse',name:'真实连接仓'}]}))}}};
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
 assert.equal(request.headers['x-wanx-data-context'],'team:knowledge:'+wid);assert.equal(body.warehouse_id,wid);assert.equal(body.expected_signature,'a'.repeat(64));assert.deepEqual(body.documents,[{id:'doc',version_id:'version'}]);assert.match(body.operation_id,/^[a-f0-9-]{36}$/);
 s.role('user');await assert.rejects(s.service.action('reprocess-models',{warehouseId:wid}),{code:'TEAM_ADMIN_REQUIRED'});s.service.close();
});

test('consecutive creates select distinct unused approved warehouses and identity invalidation clears the previous selection',async()=>{
 const second='12345678-1234-1234-1234-123456789abd', allowed=[wid,second];
 let generation=0;const listeners=new Set(),created=new Set(),writes=[];
 const client={snapshot:()=>({phase:'ready',dataIdentity:local(generation),connection:{deviceId:'same-box'}}),subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn)),applicationConnection:async()=>({
  context:()=>({...context('same-box'),dataIdentity:{grants:allowed.map(id=>({resourceId:'team:knowledge:'+id,actions:['read','write']}))}}),subscribe:()=>()=>{},
  request:async input=>{
   let value;
   if(input.path==='/api/auth/me')value=me('admin');
   else if(input.path==='/api/semantica/warehouses'){
    const id=input.headers['x-wanx-data-context']?.slice('team:knowledge:'.length);assert.ok(allowed.includes(id));
    if(input.method==='POST'){assert.equal(created.has(id),false,'must never reuse an existing warehouse');created.add(id);writes.push(id);value={id,name:id};}
    else value={items:created.has(id)?[{id,name:id}]:[]};
   }else throw Error('unexpected path '+input.path);
   return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(value))};
  }
 })};
 const service=createTeamDataService({client,applications:{}});
 try{
  await service.action('create-warehouse',{name:'first'});
  await service.action('create-warehouse',{name:'second'});
  assert.deepEqual(writes,allowed);
  await assert.rejects(service.action('create-warehouse',{name:'no third approval'}),{code:'TEAM_RESOURCE_APPROVAL_REQUIRED'});
  await service.action('select-warehouse',{warehouseId:wid});
  generation++;for(const listener of listeners)listener();
  const fresh=await service.connection();
  await assert.rejects(fresh.request({path:'/api/semantica/warehouses'}),{code:'TEAM_RESOURCE_SELECTION_REQUIRED'});
 }finally{service.close()}
});
