import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../local-ui/renderer/space-workspaces.js',import.meta.url),'utf8');
function setup(){
 const events={},saved=new Map(),calls=[],positions=[],fileActions=[];let reloads=0;
 const spaces=[{id:'personal',root:'',name:'我的空间',connections:[]},{id:'agent',root:'agent-root',name:'同名 Agent',connections:[],bytes:2},{id:'other',root:'other-root',name:'同名 Agent',connections:[],bytes:3}];
 let syncData,resolveStat,delay=false,selection={path:'/Volumes/Space Drive'};
 const rows=new Map([['folder',{id:'folder',name:'原名',space_id:'agent',kind:'folder',parent:'agent-root'}]]);
 const root={addEventListener(type,fn){events[type]=fn;}},doc={querySelector:s=>s==='#app'?root:null,addEventListener(){},querySelectorAll:()=>[]};
 const window={location:{origin:'file://'}};
 vm.runInNewContext(source,{window,document:doc,localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},navigator:{clipboard:{writeText:async()=>{}}},console});
 const w=window.wanxWorkspaces;
 w.bind({icon:kind=>`<svg data-icon="${kind}"></svg>`,fileAction:async(...a)=>fileActions.push(a),render(){},navigate:async(...p)=>positions.push(p),reload:async()=>reloads++,message:e=>e.message,error:e=>{throw Error(e);},call:async(method,input)=>{
 calls.push([method,input]);
 if(method==='links-sync-status')return syncData;
 if(method==='links-spaces')return spaces;
 if(method==='links-storage-choose')return typeof selection==='function'?selection(input):selection;
 if(method==='links-requests')return [{id:'one',profile:'profile-one',name:'Same',status:'pending'},{id:'two',profile:'profile-two',name:'Same',status:'pending'}];
 if(method==='stat'){if(delay)return new Promise(r=>resolveStat=r);if(!rows.has(input.id))throw Error('SPACE_NOT_FOUND');return rows.get(input.id);}
 if(method==='list')return {items:[...rows.values()].filter(r=>r.parent===input.parent),breadcrumbs:[]};
 if(method==='links-space-manage'){const space=spaces.find(s=>s.id===input.id);if(input.action==='trash')space.trashed=1;if(input.action==='restore')space.trashed=null;return {ok:true};}
 return [];
 }});
 w.reset('account:box');w.storageScope('platform:account:box');
 const click=(action,data={})=>events.click({preventDefault(){},target:{closest:()=>({dataset:{workspaceAction:action,...data}})}});
 return {w,spaces,rows,saved,calls,positions,fileActions,reloads:()=>reloads,click,events,setSync(v){syncData=v;},select(v){selection=v;},delay(){delay=true;},resolve(v){resolveStat(v);}};
}
test('favorites follow resource IDs across rename and move and remain isolated by platform/account/box',async()=>{
 const h=setup();await h.w.refresh();await h.w.observe({space:'agent',parent:'agent-root',trash:false},{items:[],breadcrumbs:[]});await h.w.pin({id:'folder',name:'原名'});
 h.rows.set('folder',{id:'folder',name:'改名',space_id:'other',kind:'folder'});await h.w.refresh();
 assert.match(h.w.sidebar(),/data-space="other" data-name="改名"/);
 h.w.storageScope('different-platform:account:box');await h.w.refresh();assert.doesNotMatch(h.w.sidebar(),/改名/);
 h.w.storageScope('platform:account:box');await h.w.refresh();assert.match(h.w.sidebar(),/改名/);
 h.rows.delete('folder');await h.w.refresh();assert.match(h.w.sidebar(),/data-name="改名"[^>]*disabled/);
});
test('same labels do not merge sources; lazy hierarchy and history retain space identity',async()=>{
 const h=setup();await h.w.refresh();await h.w.observe({space:'agent',parent:'folder',trash:false},{items:[],breadcrumbs:[{id:'folder',name:'项目'}]});
 assert.match(h.w.sidebar(),/data-space="agent"/);assert.match(h.w.sidebar(),/data-space="other"/);
 await h.w.observe({space:'other',parent:'other-root',trash:false},{items:[],breadcrumbs:[]});await h.click('back');
 assert.deepEqual(h.positions.at(-1),['folder',false,'agent',false]);await h.click('forward');assert.deepEqual(h.positions.at(-1),['other-root',false,'other',false]);
 assert.ok(h.calls.some(([m,i])=>m==='list'&&i.space_id==='agent'&&i.parent==='agent-root'));
});
test('a stale favorite lookup cannot refill a switched account',async()=>{
 const h=setup();await h.w.refresh();await h.w.pin({id:'folder',name:'秘密资料'});h.delay();const pending=h.w.refresh();await new Promise(r=>setImmediate(r));h.w.reset('new-account');h.resolve({id:'folder',name:'旧账号',space_id:'agent'});await assert.rejects(pending,/SPACE_CONTEXT_CHANGED/);assert.doesNotMatch(h.w.sidebar(),/秘密资料|旧账号/);
});
test('storage settings use a directory picker for the selected space without a path text input',async()=>{
 const h=setup();await h.w.refresh();await h.w.observe({space:'agent',parent:'agent-root',trash:false},{items:[],breadcrumbs:[]});
 assert.match(h.w.storageView(),/data-space="agent"/);
 await h.click('storage',{space:'agent'});assert.match(h.w.dialogView(),/选择文件夹…/);assert.doesNotMatch(h.w.dialogView(),/<input/);
 await h.click('storage-choose');assert.match(h.w.dialogView(),/Volumes\/Space Drive/);
 assert.ok(!h.calls.some(([m])=>m==='links-storage-set'));
 h.select({canceled:true});await h.click('storage-choose');assert.match(h.w.dialogView(),/Volumes\/Space Drive/);
 h.events.submit({target:{hasAttribute:()=>true},preventDefault(){}});await new Promise(r=>setImmediate(r));
 const setting=h.calls.find(([m])=>m==='links-storage-set');assert.equal(setting[1].id,'agent');assert.equal(setting[1].path,'/Volumes/Space Drive');
 await h.w.observe({space:'agent',parent:'',trash:true},{items:[],breadcrumbs:[]});assert.equal(h.w.storageView(),'');
});

