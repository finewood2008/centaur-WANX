import test from 'node:test';
import assert from 'node:assert/strict';
import {createDataShareAccess} from '../integration/team-client/data-share-service.mjs';
const wid='12345678-1234-1234-1234-123456789abc',other='12345678-1234-1234-1234-123456789def';
function setup(){let admin=true,scope='a',copied='',revoked=false;const calls=[],key={id:'key1',name:'业务 Agent',prefix:'wmcp_synthet',scopes:['documents','graph','search','evidence'],expires_at:Math.floor(Date.now()/1000)+86400};
 const token='wmcp_synthetic_test_token_not_for_real_use';
 const api={call:async(action,input)=>{calls.push([action,input]);if(action==='warehouse')return {id:input.id,name:'团队仓'};if(action==='runtime')return {api_base_url:'http://127.0.0.1:8090/api/open/v1'};if(action==='keys')return {items:[{...key,revoked_at:revoked?'now':null}]};if(action==='create-key')return {key,token};throw Error('unexpected action')}};
 const identity=async()=>{if(!admin)throw Object.assign(Error('TEAM_ADMIN_REQUIRED'),{code:'TEAM_ADMIN_REQUIRED'});return {next:scope}};
 const service=createDataShareAccess({identity,knowledgeCapabilities:{clear(){revoked=true},list:async()=>({items:[{...key,revoked_at:revoked?'now':null}]}),create:async input=>{calls.push(['create-capability',input]);return {key,token}}},instance:async()=>api,writeClipboard:v=>{copied=v},getMcpDetails:async()=>({url:"http://127.0.0.1:19878/mcp/starlink",configuration:{mcpServers:{xingtu:{url:"http://127.0.0.1:19878/mcp/starlink"}}}})});
 return {service,calls,token,copied:()=>copied,role:()=>admin=false,switch:()=>scope='b',revoke:()=>revoked=true};
}
test('share details return existing routes and Key metadata without generating or disclosing credentials',async()=>{
 const s=setup(),result=await s.service.action('share-details',{warehouseId:wid});assert.equal(result.mcpUrl,'http://127.0.0.1:19878/mcp/starlink');assert.equal(result.hostBase,'session-bound-mcp');assert.equal(result.sessionBound,true);assert.doesNotMatch(result.hostExample,/X-Xingtu-Key/);assert(!JSON.stringify(result).includes(s.token));assert(!s.calls.some(([a])=>a==='create-key'));
});
test('new shares use fixed read scopes and copy by opaque handle; no raw secret in creation response',async()=>{
 const s=setup(),g=await s.service.action('create-share-key',{warehouseId:wid,name:'外部只读应用',days:30,scopes:['reasoning']});assert(!JSON.stringify(g).includes(s.token));assert.deepEqual(g.key.scopes,['documents','graph','search','evidence']);assert.equal(s.calls.some(([a])=>a==='create-key'),false);await s.service.action('copy-share-key',{warehouseId:wid,handle:g.handle});assert.equal(s.copied(),s.token);assert.equal((await s.service.action('reveal-share-key',{warehouseId:wid,handle:g.handle})).token,s.token);
});
test('revocation, release, another warehouse, switched identity and downgrade deny secret delivery',async()=>{
 for(const change of ['revoke','release','warehouse','scope','role']){const s=setup(),g=await s.service.action('create-share-key',{warehouseId:wid,name:'外部只读应用',days:7});let target=wid;
 if(change==='revoke')s.revoke();if(change==='release')await s.service.action('release-share-key',{handle:g.handle});if(change==='warehouse')target=other;if(change==='scope')s.switch();if(change==='role')s.role();
 await assert.rejects(s.service.action('copy-share-key',{warehouseId:target,handle:g.handle}));assert.equal(s.copied(),'');}
});
test('page clear destroys one-time secrets and clipboard only accepts known interface values',async()=>{
 const s=setup(),g=await s.service.action('create-share-key',{warehouseId:wid,name:'业务应用',days:30});s.service.clear();await assert.rejects(s.service.action('reveal-share-key',{warehouseId:wid,handle:g.handle}));await assert.rejects(s.service.action('copy-share-value',{warehouseId:wid,kind:'arbitrary',text:'untrusted'}));await s.service.action('copy-share-value',{warehouseId:wid,kind:'mcp-url'});assert.equal(s.copied(),'http://127.0.0.1:19878/mcp/starlink');
});
