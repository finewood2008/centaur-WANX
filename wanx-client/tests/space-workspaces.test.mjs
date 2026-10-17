import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../local-ui/renderer/space-workspaces.js',import.meta.url),'utf8');
function setup(){
 const events={},saved=new Map(),calls=[],positions=[];
 const spaces=[{id:'personal',root:'',name:'我的空间',connections:[]},{id:'agent',root:'agent-root',name:'同名 Agent',connections:[],bytes:2},{id:'other',root:'other-root',name:'同名 Agent',connections:[],bytes:3}];
 let resolveStat,delay=false,selection={path:'/Volumes/Space Drive'};
 const rows=new Map([['folder',{id:'folder',name:'原名',space_id:'agent',kind:'folder'}]]);
 const root={addEventListener(type,fn){events[type]=fn;}},doc={querySelector:s=>s==='#app'?root:null,addEventListener(){},querySelectorAll:()=>[]};
 const window={location:{origin:'file://'}};
 vm.runInNewContext(source,{window,document:doc,localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},navigator:{clipboard:{writeText:async()=>{}}},console});
 const w=window.wanxWorkspaces;
 w.bind({render(){},navigate:async(...p)=>positions.push(p),reload:async()=>{},message:e=>e.message,error:e=>{throw Error(e);},call:async(method,input)=>{
 calls.push([method,input]);
 if(method==='links-spaces')return spaces;
 if(method==='links-storage-choose')return typeof selection==='function'?selection(input):selection;
 if(method==='links-requests')return [{id:'one',profile:'profile-one',name:'Same',status:'pending'},{id:'two',profile:'profile-two',name:'Same',status:'pending'}];
 if(method==='stat'){if(delay)return new Promise(r=>resolveStat=r);if(!rows.has(input.id))throw Error('SPACE_NOT_FOUND');return rows.get(input.id);}
 if(method==='list')return {items:[],breadcrumbs:[]};
 return [];
 }});
 w.reset('account:box');w.storageScope('platform:account:box');
 const click=(action,data={})=>events.click({preventDefault(){},target:{closest:()=>({dataset:{workspaceAction:action,...data}})}});
 return {w,spaces,rows,saved,calls,positions,click,events,select(v){selection=v;},delay(){delay=true;},resolve(v){resolveStat(v);}};
}
test('favorites follow resource IDs across rename and move and remain isolated by platform/account/box',async()=>{
 const h=setup();await h.w.refresh();await h.w.observe({space:'agent',parent:'agent-root',trash:false},{items:[],breadcrumbs:[]});await h.w.pin({id:'folder',name:'原名'});
 h.rows.set('folder',{id:'folder',name:'改名',space_id:'other',kind:'folder'});await h.w.refresh();
 assert.match(h.w.sidebar(),/data-space="other" data-name="改名"/);
 h.w.storageScope('different-platform:account:box');await h.w.refresh();assert.doesNotMatch(h.w.sidebar(),/改名/);
 h.w.storageScope('platform:account:box');await h.w.refresh();assert.match(h.w.sidebar(),/改名/);
 h.rows.delete('folder');await h.w.refresh();assert.match(h.w.sidebar(),/data-name="改名" disabled/);
});
test('same labels do not merge sources; lazy hierarchy and history retain space identity',async()=>{
 const h=setup();await h.w.refresh();await h.w.observe({space:'agent',parent:'folder',trash:false},{items:[],breadcrumbs:[{id:'folder',name:'项目'}]});
 assert.match(h.w.sidebar(),/data-space="agent"/);assert.match(h.w.sidebar(),/data-space="other"/);
 await h.w.observe({space:'other',parent:'other-root',trash:false},{items:[],breadcrumbs:[]});await h.click('back');
 assert.deepEqual(h.positions.at(-1),['folder',false,'agent',false]);await h.click('forward');assert.deepEqual(h.positions.at(-1),['other-root',false,'other',false]);
 assert.ok(h.calls.some(([m,i])=>m==='list'&&i.space_id==='agent'&&i.parent==='agent-root'));
});
test('approval of same-name requests uses the selected persistent identity and explicit user name',async()=>{
 const h=setup();await h.click('requests');await h.click('approve-form',{id:'two'});
 assert.match(h.w.dialogView(),/approve:two/);
 h.events.input({target:{id:'workspace-name',value:'资料整理'}});
 h.events.submit({target:{hasAttribute:()=>true},preventDefault(){}});
 await new Promise(r=>setImmediate(r));
 const approval=h.calls.find(([m])=>m==='links-approve');assert.equal(approval[1].id,'two');assert.equal(approval[1].name,'资料整理');assert.equal(approval[1].space_id,'');
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