test('remote folder picker navigates the host tree and only saves after explicit selection',async()=>{
 const h=setup();await h.click('storage',{space:'personal'});
 h.select(({path})=>({browse:true,path:path||'/',root:'/',parent:'/',entries:path?[{path:'/data/projects',name:'projects'}]:[{path:'/data',name:'data'}]}));
 await h.click('storage-choose');assert.match(h.w.dialogView(),/万象主机文件夹/);
 await h.click('storage-browse',{path:'/data'});assert.match(h.w.dialogView(),/projects/);
 await h.click('storage-select');assert.match(h.w.dialogView(),/title="\/data"/);
 assert.ok(!h.calls.some(([m])=>m==='links-storage-set'));
 h.events.submit({target:{hasAttribute:()=>true},preventDefault(){}});await new Promise(r=>setImmediate(r));
 assert.equal(h.calls.find(([m])=>m==='links-storage-set')[1].path,'/data');
});
test('directory selection finishing after an account change cannot reopen or submit the old modal',async()=>{
 const h=setup();await h.click('storage',{space:'personal'});let resolve;
 h.select(()=>new Promise(r=>resolve=r));const pending=h.click('storage-choose');await new Promise(r=>setImmediate(r));
 h.w.reset('changed-account');resolve({path:'/old-account'});await pending;
 assert.equal(h.w.dialogView(),'');assert.ok(!h.calls.some(([m])=>m==='links-storage-set'));
});

