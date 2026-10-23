import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const source=(await build({entryPoints:[new URL('../integration/team-client/data-view.js',import.meta.url).pathname],bundle:true,platform:'browser',format:'iife',write:false,logLevel:'silent'})).outputFiles[0].text;
function make(request,timers={},document={}){const window={},context=vm.createContext({window,setInterval:()=>0,clearInterval,setTimeout:timers.setTimeout||(()=>0),clearTimeout:timers.clearTimeout||(()=>{}),document,FormData:class{},crypto:globalThis.crypto});vm.runInContext(source,context);return window.createTeamDataView({request,changed:()=>{}})}
const state={canLaunchApplications:true,account:{accountId:'a'},activeDeviceId:'box'};
test('data page refuses user role and clears warehouses after scope change',async()=>{
 const view=make(async()=>({items:[{id:'warehouse',name:'旧团队知识',state:'active'}]}));
 view.sync(state,true);await view.refresh();assert.match(view.render(),/旧团队知识/);
 view.sync(state,false);assert.doesNotMatch(view.render(),/旧团队知识/);assert.match(view.render(),/管理员/);
});
test('late warehouse responses cannot fill another account',async()=>{
 let resolve;const view=make(()=>new Promise(r=>resolve=r));view.sync(state,true);const pending=view.refresh();view.sync({...state,account:{accountId:'b'}},true);resolve({items:[{id:'a',name:'不应泄漏的旧仓'}]});await pending;assert.doesNotMatch(view.render(),/不应泄漏/);
});
test('server failure stays visible and does not create a demonstration warehouse',async()=>{
 const view=make(async()=>{throw Error('SEMANTICA_NOT_CONFIGURED')});view.sync(state,true);await view.refresh();assert.match(view.render(),/尚未配置/);assert.doesNotMatch(view.render(),/客户知识仓/);
});
test('refresh replaces the previous Starlink installation action with the current service error',async()=>{
 for(const openCode of ['TEAM_STARLINK_NOT_INSTALLED','TEAM_STARLINK_UPGRADE_REQUIRED']){
  const view=make(async name=>{const code=name==='data.open-starlink'?openCode:'SEMANTICA_SERVICE_AUTH_FAILED';throw Object.assign(Error(code),{code})});
  view.sync(state,true);await view.action('open',{view:'warehouses'});
  assert.match(view.render(),/data-data-action="install-starlink"/);
  await view.refresh();const html=view.render();
  assert.doesNotMatch(html,/data-data-action="install-starlink"/);
  assert.match(html,/接入鉴权失败/);assert.match(html,/服务凭据及团队接入版本/);
  assert.match(html,/data-data-action="refresh"[^>]*>重试/);
 }
});
test('team service failures explain the relevant access or compatibility problem',async()=>{
 for(const [code,message] of [
  ['SEMANTICA_SERVICE_AUTH_FAILED',/接入鉴权失败/],
  ['SEMANTICA_RESOURCE_FORBIDDEN',/拒绝访问当前团队数据/],
  ['SEMANTICA_RESOURCE_NOT_FOUND',/未找到所请求的资源/],
  ['SEMANTICA_INVALID_REQUEST',/未接受当前请求/],
 ]){
  const view=make(async()=>{throw Object.assign(Error(code),{code})});view.sync(state,true);await view.refresh();
  assert.match(view.render(),message);assert.doesNotMatch(view.render(),/操作未完成|data-data-action="install-starlink"/);
 }
});
test('invalid IPC response is shown as a failure without breaking the shell',async()=>{
 const view=make(async()=>({ok:true,value:{items:[]}}));view.sync(state,true);await view.refresh();assert.doesNotThrow(()=>view.render());assert.match(view.render(),/操作未完成/);
});
const teamRows=[{id:'w1',name:'产品知识',entity_count:2},{id:'w2',name:'交付流程',entity_count:1}];
const realGraph={nodes:[{id:'product',canonical_name:'真实产品',entity_type:'PRODUCT'},{id:'team',canonical_name:'真实团队',entity_type:'ORG'}],edges:[{id:'fact',subject_entity_id:'team',object_entity_id:'product',relation_type:'USES',evidence:[{document_id:'doc',excerpt:'真实材料中的证据',locator_json:{page:2}}]}]};
test('overview loads the selected warehouse graph above warehouse statistics and opens the same Starlink target',async()=>{
 const calls=[];const view=make(async(name,input)=>{calls.push([name,input]);return name==='data.warehouses'?{items:teamRows}:name==='data.graph'?realGraph:{}});
 view.sync(state,true);await view.refresh();const html=view.render();
 assert(html.indexOf('核心知识图谱')<html.indexOf('data-summary'));assert.match(html,/真实产品/);assert.match(html,/node-symbol/);assert.match(html,/data-edge/);assert.equal(calls[1][1].warehouseId,'w1');
 await view.action('node',{id:'team'});assert.match(view.render(),/真实材料中的证据/);assert.match(view.render(),/data-warehouse-id="w1"/);
 await view.action('open',{warehouseId:'w1',view:'graph'});assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['data.open-starlink',{warehouseId:'w1',view:'graph'}]));
});
test('switching preview warehouses drops late graph results and keeps the new scope',async()=>{
 let resolve,calls=0;const view=make(async(name,input)=>{if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph'){calls++;if(calls===1)return new Promise(r=>resolve=r);assert.equal(input.warehouseId,'w2');return {nodes:[{id:'new',canonical_name:'新仓实体'}],edges:[]}}});
 view.sync(state,true);const old=view.refresh();await new Promise(r=>setImmediate(r));await view.action('graph-warehouse',{id:'w2'});resolve(realGraph);await old;
 assert.match(view.render(),/新仓实体/);assert.doesNotMatch(view.render(),/真实产品/);
});
test('graph failure preserves the warehouse list and does not substitute sample nodes',async()=>{
 const view=make(async name=>{if(name==='data.warehouses')return {items:teamRows};throw Error('SEMANTICA_SERVICE_UNAVAILABLE')});
 view.sync(state,true);await view.refresh();const html=view.render();assert.match(html,/知识图谱/);assert.match(html,/暂时不可用/);assert.match(html,/data-warehouse-choice/);assert.doesNotMatch(html,/data-core-node/);
 view.sync({...state,account:{accountId:'other'}},true);assert.doesNotMatch(view.render(),/产品知识/);
});
test('imported materials with no graph lead to processing tasks instead of suggesting another import',async()=>{
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'已导入仓',document_count:19}]}:name==='data.jobs'?{items:[{id:'p',kind:'knowledge_publish',status:'failed',stage:'failed'}]}:{nodes:[],edges:[]});
 view.sync(state,true);await view.refresh();assert.match(view.render(),/已导入 19 份材料/);assert.match(view.render(),/查看处理任务/);
 await view.action('select',{id:'w',tab:'tasks'});assert.match(view.render(),/图谱写入/);assert.match(view.render(),/无需再次调用抽取模型/);
});
test('batch publication retry uses only failed publication jobs and stops on account change',async()=>{
 const requests=[],rows=[{id:'publish-a',kind:'knowledge_publish',status:'failed'},{id:'extract-old',kind:'knowledge_extract',status:'failed',error_code:'STALE_EXTRACTION_GENERATION'},{id:'publish-b',kind:'knowledge_publish',status:'failed'},{id:'published',kind:'knowledge_publish',status:'succeeded'},{id:'scan',kind:'sensitive_scan',status:'failed'}];
 let view;view=make(async(name,input)=>{
  if(name==='data.warehouses')return {items:[{id:'w',name:'真实团队仓'}]};
  if(name==='data.jobs')return {items:rows};
  if(name==='data.retry-job'){requests.push([name,input]);view.sync({...state,account:{accountId:'other'}},true);return {}}return {};
 });
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});assert.doesNotMatch(view.render(),/data-id="extract-old"/);
 await view.action('retry-publications');assert.equal(requests.length,1);assert.equal(requests[0][1].warehouseId,'w');assert.equal(requests[0][1].id,'publish-a');assert.doesNotMatch(view.render(),/真实团队仓/);
});
test('batch publication retry submits each failed publication once without rerunning extraction',async()=>{
 const calls=[];let retried=false;
 const view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:[{id:'w',name:'仓'}]};if(name==='data.jobs')return {items:retried?[]:[{id:'p1',kind:'knowledge_publish',status:'failed'},{id:'p2',kind:'knowledge_publish',status:'failed'},{id:'extract',kind:'knowledge_extract',status:'failed'}]};if(name==='data.retry-job'&&input.id==='p2')retried=true;return {}});
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});await view.action('retry-publications');
 assert.deepEqual(calls.filter(([n])=>n==='data.retry-job').map(([,v])=>v.id),['p1','p2']);assert.equal(calls.filter(([n])=>n.includes('reprocess')).length,0);
});
test('active processing refreshes progress and account reset clears the scheduled read',async()=>{
 let scheduled,cleared;const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'处理仓',active_jobs:1}]}:{nodes:[],edges:[]},{setTimeout:fn=>(scheduled=fn,42),clearTimeout:id=>{cleared=id}});
 view.sync(state,true);await view.refresh();assert.equal(typeof scheduled,'function');view.sync(state,false);assert.equal(cleared,42);await scheduled();assert.match(view.render(),/仅管理员/);
});
test('current-model recovery targets only the latest failed extraction for each material',async()=>{
 const rows=[{id:'old',document_id:'d1',kind:'knowledge_extract',created_at:'2026-10-22T10:00:00Z',status:'failed'},{id:'done',document_id:'d1',kind:'knowledge_extract',created_at:'2026-10-22T11:00:00Z',status:'succeeded'},{id:'todo',document_id:'d2',kind:'knowledge_extract',created_at:'2026-10-22T11:30:00Z',status:'failed'},{id:'stale',document_id:'d3',kind:'knowledge_extract',created_at:'2026-10-22T11:30:00Z',status:'failed',error_code:'STALE_EXTRACTION_GENERATION'}];
 const view=make(async name=>name==='data.warehouses'?{items:[{id:'w',name:'仓'}]}:name==='data.jobs'?{items:rows}:{});
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});assert.match(view.render(),/用当前模型补处理（1）/);
});
test('recovery confirmation displays the effective server model and submits its exact signature and document version only after confirmation',async()=>{
 const calls=[],form={},submit={},dialog={dataset:{},showModal(){},close(){},querySelectorAll:()=>[],querySelector:s=>s==='form'?form:s==='[type=submit]'?submit:{}};
 const document={createElement:()=>dialog,body:{append(){}},querySelectorAll:()=>[]};
 const view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:[{id:'w',name:'仓'}]};if(name==='data.jobs')return {items:[{id:'j',document_id:'d',kind:'knowledge_extract',status:'failed'}]};if(name==='data.processing')return {effective:{signature:'a'.repeat(64),extraction:{name:'已确认的在线模型',location:'external'}}};if(name==='data.documents')return {items:[{id:'d',original_name:'真实材料',status:'ready',active_version_id:'v7'},{id:'unrelated',status:'ready',active_version_id:'v1'}]};return {}}, {}, document);
 view.sync(state,true);await view.refresh();await view.action('select',{id:'w',tab:'tasks'});await view.action('reprocess-failed');assert.match(dialog.innerHTML,/已确认的在线模型/);assert.match(dialog.innerHTML,/正文片段将发送/);assert(!calls.some(([n])=>n==='data.reprocess-models'));
 await form.onsubmit({preventDefault(){},target:{}});const input=calls.find(([n])=>n==='data.reprocess-models')[1];assert.equal(input.expectedSignature,'a'.repeat(64));assert.equal(JSON.stringify(input.documents),JSON.stringify([{id:'d',version_id:'v7'}]));
});
test('overview keeps the graph first and MCP at the bottom; Key creation and metadata belong to the selected warehouse page',async()=>{
 const calls=[],view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph')return realGraph;if(name==='data.share-details')return {mcpUrl:'http://127.0.0.1:19878/mcp/starlink',hostBase:'/api/semantica/open/v1',keys:[{name:'业务应用',prefix:input.warehouseId==='w1'?'xg_product':'xg_delivery',scopes:['graph'],expires_at:4102444800}],rawToken:'must-never-be-rendered'};if(name==='data.copy-share-value')return {copied:true};return {items:[]}});
 view.sync(state,true);await view.refresh();let html=view.render();
 assert(html.indexOf('data-mcp-footer')>html.indexOf('核心知识图谱'));assert.match(html,/19878\/mcp\/starlink/);assert.doesNotMatch(html,/data-data-action="share-create"|data-warehouse-access|xg_product|xg_delivery|must-never-be-rendered|Host SDK/);
 await view.action('select',{id:'w2'});html=view.render();assert.match(html,/仅授权「交付流程」/);assert.match(html,/data-data-action="share-create" data-warehouse-id="w2"/);assert.match(html,/xg_delivery/);assert.doesNotMatch(html,/xg_product|must-never-be-rendered/);assert(html.indexOf('data-mcp-footer')>html.indexOf('星图专业工具'));
 await view.action('copy-home-interface',{warehouseId:'w2'});assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['data.copy-share-value',{warehouseId:'w2',kind:'mcp-url'}]));
 await view.action('overview');assert.doesNotMatch(view.render(),/data-data-action="share-create"|xg_delivery/);view.sync({...state,account:{accountId:'other'}},true);assert.doesNotMatch(view.render(),/xg_delivery/);
});
test('late interface and Key metadata cannot fill another account',async()=>{
 let resolve;const view=make(async name=>{if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph')return realGraph;if(name==='data.share-details')return new Promise(r=>resolve=r)});
 view.sync(state,true);const old=view.refresh();await new Promise(r=>setImmediate(r));view.sync({...state,account:{accountId:'new'}},true);resolve({hostBase:'/old',keys:[{name:'旧账号 Key',prefix:'oldprefix'}]});await old;assert.doesNotMatch(view.render(),/oldprefix|旧账号 Key|\/old/);
});

test('Key dialog requires an open warehouse and ignores a different warehouse target',async()=>{
 const calls=[],create={open:false},status={},form={addEventListener(){}},dialog={dataset:{},isConnected:true,showModal(){},addEventListener(){},querySelector:s=>s==='.data-share-create'?create:s==='[data-share-create-form]'?form:status};
 const document={createElement:()=>dialog,body:{append(){}},querySelectorAll:()=>[]};
 const view=make(async(name,input)=>{calls.push([name,input]);if(name==='data.warehouses')return {items:teamRows};if(name==='data.graph')return realGraph;if(name==='data.share-details')return {hostBase:'/api/semantica/open/v1',keys:[],warehouse:{id:input.warehouseId,name:input.warehouseId==='w2'?'交付流程':'产品知识'},mcpUrl:'http://127.0.0.1:19878/mcp/starlink'};return {items:[]}}, {}, document);
 view.sync(state,true);await view.refresh();calls.length=0;
 await view.action('share-create',{warehouseId:'w1'});assert.equal(calls.length,0);
 await view.action('select',{id:'w2'});calls.length=0;
 await view.action('share-create',{warehouseId:'w1'});assert.equal(calls.length,0);
 await view.action('share-create',{warehouseId:'w2'});assert.equal(calls[0][1].warehouseId,'w2');assert.equal(create.open,true);assert.match(dialog.innerHTML,/「交付流程」的访问 Key/);assert(dialog.innerHTML.indexOf('data-share-access')<dialog.innerHTML.indexOf('data-share-api'));
});
