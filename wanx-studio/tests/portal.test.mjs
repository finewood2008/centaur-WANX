import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {createStudioEntry, projectSummary} from '../integration/host-entry.mjs';

const id='a'.repeat(32), other='b'.repeat(32);
const project=(overrides={})=>({id,appId:'ai.wanx.selfmade.'+id,name:'业务事项台账',originalGoal:'管理业务事项',stage:'discovery',updatedAt:Date.now()/1000,solution:{audience:'我',workflow:'登记和跟进',inputs:'事项',outputs:'进展',acceptance:['可以登记'],dependencies:[]},decisions:{},artifacts:[],...overrides});

test('pending summaries respect the current solution, unresolved gaps, and installed version',()=>{
  assert.equal(projectSummary(project()).label,'方案待确认');
  assert.equal(projectSummary(project({solution:{...project().solution,dependencies:[{id:'gap'}]}})).attention,'');
  assert.equal(projectSummary(project({stage:'waiting'})).action,'回答问题');
  assert.equal(projectSummary(project({stage:'preview'})).action,'打开产品');
  const summary=projectSummary(project({stage:'failed',installed:{version:'0.1.0'},artifacts:[{version:'0.1.1'}]}));
  assert.equal(summary.installedVersion,'0.1.0');assert.equal(summary.latestVersion,'0.1.1');
  assert.equal(summary.goal,'管理业务事项');assert.ok(summary.attention);
  assert.equal(summary.solution,undefined);assert.equal(summary.messages,undefined);
});

function entryHarness(){
  let live=true;const requests=[],opened=[],operations=new Map();
  const context=()=>{if(!live)throw new Error('SESSION_CHANGED');return{accountId:'user',boxId:'box',user:{id:1}}};
  const connection={context,request:async input=>{
    requests.push(input);let value;
    if(input.path.endsWith('/preflight'))value={available:true};
    else if(input.path.endsWith('/context'))value={modelAvailable:true};
    else if(input.method==='POST'){const body=JSON.parse(input.body);if(!operations.has(body.operationId))operations.set(body.operationId,project());value=operations.get(body.operationId)}
    else if(input.path.startsWith('/api/app-studio/projects?'))value={projects:[project({messages:[{text:'private'}]})]};
    else {if(!input.path.endsWith('/'+id))return{status:404,body:'{}'};value=project()}
    return{status:200,body:Buffer.from(JSON.stringify(value))};
  }};
  const entry=createStudioEntry({createConnection:async()=>connection,applications:{launch:async id=>opened.push(id),activate:()=>{}}});
  return{entry,requests,opened,connection,operations,invalidate:()=>{live=false}};
}

test('overview reads existing state without heartbeat or model calls; create retries reuse the same project',async()=>{
  const h=entryHarness();const overview=await h.entry.overview();assert.equal(overview.projects.length,1);
  assert.ok(h.requests.every(r=>r.method==='GET'));assert.ok(h.requests.every(r=>!r.path.includes('/chat')));
  const input={goal:'创建客户台账',operationId:randomUUID()};
  const first=await h.entry.create(input),second=await h.entry.create(input);assert.deepEqual(first,second);assert.equal(h.operations.size,1);
  assert.deepEqual(h.entry.navigation(h.connection).projectId,id);assert.equal(h.entry.navigation(h.connection).projectId,null);
  assert.deepEqual(h.opened,['ai.wanx.studio','ai.wanx.studio']);
});

test('project navigation validates owner access and cannot cross box or expired sessions',async()=>{
  const h=entryHarness();await assert.rejects(()=>h.entry.open({projectId:other}),/STUDIO_UNAVAILABLE/);assert.equal(h.opened.length,0);
  await h.entry.open({projectId:id});
  assert.equal(h.entry.navigation({context:()=>({accountId:'another',boxId:'box',user:{id:1}})}).projectId,null);
  h.invalidate();assert.equal(h.entry.navigation({context:()=>({accountId:'user',boxId:'box',user:{id:1}})}).projectId,null);
  await assert.rejects(()=>h.entry.open({projectId:'../../secret'}),/STUDIO_PROJECT_INVALID/);
});

const homeSource=await readFile(new URL('../integration/studio-home.js',import.meta.url),'utf8');
function homeHarness(request,createStudioIntake){
  const window={createStudioIntake};vm.runInNewContext(homeSource,{window,Date,crypto:globalThis.crypto,setInterval:()=>1,clearInterval(){}});
  const home=window.createStudioHome({request,changed(){}});
  const state={account:{phase:'authenticated',accountId:'user'},canLaunchApplications:true,activeDeviceId:'box',connection:{deviceId:'box'}};
  return{home,state,flush:()=>new Promise(r=>setImmediate(r))};
}

