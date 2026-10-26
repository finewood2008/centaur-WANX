import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantChannels} from '../integration/team-client/assistant-channels.mjs';
import {createAIDialogue} from '../integration/team-client/assistant-service.mjs';

function fixture(){
  let scope='owner-box', next=1; const rows=new Map(),routes=[],overrides=new Map(),cleanups=[];
  const base='/api/agents/private-default/channels';
  const publicRow=row=>({...row,config:undefined,runtime:{connected:row.enabled}});
  const request=async(key,route,options={})=>{
    assert.equal(key,scope,'stale account/box request');routes.push({route,...options});
    if(overrides.has(route))return overrides.get(route)(options);
    const channelId=route.slice(base.length+1), row=rows.get(channelId);
    if(route===base){
      if(options.method==='POST'){const value={...options.body,id:'channel-'+next++,enabled:true,agent_id:'private-default'};rows.set(value.id,value);return publicRow(value);}
      return [...rows.values()].map(publicRow);
    }
    if(!row)throw Object.assign(Error(),{code:'NOT_FOUND'});
    if(options.method==='DELETE'){rows.delete(channelId);return {};}
    if(options.method==='PATCH'){Object.assign(row,options.body);return publicRow(row);}
    return structuredClone(row);
  };
  const service=createAssistantChannels({request,base:()=>base,assertScope:key=>assert.equal(key,scope),cleanup:async(key,route)=>cleanups.push({key,route})});
  return {service,rows,routes,cleanups,base,act:(method,input={})=>service.action('channels-'+method,input,scope),override:(path,value)=>overrides.set(base+path,typeof value==='function'?value:()=>structuredClone(value)),changeScope(){service.reset();scope='other-owner-box';}};
}

test('manual channel credentials are merged in main and never returned to the renderer',async()=>{
  const f=fixture();const saved=await f.act('save',{kind:'feishu',name:'Synthetic',values:{app_id:'app-fixture',app_secret:'secret-fixture'}});
  const cid=saved.channel.id;f.rows.get(cid).config.extra_native_setting=true;
  const detail=await f.act('detail',{id:cid});assert.deepEqual(detail.configured,['app_secret']);assert.deepEqual(detail.values,{app_id:'app-fixture'});
  assert(!JSON.stringify([saved,detail]).includes('secret-fixture'));
  await f.act('save',{id:cid,name:'Renamed',values:{app_id:'app-new',app_secret:''}});
  assert.equal(f.rows.get(cid).config.app_secret,'secret-fixture');assert.equal(f.rows.get(cid).config.extra_native_setting,true);
  await f.act('toggle',{id:cid,enabled:false});assert.equal((await f.act('list')).items[0].status,'disabled');
  await f.act('delete',{id:cid});assert.equal(f.rows.size,0);
});

test('fixed channel schema blocks arbitrary kinds, routes, config keys, and incomplete secrets',async()=>{
  const f=fixture();for(const input of [
    {kind:'mqtt',values:{}},{kind:'wecom',values:{bot_id:'x'}},
    {kind:'wecom',values:{bot_id:'x',secret:'s',websocket_url:'https://evil.test'}},
    {kind:'wecom',values:{bot_id:'x',secret:42}},
  ])await assert.rejects(f.act('save',{name:'Fixture',...input}));
  await assert.rejects(f.act('detail',{id:'../foreign'}));
  await assert.rejects(f.act('toggle',{id:'missing',enabled:true}));
  assert.equal(f.routes.filter(r=>r.method==='POST').length,0);
});

