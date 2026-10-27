import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeamService} from '../integration/team-client/service.mjs';
import {createTeamDataService} from '../integration/team-client/data-service.mjs';
import {createDataShareAccess} from '../integration/team-client/data-share-service.mjs';

const appId='ai.wanx.selfmade.'+'a'.repeat(32),hash='b'.repeat(64),wid='12345678-1234-1234-1234-123456789abc';
function fixture({role='admin',authorization,protocolVersion=1,identitySecurityEnabled=false}={}){
  let accountId='account-1',generation=0,denied=false,intercept;
  const calls=[],listeners=new Set();
  const me={id:1,username:'owner',role,application_id:'wanx'};
  const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId,clientId:'client-1'},connection:{deviceId:'box-1'}}),subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn)),applicationConnection:async()=>{
    const captured=generation,account=accountId;
    const context=()=>{if(captured!==generation)throw Object.assign(Error('NETWORK_CHANGED'),{code:'NETWORK_CHANGED'});return {protocolVersion,authorization,accountId:account,clientId:'client-1',boxId:'box-1',user:{id:1}}};
    return {context,subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn)),request:async input=>{
      context();calls.push(input);await intercept?.(input);let value={};
      if(input.path==='/api/auth/me')value=me;
      else if(input.path==='/api/users')value=[{id:1,username:'owner',role:'admin',disabled:false},{id:2,username:'member',role:'user',disabled:false}];
      else if(input.path==='/api/users/invites')value=input.method==='POST'?{id:3,code:'INVITE-CODE',status:'active'}:[{id:3,code:'INVITE-CODE',status:'active'}];
      else if(input.path==='/api/app-studio/context')value={features:{teamPublishing:1}};
      else if(input.path==='/api/app-studio/projects')value={projects:[{id:'a'.repeat(32),appId,name:'Published'}]};
      else if(input.path==='/api/admin/applications/'+appId)value={created_by:1};
      else if(input.path==='/api/admin/applications/'+appId+'/deployment')value={enabled:true,configuration:{studio_team:{projectId:'a'.repeat(32),artifactHash:hash,audience:'selected'}}};
      else if(input.path==='/api/admin/applications/'+appId+'/access')value=[{user_id:2,enabled:true}];
      else if(input.path.endsWith('/install/'+hash))value={applicationId:appId,artifactHash:hash,version:'1.0.0'};
      else if(input.path==='/api/semantica/warehouses')value={items:[{id:wid,name:'Team warehouse'}]};
      return {status:denied&&input.path!=='/api/auth/me'?403:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(value))};
    }};
  }};
  const service=createTeamService({client,applications:{},identitySecurityEnabled});
  const data=createTeamDataService({client,applications:{},identitySecurityEnabled});
  return {client,service,data,calls,me,intercept:fn=>intercept=fn,deny:()=>denied=true,switch:()=>{accountId='account-2';generation++;for(const fn of [...listeners])fn()}};
}

test('disabled identity security uses verified native roles, members, invitations and user ACLs',async t=>{
  const f=fixture();t.after(()=>f.data.close());
  const identity=await f.service.identity();assert.ok(identity.permissions.includes('applications.manage'));assert.equal(identity.membershipId,'1');
  const members=await f.service.action('members');assert.equal(members[1].membershipId,'2');assert.equal(members[1].status,'active');
  assert.equal((await f.service.action('invites'))[0].code,'INVITE-CODE');
  assert.equal((await f.service.action('invite.create',{note:'Member'})).code,'INVITE-CODE');
  await f.service.action('member.update',{id:2,disabled:true});
  assert.deepEqual(JSON.parse(f.calls.at(-1).body),{disabled:true});
  await assert.rejects(f.service.action('member.update',{id:1,disabled:true}),{code:'TEAM_INPUT_INVALID'});
  const publication=await f.service.action('publication',{applicationId:appId});assert.deepEqual(publication.members,['2']);
  await f.service.action('publication-audience',{applicationId:appId,artifactHash:hash,audience:'selected',members:['2']});
  const writes=f.calls.filter(r=>r.path.endsWith('/access')&&r.method==='PUT').map(r=>JSON.parse(r.body));
  assert.deepEqual(writes,[{user_id:1,enabled:true},{user_id:2,enabled:true}]);
  await f.service.action('access',{applicationId:appId,userId:2,enabled:false});assert.deepEqual(JSON.parse(f.calls.at(-1).body),{user_id:2,enabled:false});
  assert.equal(f.calls.some(r=>JSON.stringify(r.headers).includes('team:application:')),false);
});