test('development home shows authentic actions, escapes project input, and clears on account switch',async()=>{
  const calls=[];const h=homeHarness(async(name,input)=>{calls.push([name,input]);return{protocolVersion:2,projects:[projectSummary(project({name:'<img src=x>',stage:'waiting'}))],modelAvailable:true}});
  h.home.sync(h.state,true);await h.flush();
  let html=h.home.render(h.state);assert.match(html,/我的项目/);assert.match(html,/回答问题/);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img src=x>/);
  await h.home.action('studio-open',{projectId:id});assert.equal(calls.at(-1)[0],'studio.open');assert.equal(calls.at(-1)[1].projectId,id);
  h.home.sync({...h.state,canLaunchApplications:false},true);html=h.home.render(h.state);assert.doesNotMatch(html,/&lt;img src=x&gt;/);assert.match(html,/连接后恢复开发项目/);
});

test('late overview cannot populate a new account; creating a workspace never posts a scenario',async()=>{
  let resolve;const h=homeHarness(async()=>new Promise(r=>{resolve=r}));
  h.home.sync(h.state,true);await h.flush();h.home.sync({...h.state,canLaunchApplications:false},false);
  resolve({protocolVersion:2,projects:[projectSummary(project())],modelAvailable:true});await h.flush();assert.doesNotMatch(h.home.render(h.state),/业务事项台账/);
  const calls=[];const retry=homeHarness(async(name,input)=>{calls.push([name,input]);return{protocolVersion:2,projects:[],modelAvailable:true}});
  retry.home.sync(retry.state,true);await retry.flush();await retry.home.create();
  assert.equal(calls.at(-1)[0],'studio.workspace');assert.deepEqual(Object.keys(calls.at(-1)[1]),['protocolVersion']);assert.doesNotMatch(retry.home.render(retry.state),/<textarea/);
});

test('workspace launch performs read-only checks and rejects missing model/version before launch',async()=>{
 const h=entryHarness();await h.entry.workspace({protocolVersion:2});assert.equal(h.operations.size,0);assert.equal(h.entry.navigation(h.connection).projectId,null);assert.equal(h.requests.some(r=>r.method==='POST'),false);
 await assert.rejects(()=>h.entry.workspace({protocolVersion:1}),/HOST_BRIDGE_UPDATE_REQUIRED/);
});

test('daily client starts task preparation before Builder and resumes an unfinished intake',async()=>{
 const opened=[],calls=[];
 const h=homeHarness(async(name,input)=>{calls.push([name,input]);return{protocolVersion:2,projects:[{...projectSummary(project()),preparationPhase:'intake'}],modelAvailable:true}},()=>({sync(){},open:async id=>opened.push(id)}));
 h.home.sync(h.state,true);await h.flush();await h.home.create();
 assert.deepEqual(opened,[undefined]);assert.equal(calls.some(([name])=>name==='studio.workspace'),false);
 await h.home.action('studio-open',{projectId:id});assert.deepEqual(opened,[undefined,id]);
 assert.ok(calls.every(([name])=>name==='studio.overview'));
});

test('background pagination permits fixed Xingtu offsets and rejects arbitrary destinations',async()=>{
 const h=entryHarness();const original=h.connection.request;h.connection.request=async input=>input.path.startsWith('/api/app-studio/context/sources?')?{status:200,body:JSON.stringify({items:[],path:input.path})}:original(input);
 const page=await h.entry.contextSources({kind:'xingtu',parent:'offset:200'});assert.match(page.path,/parent=offset%3A200$/);
 await assert.rejects(()=>h.entry.contextSources({kind:'xingtu',parent:'https://example.test'}),/CONTEXT_REFERENCE_INVALID/);
 await assert.rejects(()=>h.entry.contextSources({kind:'space',parent:'offset:200'}),/CONTEXT_REFERENCE_INVALID/);
});

test('client exports the adopted version while a newer candidate is being built',()=>{
 const h='a'.repeat(64),newHash='b'.repeat(64);
 const s=projectSummary(project({stage:'building',versioning:{adoptedHash:h,iteration:{state:'building'}},tasks:[{id:'new',state:'running'}],artifacts:[{hash:h,version:'0.1.0',taskId:'old'},{hash:newHash,version:'0.1.1',taskId:'new'}]}));
 assert.equal(s.adoptedArtifactHash,h);assert.equal(s.adoptedTaskId,'old');assert.equal(s.adoptedVersion,'0.1.0');assert.equal(s.latestVersion,'0.1.1');
 assert.equal(s.label,'开发中');assert.equal(s.iterationState,'building');
});