for(const kind of ['weixin','wecom','feishu','dingtalk'])test(`${kind} QR completion saves only to the private assistant and hides native secrets`,async()=>{
  const f=fixture(),generate=kind==='feishu'?'/bot-creator/start':'/qrcode/generate',poll=kind==='feishu'?'/bot-creator/poll':'/qrcode/poll';
  f.override('/'+kind+generate,{qrcode_token:'private-ticket',scode:'private-scode',registration_id:'private-registration',qrcode_url:'https://platform.test/synthetic',interval:5});
  if(kind==='dingtalk'){
    f.rows.set('native-created',{id:'native-created',kind,name:'钉钉',enabled:true,config:{client_secret:'native-secret'}});
    f.override('/'+kind+poll,{status:'success',channel_id:'native-created'});
  }else f.override('/'+kind+poll,kind==='weixin'?{status:'success',account_id:'test-user',token:'native-secret'}:kind==='wecom'?{status:'success',bot_id:'test-bot',secret:'native-secret'}:{status:'finished',app_id:'test-app',app_secret:'native-secret',events:[{content:'native-secret'}]});
  const start=await f.act('start',{kind});assert(start.qr.startsWith('data:image/svg+xml;base64,'));assert(!JSON.stringify(start).includes('private-ticket'));
  const response=await f.act('poll',{handle:start.handle});assert.equal(response.status,'success');assert(!JSON.stringify(response).includes('native-secret'));
  const count=f.rows.size;assert.deepEqual(await f.act('poll',{handle:start.handle}),response);assert.equal(f.rows.size,count);
  assert(f.routes.every(r=>r.route.startsWith(f.base)));
  await f.act('cancel',{handle:start.handle});await assert.rejects(f.act('poll',{handle:start.handle}));
});

test('QR retries deduplicate credentials and concurrent polling; scope changes cancel creator without saving',async()=>{
  const f=fixture();let resolve;
  f.override('/feishu/bot-creator/start',{});f.override('/feishu/bot-creator/poll',()=>new Promise(r=>resolve=r));
  const start=await f.act('start',{kind:'feishu'});const a=f.act('poll',{handle:start.handle}),b=f.act('poll',{handle:start.handle});
  await new Promise(r=>setImmediate(r));assert.equal(f.routes.filter(r=>r.route.endsWith('/poll')).length,1);
  f.changeScope();resolve({status:'finished',app_id:'fixture',app_secret:'never-save'});
  await assert.rejects(a);await assert.rejects(b);assert.equal(f.rows.size,0);assert.equal(f.cleanups.length,1);
});

test('re-scanning an existing bot refreshes its credentials instead of duplicating bindings',async()=>{
  const f=fixture();f.rows.set('existing',{id:'existing',kind:'wecom',name:'Existing',enabled:false,config:{bot_id:'bot-fixture',secret:'old',extra:true}});
  f.override('/wecom/qrcode/generate',{scode:'private',auth_url:'https://platform.test/synthetic'});
  f.override('/wecom/qrcode/poll',{status:'success',bot_id:'bot-fixture',secret:'new'});
  const start=await f.act('start',{kind:'wecom'});await f.act('poll',{handle:start.handle});
  assert.equal(f.rows.size,1);assert.equal(f.rows.get('existing').config.secret,'new');assert.equal(f.rows.get('existing').config.extra,true);assert(f.rows.get('existing').enabled);
});

test('canceling a long QR poll does not block another channel configuration',{timeout:1000},async()=>{
  const f=fixture();let resolve;
  f.override('/weixin/qrcode/generate',{qrcode_token:'private',qrcode_url:'https://platform.test/synthetic'});
  f.override('/weixin/qrcode/poll',()=>new Promise(r=>resolve=r));
  const start=await f.act('start',{kind:'weixin'}),poll=f.act('poll',{handle:start.handle});
  await new Promise(r=>setImmediate(r));await f.act('cancel',{handle:start.handle});
  await f.act('save',{kind:'dingtalk',name:'Synthetic',values:{client_id:'fixture',client_secret:'fixture-secret'}});
  resolve({status:'success',account_id:'canceled',token:'must-not-save'});await assert.rejects(poll);
  assert.equal(f.rows.size,1);assert.equal([...f.rows.values()][0].kind,'dingtalk');
});

test('trusted dialogue service derives agent and preserves native channel permission failures',async()=>{
  const state={phase:'ready',account:{phase:'authenticated',accountId:'synthetic',clientId:'synthetic'},connection:{deviceId:'box',gatewayURL:'http://127.0.0.1'}};
  const routes=[];const service=createAIDialogue({client:{snapshot:()=>state,subscribe:()=>()=>{},applicationConnection:async()=>({request:async input=>{
    routes.push(input.path);return {status:403,body:Buffer.from(JSON.stringify({code:'FORBIDDEN',detail:'secret=should-not-escape'}))};
  }})}});
  await assert.rejects(service.action('load'),e=>e.code==='FORBIDDEN');
  await assert.rejects(service.action('channels-list',{scope:'forged',agent_id:'other'}),e=>e.code==='DIALOGUE_CONTEXT_CHANGED');
  assert.deepEqual(routes,['/api/assistant/profile']);service.close();
});
