import{test}from'node:test';import assert from'node:assert/strict';import vm from'node:vm';import{readFile}from'node:fs/promises';
const source=await readFile(new URL('../integration/construction.js',import.meta.url),'utf8');
test('engine settings read only summaries on entry and do not probe without an action',async()=>{
 const calls=[],window={};let release;
 const request=async(n,p)=>{calls.push([n,p]);if(n==='studio.engines.list')return{defaultId:'codex',items:[{id:'codex',name:'Codex',adapted:true,enabled:true,status:'unchecked',location:'当前 WANX'}]};return{defaultId:'codex',items:[]}};
 vm.runInNewContext(source,{window});const c=window.createConstruction({request,changed(){}}),state={account:{phase:'authenticated',accountId:'alice',clientId:'desktop'},activeDeviceId:'a'};
 c.sync(state,true);await new Promise(r=>setImmediate(r));assert.deepEqual(calls.map(c=>c[0]),['studio.engines.list']);assert.match(c.engineButton(),/待检查/);
 c.workspace();assert.equal(c.opened(),false);const before=calls.length;c.visibility('applications');assert.equal(calls.length,before,'detached Builder must not be placed by client redraw');c.visibility('construction');assert.equal(c.opened(),false);
 await c.action('construction-settings',{});assert.match(c.settings(),/构建引擎/);assert.equal(calls.some(([n])=>n==='studio.engines.check'),false);
 c.sync({...state,activeDeviceId:'b'},false);assert.equal(c.opened(),false);assert.doesNotMatch(c.engineButton(),/待检查/);
});
test('late engine checks cannot populate a different account or box',async()=>{
 const window={};let release;
 const request=async n=>n==='studio.engines.check'?new Promise(r=>release=r):{items:[]};
 vm.runInNewContext(source,{window});const c=window.createConstruction({request,changed(){}});
 const state={account:{phase:'authenticated',accountId:'alice'},activeDeviceId:'a'};
 c.sync(state,false);const pending=c.action('construction-engine-check',{engineId:'codex'});
 c.sync({...state,account:{phase:'authenticated',accountId:'bob'}},false);
 release({defaultId:'codex',items:[{id:'codex',name:'Previous account engine',status:'available'}]});await pending;
 assert.doesNotMatch(c.engineButton(),/Previous account engine/);
});

test('ACP settings button uses the fixed client destination and never changes a default engine',async()=>{
 const calls=[],window={};vm.runInNewContext(source,{window});
 const c=window.createConstruction({request:async(name,input)=>{calls.push([name,input]);return{items:[]}},changed(){}});
 await c.action('construction-settings',{});assert.match(c.settings(),/data-action="construction-open-acp"/);
 await c.action('construction-open-acp',{});assert.equal(calls.at(-1)[0],'builder.acp');assert.equal(calls.at(-1)[1],undefined);
 const count=calls.length;await c.action('construction-unknown',{});assert.equal(calls.length,count);
 assert.equal(calls.some(([name])=>name==='studio.engines.default'||name==='studio.engines.check'),false);
});

test('unavailable engine service is distinct from a successfully read empty configuration',async()=>{
 const window={};let unavailable=true;vm.runInNewContext(source,{window});
 const c=window.createConstruction({request:async()=>{if(unavailable)throw new Error("Error invoking remote method 'wanx-client:studio-engines-list': Error: STUDIO_UNAVAILABLE");return{items:[],defaultId:null}},changed(){}});
 await c.action('construction-settings',{});
 assert.match(c.engineButton(),/暂不可用/);assert.doesNotMatch(c.engineButton(),/需配置/);
 assert.match(c.settings(),/当前盒子.*构建服务.*未就绪/);assert.match(c.settings(),/盒端构建组件/);
 assert.doesNotMatch(c.settings(),/Error invoking/);
 unavailable=false;await c.action('construction-engine-refresh',{});
 assert.match(c.engineButton(),/需配置/);assert.doesNotMatch(c.settings(),/构建服务.*未就绪/);
 unavailable=true;await c.action('construction-engine-refresh',{});
 assert.match(c.engineButton(),/暂不可用/);assert.doesNotMatch(c.engineButton(),/需配置/);
});

test('unknown engine read errors do not expose service response details',async()=>{
 const window={};vm.runInNewContext(source,{window});
 const c=window.createConstruction({request:async()=>{throw new Error('private-token DO_NOT_SHOW')},changed(){}});
 await c.action('construction-settings',{});
 assert.match(c.settings(),/暂时无法读取引擎配置/);assert.doesNotMatch(c.settings(),/private-token|DO_NOT_SHOW/);
});
