import{test}from'node:test';import assert from'node:assert/strict';import{EventEmitter}from'node:events';
import{createEmbeddedWorkspace}from'../integration/embedded-workspace.mjs';import{studioRoute}from'../integration/workspace-policy.mjs';import{conversationMessages}from'../ui/conversation-state.mjs';
const id='a'.repeat(32);
function harness(){
 let respond,live=true,scope='alice',callback,loads=0;const handlers=new Map(),views=[],windows=[],requests=[],changes=[];
 const host=new EventEmitter();host.isDestroyed=()=>false;host.getContentSize=()=>[1280,800];host.show=()=>{};host.contentView={addChildView:v=>{host.child=v},removeChildView:v=>{if(host.child===v)host.child=null}};
 class View{constructor(){this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},loadFile:async()=>{loads++},setWindowOpenHandler(){},send:(name,p)=>changes.push([name,p]),isDestroyed:()=>false,close(){this.closed=true}});views.push(this)}setBounds(v){this.bounds=v}}
 class Win extends EventEmitter{constructor(options){super();this.options=options;this.visible=true;this.focuses=0;this.contentView={addChildView:v=>{this.child=v},removeChildView:()=>{this.child=null}};windows.push(this)}getContentSize(){return[1280,800]}show(){this.visible=true}hide(){this.visible=false}focus(){this.focuses++}setTitle(title){this.title=title}destroy(){this.destroyed=true}}
 const c={context(){if(!live)throw Error('SESSION_CHANGED');return{accountId:scope,boxId:'box',user:{id:1}}},subscribe(fn){callback=fn;return()=>{}},async request(r){requests.push(r);if(respond)return respond(r);return{status:200,body:JSON.stringify({id,tasks:[],preparation:{interview:{state:'idle'}}})}}};
 const ipcMain={handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)};
 const workspace=createEmbeddedWorkspace({BrowserWindow:Win,WebContentsView:View,ipcMain,control:host,createConnection:async()=>c,assets:'/trusted',onNavigate:()=>{}});
 return{workspace,host,views,windows,requests,changes,setResponse:f=>{respond=f},get loads(){return loads},call(name,...args){const sender=views.at(-1).webContents;return handlers.get('studio-embedded:'+name)({sender,senderFrame:sender.mainFrame},...args)},invalid(){live=false;callback()},changeScope(){scope='bob';callback()},handlers};
}

test('Builder opens independently with brand and keeps one mounted view through close and reopen',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});const view=h.views[0],win=h.windows[0];assert.equal(h.loads,1);
 assert.equal(h.host.child,undefined);assert.equal(win.child,view);assert.equal(win.options.title,'半人马AI-万象Builder');assert.match(win.options.icon,/centaurai-mark.png$/);
 assert.equal((await h.call('navigation')).projectId,id);
 let prevented=false;win.emit('close',{preventDefault(){prevented=true}});assert.ok(prevented);assert.equal(win.visible,false);assert.equal(view.webContents.closed,undefined);
 h.workspace.placement({protocolVersion:1,action:'show'});assert.equal(win.visible,false,'client refresh must not reopen hidden Builder');
 await h.workspace.open({protocolVersion:2,projectId:id});assert.equal(win.visible,true);assert.equal(h.loads,1);assert.equal(h.windows.length,1);assert.equal((await h.call('navigation')).navigationId,undefined,'same-project reopen does not replace preview or drafts');
 h.workspace.placement({protocolVersion:1,action:'attach'});assert.equal(h.host.child,view);
 h.workspace.placement({protocolVersion:1,action:'detach'});assert.equal(h.windows.at(-1).child,view);assert.equal(h.loads,1);h.workspace.close();
});
test('client redraw cannot hide or attach a detached Builder; explicit return hides without reload',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});const win=h.windows[0],view=h.views[0];
 h.workspace.placement({protocolVersion:1,action:'hide'});h.workspace.placement({protocolVersion:1,action:'show'});
 assert.equal(win.child,view);assert.equal(win.visible,true);assert.equal(h.host.child,undefined);
 await h.call('return','projects');assert.equal(win.visible,false);assert.equal(h.loads,1);
 const other='b'.repeat(32);await h.workspace.open({protocolVersion:2,projectId:other});assert.equal(h.windows.length,1);assert.equal((await h.call('navigation')).projectId,other);assert.equal(h.loads,1);h.workspace.close();
});
test('closing a destroyed client disposes its workspace without touching the destroyed native view',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});
 h.host.isDestroyed=()=>true;h.host.contentView.removeChildView=()=>{throw Error('native host destroyed')};
 assert.doesNotThrow(()=>h.host.emit('closed'));assert.equal(h.views[0].webContents.closed,true);h.workspace.close();
});
test('fixed bridge rejects foreign senders, arbitrary WANX paths and invalidated scopes',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});
 await assert.rejects(h.handlers.get('studio-embedded:request')({sender:{},senderFrame:{}},'/api/app-studio/context'),/SENDER_DENIED/);
 for(const route of ['https://evil.test/api/app-studio/context','/api/providers','/api/app-studio/../acp','/api/app-studio/context%2f../../','/api/app-studio/shell'])assert.throws(()=>studioRoute(route),/PATH_DENIED/);
 assert.equal(studioRoute('/api/app-studio/runtime/token/invoke'),'/api/app-studio/runtime/token/invoke');
 h.changeScope();assert.equal(h.views[0].webContents.closed,true);await assert.rejects(h.call('request','/api/app-studio/context'),/HOST_SESSION_EXPIRED/);h.workspace.close();
});
test('one conversation retains intake answers and switches authors without copying the opening twice',()=>{
 const opening={id:'origin',role:'user',text:'整理会议'};const intake=[{id:'u',role:'user',text:'整理会议'},{id:'a',role:'assistant',text:'先改哪一步？'}];
 const p={originalGoal:opening.text,messages:[opening,{id:'pm',role:'assistant',text:'我继续深入设计'}],preparation:{phase:'acp',messages:intake}};
 const combined=conversationMessages(p);assert.equal(combined.filter(m=>m.text==='整理会议').length,1);assert.equal(combined[1].author,'任务助手');assert.equal(combined.at(-1).id,'pm');assert.equal(p.messages.length,2);
});

test('hiding the workspace retains active-task reads, while old-scope responses are fenced',async()=>{
 const h=harness();let taskState='running';h.setResponse(async()=>({status:200,body:JSON.stringify({id,tasks:[{state:taskState}],preparation:{interview:{state:'idle'}}})}));
 await h.workspace.open({protocolVersion:2,projectId:id});h.workspace.placement({protocolVersion:1,action:'hide'});
 await new Promise(r=>setTimeout(r,1650));assert.ok(h.requests.length>=2);taskState='completed';
 let release;h.setResponse(()=>new Promise(r=>release=r));const old=h.call('request','/api/app-studio/context');
 h.changeScope();h.setResponse(async()=>({status:200,body:JSON.stringify({id,tasks:[]})}));await h.workspace.open({protocolVersion:2,projectId:id});
 release({status:200,body:JSON.stringify({private:'previous account'})});await assert.rejects(old,/HOST_SESSION_EXPIRED/);h.workspace.close();
});