const sidebarTarget=(kind='space',space='agent',id='agent-root',name='同名 Agent')=>({sidebarKind:kind,space,id,name});
test('favorites are first, roots start collapsed and only current ancestors automatically expand',async()=>{
 const h=setup();await h.w.refresh();await h.w.observe({space:'personal',parent:'',trash:false},{items:[],breadcrumbs:[]});
 let html=h.w.sidebar();assert.ok(html.indexOf('aria-label="常用位置"')<html.indexOf('aria-label="我的空间"'));assert.match(html,/aria-label="展开同名 Agent" aria-expanded="false"/);
 await h.w.observe({space:'agent',parent:'folder',trash:false},{items:[],breadcrumbs:[{id:'folder',name:'项目'}]});assert.match(h.w.sidebar(),/aria-label="折叠同名 Agent"/);
 await h.w.observe({space:'other',parent:'other-root',trash:false},{items:[],breadcrumbs:[]});assert.doesNotMatch(h.w.sidebar(),/data-sidebar-kind="folder"/);
 await h.click('expand',{space:'agent',id:'agent-root'});assert.match(h.w.sidebar(),/data-sidebar-kind="folder"/);
 await h.w.observe({space:'personal',parent:'',trash:false},{items:[],breadcrumbs:[]});assert.match(h.w.sidebar(),/data-sidebar-kind="folder"/);
 assert.doesNotMatch(html,/接入 Agent 后显示独立空间|♲|▱|☆/);assert.match(h.w.footerNavigation(),/回收站/);
});
test('right click and more open identical menus, and removing a favorite never deletes its target',async()=>{
 const h=setup();await h.w.refresh();const target=sidebarTarget('folder','agent','folder','原名');
 h.events.contextmenu({preventDefault(){},clientX:20,clientY:30,target:{closest:()=>({dataset:target})}});const right=h.w.menuView();
 assert.match(right,/重命名…/);assert.match(right,/移入回收站…/);assert.ok(!h.calls.some(([m])=>m==='trash'));
 await h.click('menu',target);assert.equal(h.w.menuView().replace(/left:[^;]+;top:[^"]+/,''),right.replace(/left:[^;]+;top:[^"]+/,''));
 await h.click('menu-command',{command:'pin'});assert.match(h.w.sidebar(),/space-favorite/);
 await h.click('menu',sidebarTarget('favorite','agent','folder','原名'));assert.doesNotMatch(h.w.menuView(),/移入回收站|重命名/);
 await h.click('menu-command',{command:'unpin'});assert.doesNotMatch(h.w.sidebar(),/class="space-favorite"/);assert.equal(h.rows.get('folder').name,'原名');
 await h.click('menu',target);await h.click('menu-command',{command:'trash'});assert.equal(h.fileActions[0][0],'trash');assert.equal(h.fileActions[0][1].id,'folder');
});
test('source deletion confirms the named target, preserves other navigation, and protects personal root',async()=>{
 const h=setup();await h.w.refresh();await h.w.observe({space:'other',parent:'other-root',trash:false},{items:[],breadcrumbs:[]});
 await h.click('menu',sidebarTarget());await h.click('menu-command',{command:'trash'});
 assert.match(h.w.dialogView(),/将“同名 Agent”移入回收站/);assert.ok(!h.calls.some(([m])=>m==='links-space-manage'));
 await h.click('confirm');assert.equal(h.positions.length,0);assert.equal(h.reloads(),1);assert.equal(h.calls.find(([m])=>m==='links-space-manage')[1].id,'agent');
 await h.click('menu',sidebarTarget('space','personal','','我的空间'));assert.doesNotMatch(h.w.menuView(),/移入回收站|重命名/);
 await assert.rejects(h.click('menu-command',{command:'trash'}),/SPACE_MANAGED_ROOT/);
 await h.click('menu',sidebarTarget('space','other','other-root','同名 Agent'));await h.click('menu-command',{command:'trash'});await h.click('confirm');assert.deepEqual(h.positions.at(-1),['',false,'personal']);
});
test('deleted descendants reconcile to the nearest surviving ancestor and history omits removed subtrees',async()=>{
 const h=setup();h.rows.set('parent',{id:'parent',parent:'agent-root',space_id:'agent',name:'上级',kind:'folder'});
 await h.w.refresh();await h.w.observe({space:'agent',parent:'agent-root',trash:false},{items:[],breadcrumbs:[]});await h.w.observe({space:'agent',parent:'folder',trash:false},{items:[],breadcrumbs:[{id:'parent'},{id:'folder'}]});
 h.rows.delete('folder');const next=await h.w.reconcile({space:'agent',parent:'child',trash:false},[{id:'parent'},{id:'folder'},{id:'child'}]);assert.equal(next.parent,'parent');
 h.w.invalidated([{space_id:'agent',id:'folder'}]);await h.w.observe({space:'agent',parent:'parent',trash:false},{items:[],breadcrumbs:[{id:'parent'}]});await h.click('back');assert.equal(h.positions.at(-1)[0],'agent-root');
 h.spaces[1].trashed=1;const root=await h.w.reconcile({space:'agent',parent:'parent',trash:false},[]);assert.equal(root.space,'personal');assert.equal(root.parent,'');
});
test('stale sidebar folder resolution cannot act after an account switch or after a cross-space move',async()=>{
 const h=setup();await h.w.refresh();h.rows.set('folder',{id:'folder',kind:'folder',space_id:'other'});
 await h.click('menu',sidebarTarget('folder','agent','folder','原名'));await assert.rejects(h.click('menu-command',{command:'trash'}),/SPACE_CONTEXT_CHANGED/);assert.equal(h.fileActions.length,0);
 h.delay();await h.click('menu',sidebarTarget('folder','agent','folder','原名'));const pending=h.click('menu-command',{command:'trash'});await new Promise(r=>setImmediate(r));h.w.reset('new-account');h.resolve({id:'folder',kind:'folder',space_id:'agent'});await pending;assert.equal(h.fileActions.length,0);assert.equal(h.w.menuView(),'');
});