test('native member catalog and server denials retain their original authority',async t=>{
  const f=fixture({role:'user'});t.after(()=>f.data.close());
  assert.deepEqual((await f.service.identity()).permissions,[]);
  assert.equal((await f.service.action('catalog'))[0].appId,appId);
  await assert.rejects(f.service.action('members'),{code:'TEAM_ADMIN_REQUIRED'});
  await assert.rejects(f.service.action('invite.create'),{code:'TEAM_ADMIN_REQUIRED'});
  f.deny();await assert.rejects(f.service.action('catalog'),{code:'TEAM_PERMISSION_DENIED'});
});

test('native compatibility rejects local trust, malformed protocol and changed user binding',async t=>{
  for(const options of [{authorization:'local-trust-v1'},{protocolVersion:2}]){
    const f=fixture(options);t.after(()=>f.data.close());
    await assert.rejects(f.service.identity(),{code:'TEAM_IDENTITY_INVALID'});
    await assert.rejects(f.data.action('warehouses'));
  }
  const f=fixture();t.after(()=>f.data.close());f.me.id=9;
  await assert.rejects(f.service.identity(),{code:'TEAM_IDENTITY_INVALID'});
  await assert.rejects(f.data.action('warehouses'));
});

test('native team data uses existing team selector and invalidates captured connections',async t=>{
  const f=fixture();t.after(()=>f.data.close());
  assert.equal((await f.data.action('warehouses')).items[0].id,wid);
  assert.equal(f.calls.at(-1).headers['x-wanx-data-context'],'team');
  const old=await f.data.connection();f.switch();
  await assert.rejects(old.request({path:'/api/semantica/warehouses'}));
  f.me.role='user';await assert.rejects(f.data.action('warehouses'),{code:'TEAM_ADMIN_REQUIRED'});
});

test('native team service rejects a response after the cloud account changes',async t=>{
  const f=fixture({role:'user'});t.after(()=>f.data.close());
  f.intercept(input=>{if(input.path==='/api/app-studio/context')f.switch()});
  await assert.rejects(f.service.action('catalog'),{code:'NETWORK_CHANGED'});
  assert.equal(f.calls.some(input=>input.path==='/api/app-studio/projects'),false);
});

test('identity security remains strict by default for native contexts',async t=>{
  const f=fixture();t.after(()=>f.data.close());
  await assert.rejects(createTeamService({client:f.client}).identity(),{code:'TEAM_IDENTITY_INVALID'});
  const data=createTeamDataService({client:f.client});t.after(()=>data.close());await assert.rejects(data.action('warehouses'),{code:'TEAM_ADMIN_REQUIRED'});
});

test('disabled identity security shares native warehouse keys without advertising signed MCP',async()=>{
  const calls=[],key={id:'key-1',expires_at:Math.floor(Date.now()/1000)+600},token='synthetic-native-key';
  const sharing=createDataShareAccess({identitySecurityEnabled:false,identity:async()=>({next:'scope-1'}),instance:async()=>({call:async(action,input)=>{
    calls.push([action,input]);return action==='warehouse'?{id:wid,name:'Team'}:action==='runtime'?{api_base_url:'/api/open/v1'}:action==='keys'?{items:[key]}:action==='create-key'?{key,token}:{};
  }}),getMcpDetails:async()=>({url:'http://127.0.0.1:19878/mcp/starlink'})});
  const details=await sharing.action('share-details',{warehouseId:wid});assert.equal(details.sessionBound,false);assert.equal(details.hostBase,'/api/semantica/open/v1');
  const issued=await sharing.action('create-share-key',{warehouseId:wid,name:'Read only',days:7});assert.equal(issued.token,undefined);
  assert.deepEqual(calls.find(([name])=>name==='create-key')[1].scopes,['documents','evidence','graph','search']);
  assert.equal((await sharing.action('reveal-share-key',{warehouseId:wid,handle:issued.handle})).token,token);
});
