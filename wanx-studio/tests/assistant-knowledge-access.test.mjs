import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wrapAssistantKnowledgeAccess} from '../integration/team-client/assistant-knowledge-access.js';
import {assistantAwareTeamDataService} from '../integration/team-client/assistant-team-data-addon.mjs';
const wid='11111111-1111-4111-8111-111111111111';
test('installed Starlink UI extension preserves existing controls and is admin-only',async()=>{
  let calls=0;const original={sync(){},render:()=>'<header><button data-data-action="share-create" data-warehouse-id="'+wid+'">Key</button></header>',action:async()=>{calls++;return 'existing'}};
  const view=wrapAssistantKnowledgeAccess(()=>original)({});
  view.sync({account:{accountId:'qa'},activeDeviceId:'box'},false);
  assert(!view.render().includes('assistant-access'));
  await view.action('assistant-access',{warehouseId:wid});assert.equal(calls,0);
  view.sync({account:{accountId:'qa'},activeDeviceId:'box'},true);
  assert(view.render().includes('助理授权'));assert(view.render().includes('>Key</button>'));
  assert.equal(await view.action('refresh',{}),'existing');
});
test('native service extension reuses the current admin guard and limits its routes',async()=>{
  let allowed=false;const seen=[];
  const native={async action(){return 'existing'},async connection(){if(!allowed)throw Object.assign(Error('TEAM_ADMIN_REQUIRED'),{code:'TEAM_ADMIN_REQUIRED'});return {context(){},async request(value){seen.push(value);return {status:200,body:Buffer.from('{"revision":1}')}}}}};
  const service=assistantAwareTeamDataService(()=>native,{});
  await assert.rejects(service.action('assistant-access',{warehouseId:wid}),{code:'TEAM_ADMIN_REQUIRED'});
  assert.equal(await service.action('warehouses',{}),'existing');allowed=true;
  await service.action('assistant-access-update',{warehouseId:wid,audience:'selected',members:[2],revision:0});
  assert.equal(seen[0].path,'/api/assistant/knowledge/access/'+wid);assert.equal(seen[0].method,'PUT');
  assert.deepEqual(JSON.parse(seen[0].body),{audience:'selected',members:[2],revision:0});
  await assert.rejects(service.action('assistant-access',{warehouseId:'../other'}),{code:'TEAM_DATA_TARGET_INVALID'});
});