test('sync view distinguishes selected rules, stored receipts, unsupported memory and stale scope',async()=>{
 const h=setup();
 const data={policy:{configured:true,revision:1,options:{context:true,progress:true,outcome:true,project_memory:true,user_memory:false}},connection_state:'active',bytes:123,tasks:[]};
 h.setSync(data);await h.click('sync-open',{id:'connection'});
 assert.match(h.w.dialogView(),/等待任务/);assert.doesNotMatch(h.w.dialogView(),/<strong>已同步<\/strong>/);
 data.tasks.push({id:'task',title:'合成 <script>任务',version:2,record_count:2,modified:1,state:'active',categories:{context:{status:'provided',summary:'test'},progress:{status:'provided',summary:'written'},project_memory:{status:'unsupported',reason:'no export'}}});
 await h.w.updateSync();
 const html=h.w.dialogView();assert.match(html,/部分同步/);assert.match(html,/宿主不支持/);assert.match(html,/等待任务结束/);assert.match(html,/未开启/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 data.delivery={state:'saving'};await h.w.updateSync();assert.match(h.w.dialogView(),/等待保存/);
 data.delivery={state:'failed'};await h.w.updateSync();assert.match(h.w.dialogView(),/同步失败/);
 data.connection_state='paused';await h.w.updateSync();assert.match(h.w.dialogView(),/已暂停/);
 h.w.reset('new-account');await h.w.updateSync();assert.equal(h.w.dialogView(),'');
});

test('Agent connections use the generic MCP surface, not a pending-request approval wizard',async()=>{
 const h=setup();await h.w.openRequests();assert.equal(h.w.dialogView(),'');assert.ok(!h.calls.some(([method])=>method==='links-requests'||method==='links-agent-config'));
});
