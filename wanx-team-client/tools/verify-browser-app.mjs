// Live acceptance: synthetic page, isolated server/profile, existing provider only.
// Never point this script at a user's active browser server.
import {createDashboardGateway} from '../octop/gateway.mjs';
import {createApplicationSession} from '../app-host/session.mjs';
import {createHostClient} from '../host-sdk/index.cjs';
import {pathToFileURL} from 'node:url';
const {WANX_BROWSER_ACCEPTANCE_URL:targetURL,WANX_BROWSER_ACCEPTANCE_TOKEN:token,WANX_BROWSER_APP_SOURCE:appSource}=process.env;
if(process.env.WANX_BROWSER_ACCEPTANCE_ISOLATED!=='1'||!targetURL||!token||!appSource||!['localhost','127.0.0.1'].includes(new URL(targetURL).hostname))throw Error('ISOLATED_ACCEPTANCE_REQUIRED');
const {BrowserService}=await import(pathToFileURL(appSource+'/shell/service.mjs'));
const gateway=await createDashboardGateway({targetURL,session:{getToken:()=>token,close(){}}});
const identity=await gateway.request({path:'/api/auth/me',method:'GET'});
if(identity.status!==200)throw Error('ACCEPTANCE_AUTH_FAILED');
const user=JSON.parse(identity.body.toString());
const appSession=await createApplicationSession({hostApplicationId:'wanx',applicationId:'centaurai.wanx.ai-browser',installPath:appSource,createConnection:async()=>({context:()=>({boxId:'isolated-acceptance',user,connection:'ready'}),request:i=>gateway.request(i),openStream:i=>gateway.openWebSocket(i)})});
const host=createHostClient({baseURL:appSession.environment.WANX_HOST_BASE_URL,token:appSession.environment.WANX_HOST_TOKEN});
async function closeTestHost(){host.close();await appSession.close();await gateway.close();}
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';
const data=await mkdtemp(path.join(os.tmpdir(),'wanx-learning-live-'));
const events=[];let done=false,chatError=false,slowStarted=false,releaseSlow,ownedTab,originalTab,saved;
const server=http.createServer(async(req,res)=>{
 if(req.url==='/event'){let b='';for await(const x of req)b+=x;events.push(JSON.parse(b));res.end('ok');return;}
 if(req.url==='/slow'){slowStarted=true;releaseSlow=()=>{if(!res.writableEnded)res.end(`<h1>接管验证</h1><button onclick="fetch('/event',{method:'POST',body:JSON.stringify({forbiddenClick:true})})">测试按钮</button>`);};return;}
 res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><title>技能学习合成验收页</title><body style="font:20px sans-serif"><h1 style="position:absolute;left:40px;top:15px">技能学习验收</h1><label for="query" style="position:absolute;left:40px;top:85px">搜索内容</label><input id="query" name="query" style="position:absolute;left:40px;top:120px;width:400px;height:40px;font-size:20px" oninput="fetch('/event',{method:'POST',body:JSON.stringify({input:this.value})})"><button style="position:absolute;left:40px;top:200px;width:120px;height:40px" onclick="document.getElementById('result').textContent='查询结果：'+document.getElementById('query').value;fetch('/event',{method:'POST',body:JSON.stringify({submitted:document.getElementById('query').value})})">查询</button><p id="result" style="position:absolute;left:40px;top:260px"></p></body>`);
});server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/`;
const service=new BrowserService({host,dataDirectory:data,emit:e=>{if(e.type==='chat'){if(e.frame.type==='done')done=true;if(e.frame.type==='error'||e.frame.type==='hitl_required'){chatError=true;done=true;}}}});
const until=async(fn,timeout=30000)=>{const end=Date.now()+timeout;while(!fn()){if(Date.now()>end)throw Error('ACCEPTANCE_TIMEOUT');await new Promise(r=>setTimeout(r,150));}};
const click=(x,y)=>{service.input({type:'mousedown',x,y,button:'left',buttons:1});service.input({type:'mouseup',x,y,button:'left',buttons:0});};
const report={date:new Date().toISOString(),target:'本机万象',source:'current browser application via both WANX gateways and isolated WANX backend',synthetic:true,newBudgetConfigured:false};
try{
 await service.init();await until(()=>service.phase==='ready'&&service.expertStatus==='ready');
 report.expertAutoSelected=Boolean(service.agentId)&&service.expertStatus==='ready';report.learningAvailable=service.learning.value.available;
 if(!report.expertAutoSelected||!report.learningAvailable)throw Error('EXPERT_OR_LEARNING_UNAVAILABLE');
 originalTab=service.tabs.find(t=>t.active)?.id;const oldIds=new Set(service.tabs.map(t=>t.id));service.input({type:'tab_new'});await until(()=>service.tabs.some(t=>t.active&&!oldIds.has(t.id)));ownedTab=service.tabs.find(t=>t.active&&!oldIds.has(t.id)).id;
 service.input({type:'navigate',url});await until(()=>service.tabs.some(t=>t.active&&t.url===url));await new Promise(r=>setTimeout(r,500));
 await service.learning.start({name:'合成验收技能-'+Date.now(),goal:'填写搜索内容并点击查询，确认页面显示查询结果。'});
 click(140,140);service.input({type:'type',text:'示范查询'});await until(()=>events.some(e=>e.input==='示范查询'));click(90,220);await until(()=>events.some(e=>e.submitted==='示范查询'));
 await service.learning.finish();const draft=service.learning.value.draft;report.recordedSteps=draft.steps.length;report.parameters=draft.parameters.length;
 if(draft.steps.length<3||draft.parameters.length<1)throw Error('LEARNING_DRAFT_INCOMPLETE');
 saved=await service.learning.save({...draft,expected:'页面显示查询结果及本次搜索内容'});report.skillSaved=true;
 const values=Object.fromEntries(saved.parameters.filter(p=>!p.secret).map(p=>[p.key,'技能复用通过']));
 done=false;await service.learning.use({slug:saved.slug,values,extra:'只使用 browser_use，使用 DOM 定位，不要截图。'});await until(()=>done,120000);await until(()=>service.owner==='user');
 report.aiReusedSkill=events.some(e=>e.submitted==='技能复用通过')&&!chatError;report.returnedToUser=service.owner==='user';console.log(JSON.stringify({stage:'skill-reuse',passed:report.aiReusedSkill,steps:report.recordedSteps,parameters:report.parameters}));
 if(!report.aiReusedSkill)throw Error('AI_SKILL_REUSE_FAILED');
 done=false;await service.send(`只使用 browser_use，导航到 ${url}slow，等待加载后点击页面的测试按钮。不要截图。`);await until(()=>slowStarted,90000);
 let settled=false;const taking=service.takeover().then(()=>settled=true);report.pendingVisible=service.owner==='pending';
 try{service.input({type:'type',text:'blocked'});report.manualBlocked=false;}catch{report.manualBlocked=true;}
 await new Promise(r=>setTimeout(r,1200));report.waitedForInflight=!settled;releaseSlow();await taking;
 service.input({type:'navigate',url});await until(()=>service.tabs.some(t=>t.active&&t.url===url));await new Promise(r=>setTimeout(r,400));click(140,140);service.input({type:'type',text:'人工接管通过'});await until(()=>events.some(e=>e.input==='人工接管通过'));
 report.manualInputAfterTakeover=true;await new Promise(r=>setTimeout(r,8000));report.noLateAIClick=!events.some(e=>e.forbiddenClick);
 report.passed=report.aiReusedSkill&&report.pendingVisible&&report.manualBlocked&&report.waitedForInflight&&report.manualInputAfterTakeover&&report.noLateAIClick;
}catch(e){report.error=e.code||e.message;console.log(JSON.stringify({failed:report.error}));}
finally{
 releaseSlow?.();await service.takeover().catch(()=>{});
 if(service.learning.value.phase!=='idle')await service.learning.discard().catch(()=>{});
 if(saved){await service.learning.remove(saved.slug);report.syntheticSkillRemoved=!service.learning.value.skills.some(s=>s.slug===saved.slug);report.passed=report.passed&&report.syntheticSkillRemoved;}
 if(ownedTab&&service.owner==='user')service.input({type:'tab_close',tab_id:ownedTab});
 if(originalTab&&service.owner==='user')service.input({type:'tab_switch',tab_id:originalTab});
 await new Promise(r=>setTimeout(r,300));await service.close();await closeTestHost();server.closeAllConnections();server.close();
 await writeFile(process.env.WANX_BROWSER_ACCEPTANCE_REPORT||path.join(data,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await rm(data,{recursive:true,force:true});process.exitCode=report.passed?0:1;
}
