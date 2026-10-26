import{test}from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import vm from'node:vm';
import{createTeamService}from'../integration/team-client/service.mjs';
const read=name=>readFile(new URL('../integration/'+name,import.meta.url),'utf8');
const homeSource=await read('studio-home.js'),teamSource=await read('team-client/view.js'),constructionSource=await read('construction.js');
const tick=()=>new Promise(r=>setImmediate(r));
const state={account:{phase:'authenticated',accountId:'admin',clientId:'desktop'},activeDeviceId:'box',activeDeviceName:'测试盒',canLaunchApplications:true};
const id='a'.repeat(32),other='b'.repeat(32),hash='1'.repeat(64),nextHash='2'.repeat(64),appId='ai.wanx.selfmade.'+id;
const summary=(overrides={})=>({id,name:'会议助手',goal:'整理真实会议',stage:'preview',label:'有新版本可试用',action:'打开产品',updatedAt:100,adoptedVersion:'0.1.0',adoptedArtifactHash:hash,latestVersion:'0.1.1',installedVersion:'0.0.9',...overrides});
function homeHarness(){const calls=[],window={};let rows=[summary(),summary({id:other,name:'<script>项目',updatedAt:200})];vm.runInNewContext(homeSource,{window,Date,crypto:globalThis.crypto});const home=window.createStudioHome({changed(){},request:async(n,p)=>{calls.push([n,p]);return{protocolVersion:2,projects:rows,modelAvailable:true}}});return{home,calls,rows:r=>rows=r}}
test('project selection is read only; real versions stay distinct and valid selection survives refresh',async()=>{
 const h=homeHarness();h.home.sync(state,true);await tick();let html=h.home.render(state);assert.match(html,/kaiwu-workspace/);assert.match(html,/aria-label="项目详情"[\s\S]*&lt;script&gt;项目/);assert.doesNotMatch(html,/<script>项目/);
 const before=h.calls.length;await h.home.action('studio-select',{projectId:id});assert.equal(h.calls.length,before);html=h.home.render(state);assert.match(html,/aria-label="项目详情"[\s\S]*会议助手/);assert.match(html,/最新成果[\s\S]*v0.1.1/);assert.match(html,/当前采用[\s\S]*v0.1.0/);assert.match(html,/本机安装[\s\S]*v0.0.9/);
 await h.home.refresh();assert.match(h.home.render(state),/aria-label="项目详情"[\s\S]*会议助手/);h.home.search('会议');assert.match(h.home.render(state),/会议助手/);
 h.home.sync({...state,canLaunchApplications:false},true);assert.doesNotMatch(h.home.render(state),/整理真实会议/);
});
test('deleted filtering never launches or deletes a project; restore retains its original project ID',async()=>{
 const h=homeHarness();h.rows([summary({deletedAt:1})]);h.home.sync(state,true);await tick();h.home.render(state);await h.home.action('studio-filter',{filter:'archived'});assert.match(h.home.render(state),/恢复项目/);assert.equal(h.calls.length,1);
 await h.home.action('studio-restore',{projectId:id});assert.equal(h.calls.find(c=>c[0]==='studio.metadata')[1].projectId,id);
});
function teamHarness(role='admin'){
 const calls=[],window={},document={querySelectorAll:()=>[]};const p={id,name:'会议助手',updatedAt:100,versioning:{adoptedHash:nextHash},artifacts:[{hash,version:'0.1.0'},{hash:nextHash,version:'0.1.1'}]};
 const request=async(name,input)=>{calls.push([name,input]);return name==='team.identity'?{id:1,role}:name==='team.catalog'?[{id,name:p.name,appId,enabled:true,audience:'selected',installed:{artifactHash:hash}}]:name==='team.projects'?[p]:[]};
 vm.runInNewContext(teamSource,{window,document,queueMicrotask,setInterval:()=>1,clearInterval(){},Date,Map});const view=window.createTeamView({request,changed(){}});return{view,calls,p};
}
test('publishing shows the actual published hash, not adopted or local-install version, and company catalog has no manage entry',async()=>{
 const h=teamHarness();h.view.sync(state);await tick();await h.view.action('publishing',{});let html=h.view.publishing();assert.match(html,/上架管理|应用上架/);assert.match(html,/当前发布版本[\s\S]*v0.1.0/);assert.match(html,/已采用版本[\s\S]*v0.1.1/);assert.match(html,/更新上架版本/);assert.doesNotMatch(h.view.catalog(),/管理上架/);assert.doesNotMatch(h.view.page(),/已验收的构建成果|<h3>内部应用/);
 await h.view.action('publication-filter',{filter:'published'});assert.match(h.view.publishing(),/会议助手/);h.view.sync({...state,activeDeviceId:'another'});assert.doesNotMatch(h.view.publishing(),/会议助手/);
});
test('ordinary team accounts never load projects, members or publishing controls',async()=>{
 const h=teamHarness('user');h.view.sync(state);await tick();await h.view.action('publishing',{});assert.doesNotMatch(h.view.publishing(),/data-team-action="publish"/);assert.equal(h.calls.some(([n])=>['team.projects','team.members'].includes(n)),false);
 const window={};vm.runInNewContext(constructionSource,{window});const c=window.createConstruction({request:async()=>({items:[]}),changed(){}});c.showSection('publishing');const html=c.render({state,home:{preparing:()=>false,render:()=>'<p>projects</p>'},canPublish:false});assert.doesNotMatch(html,/上架管理/);assert.match(html,/projects/);
});
function serviceHarness(){let rejectPayload=false,role='admin',creator=1,enabled=true,audience='selected',artifact=hash;const calls=[];const members=[{id:1},{id:2},{id:3},{id:4,disabled:true}];
 const request=async req=>{calls.push({...req,body:req.body?JSON.parse(req.body):undefined});let result;
  if(req.path==='/api/auth/me')result={id:1,role,application_id:'wanx'};
  else if(req.path==='/api/app-studio/context')result={features:{teamPublishing:1}};
  else if(req.path==='/api/users')result=members;
  else if(rejectPayload&&req.path.includes('/install/'))return{status:409,body:Buffer.from(JSON.stringify({code:'USER_ADOPTION_REQUIRED'}))};
  else if([hash,nextHash].some(h=>req.path===`/api/app-studio/projects/${id}/install/${h}`))result={applicationId:appId,artifactHash:req.path.split('/').at(-1),version:req.path.endsWith(nextHash)?'0.1.1':'0.1.0',name:'会议助手'};
  else if(req.path.endsWith('/installed'))result={};
  else if(req.path.endsWith('/deployment')){if(req.body){const b=JSON.parse(req.body);enabled=b.enabled;audience=b.configuration.studio_team.audience;artifact=b.configuration.studio_team.artifactHash}result={enabled,resource_bindings:{storage:'keep'},configuration:{other:'keep',studio_team:{projectId:id,artifactHash:artifact,audience}}}}
  else if(req.path.endsWith('/access'))result=req.method==='PUT'?JSON.parse(req.body):[{user_id:1,enabled:true},{user_id:2,enabled:false},{user_id:3,enabled:true}];
  else if(req.path==='/api/admin/applications/'+appId)result={created_by:creator,name:'会议助手'};
  else throw Error('Unexpected route '+req.path);
  return {status:200,body:Buffer.from(JSON.stringify(result))};
 };
 const service=createTeamService({client:{applicationConnection:async()=>({context:()=>({user:{id:1}}),request})},applications:{},assets:''});return{service,calls,rejectPayload:()=>{rejectPayload=true},role:v=>role=v,creator:v=>creator=v,artifact:()=>artifact};
}
test('audience-only change reuses existing routes, preserves published code and enforces publisher and role',async()=>{
 const h=serviceHarness();const d=await h.service.action('publication',{applicationId:appId});assert.deepEqual(d.members,[1,3]);
 await h.service.action('publication-audience',{applicationId:appId,artifactHash:hash,audience:'all',members:[]});assert.equal(h.artifact(),hash);
 const grants=h.calls.filter(r=>r.path.endsWith('/access')&&r.method==='PUT');assert.deepEqual(grants.map(r=>[r.body.user_id,r.body.enabled]),[[1,true],[2,true],[3,true]]);
 const deployment=h.calls.filter(r=>r.path.endsWith('/deployment')&&r.method==='PUT').at(-1).body;assert.equal(deployment.enabled,true);assert.equal(deployment.configuration.other,'keep');assert.equal(deployment.resource_bindings.storage,'keep');assert.equal(h.calls.find(r=>r.path.endsWith('/installed')).body.artifactHash,hash);assert(h.calls.filter(r=>r.path.includes('/install/')).every(r=>r.path.endsWith(hash)));
 await assert.rejects(h.service.action('publication-audience',{applicationId:appId,artifactHash:nextHash,audience:'all'}),{code:'TEAM_PUBLICATION_CHANGED'});
 h.creator(9);await assert.rejects(h.service.action('publication-audience',{applicationId:appId,artifactHash:hash,audience:'all'}),{code:'TEAM_PUBLISHER_MISMATCH'});
 h.role('user');await assert.rejects(h.service.action('publication',{applicationId:appId}),{code:'TEAM_ADMIN_REQUIRED'});
});
test('publication update uses only the explicitly adopted artifact and selected active members',async()=>{
 const h=serviceHarness();await h.service.action('publish',{projectId:id,artifactHash:nextHash,audience:'selected',members:[2]});assert.equal(h.artifact(),nextHash);
 const grants=h.calls.filter(r=>r.path.endsWith('/access')&&r.method==='PUT');assert.deepEqual(grants.map(r=>[r.body.user_id,r.body.enabled]),[[1,true],[2,true],[3,false]]);
 assert.equal(h.calls.filter(r=>r.path.endsWith('/installed')).length,1);
});


test('permission loss clears cached project summaries rather than leaving an editable stale project',async()=>{
 let denied=false;const window={};vm.runInNewContext(homeSource,{window,Date,crypto:globalThis.crypto});
 const home=window.createStudioHome({changed(){},request:async()=>{if(denied)throw Error('STUDIO_ADMIN_REQUIRED');return{protocolVersion:2,projects:[summary()],modelAvailable:true}}});
 home.sync(state,true);await tick();assert.match(home.render(state),/整理真实会议/);denied=true;await home.refresh();assert.doesNotMatch(home.render(state),/整理真实会议/);assert.match(home.render(state),/没有开物管理权限/);
});


test('an older publication cannot change audience by silently publishing the newly adopted artifact',async()=>{
 const h=serviceHarness();h.rejectPayload();
 await assert.rejects(h.service.action('publication-audience',{applicationId:appId,artifactHash:hash,audience:'selected',members:[2]}),{code:'TEAM_SCOPE_REQUIRES_CURRENT'});
 assert.equal(h.calls.some(r=>r.method==='PUT'||r.method==='POST'),false);assert.equal(h.artifact(),hash);
});
