import{test}from'node:test';import assert from'node:assert/strict';import{EventEmitter}from'node:events';
import{createEmbeddedWorkspace}from'../integration/embedded-workspace.mjs';import{studioRoute}from'../integration/workspace-policy.mjs';import{conversationMessages}from'../ui/conversation-state.mjs';
const id='a'.repeat(32);
function harness(){
 let respond,live=true,scope='alice',callback,loads=0;const handlers=new Map(),views=[],windows=[],requests=[],changes=[];
 const host=new EventEmitter();host.isDestroyed=()=>false;host.getContentSize=()=>[1280,800];host.show=()=>{};host.contentView={addChildView:v=>{host.child=v},removeChildView:v=>{if(host.child===v)host.child=null}};
 class View{constructor(){this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},loadFile:async()=>{loads++},setWindowOpenHandler(){},send:(name,p)=>changes.push([name,p]),isDestroyed:()=>false,close(){this.closed=true}});views.push(this)}setBounds(v){this.bounds=v}getBounds(){return this.bounds}}
 class Win extends EventEmitter{constructor(options){super();this.options=options;this.visible=true;this.focuses=0;this.contentView={addChildView:v=>{this.child=v},removeChildView:()=>{this.child=null}};windows.push(this)}getContentSize(){return[1280,800]}show(){this.visible=true}hide(){this.visible=false}focus(){this.focuses++}setTitle(title){this.title=title}destroy(){this.destroyed=true}}
 const c={context(){if(!live)throw Error('SESSION_CHANGED');return{accountId:scope,boxId:'box',user:{id:1}}},subscribe(fn){callback=fn;return()=>{}},async request(r){requests.push(r);if(respond)return respond(r);return{status:200,body:JSON.stringify({id,tasks:[],preparation:{interview:{state:'idle'}}})}}};
 const ipcMain={handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)};
 const workspace=createEmbeddedWorkspace({BrowserWindow:Win,WebContentsView:View,ipcMain,control:host,createConnection:async()=>c,assets:'/trusted',onNavigate:()=>{}});
 return{workspace,host,views,windows,requests,changes,setResponse:f=>{respond=f},get loads(){return loads},call(name,...args){const sender=views.at(-1).webContents;return handlers.get('studio-embedded:'+name)({sender,senderFrame:sender.mainFrame},...args)},invalid(){live=false;callback()},changeScope(){scope='bob';callback()},handlers};
}

test('Builder opens independently with brand and keeps one mounted view through close and reopen',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});const view=h.views[0],win=h.windows[0];assert.equal(h.loads,1);
 assert.equal(h.host.child,undefined);assert.equal(win.child,view);assert.equal(win.options.title,'万象·开物');assert.match(win.options.icon,/centaurai-mark.png$/);
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

test('transient polling failure retries instead of permanently dropping a live task',async()=>{
 const h=harness();let calls=0;
 h.setResponse(async()=>{calls++;if(calls===2)throw Error('HOST_REQUEST_TIMEOUT');return{status:200,body:JSON.stringify({id,tasks:[{state:calls<3?'running':'completed'}]})}});
 try{await h.workspace.open({protocolVersion:2,projectId:id});await new Promise(r=>setTimeout(r,3200));assert.ok(calls>=3);assert.ok(h.changes.some(([name])=>name==='studio:project'))}finally{h.workspace.close()}
});

test('polling follows capability checks and queued turns between completed interviews',async()=>{
 const h=harness();let calls=0;const phases=[{state:'running'},{state:'completed',turns:[{state:'queued'}]},{state:'completed',turns:[{state:'queued'}]},{state:'running'},{state:'completed'}];
 h.setResponse(async()=>{const interview=phases[Math.min(calls++,4)];return{status:200,body:JSON.stringify({id,tasks:[],preparation:{interview,...(calls===3?{currentProbe:{state:'running'}}:{})}})}});
 try{await h.workspace.open({protocolVersion:2,projectId:id});await new Promise(r=>setTimeout(r,6200));assert.ok(calls>=5);assert.ok(h.changes.filter(([name])=>name==='studio:project').length>=4)}finally{h.workspace.close()}
});

test('preview capture is restricted to trusted top frame and discarded after account changes',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});const wc=h.views[0].webContents;
 let release;wc.capturePage=()=>new Promise(r=>release=r);
 await assert.rejects(h.handlers.get('studio-embedded:capture-preview')({sender:wc,senderFrame:{}},{x:0,y:0,width:100,height:100}),/SENDER_DENIED/);
 const pending=h.call('capture-preview',{x:0,y:0,width:100,height:100});h.changeScope();
 release({getSize:()=>({width:100,height:100}),toPNG:()=>Buffer.from('png')});
 await assert.rejects(pending,/HOST_SESSION_EXPIRED/);h.workspace.close();
});

test('runtime reads preserve a legitimate null result for an absent record',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});
 h.setResponse(async()=>({status:200,body:'null'}));
 assert.equal(await h.call('request','/api/app-studio/runtime/session/invoke','POST',{method:'data.get',params:{collection:'settings',id:'theme'}}),null);
 h.workspace.close();
});

test('embedded turn requests allow automatic capability probes and normalize transport aborts',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});
 const original=AbortSignal.timeout;const timeouts=[];AbortSignal.timeout=ms=>{timeouts.push(ms);return original(ms)};
 try{
  h.setResponse(async()=>{throw new DOMException('The operation was aborted','AbortError')});
  await assert.rejects(h.call('request','/api/app-studio/projects/'+id+'/interview/turns','POST',{operationId:'synthetic',text:'继续'}),/^Error: HOST_REQUEST_TIMEOUT$/);
  assert.equal(timeouts[0],240000);
  h.setResponse(async()=>({status:200,body:{async *[Symbol.asyncIterator](){throw new DOMException('The operation was aborted','AbortError')}}}));
  await assert.rejects(h.call('request','/api/app-studio/projects/'+id),/^Error: HOST_REQUEST_TIMEOUT$/);
 }finally{AbortSignal.timeout=original;h.workspace.close()}
});

test('session changes take priority over a simultaneous aborted request',async()=>{
 const h=harness();await h.workspace.open({protocolVersion:2,projectId:id});let reject;
 h.setResponse(()=>new Promise((_,no)=>{reject=no}));const pending=h.call('request','/api/app-studio/projects/'+id);
 h.changeScope();reject(new DOMException('The operation was aborted','AbortError'));
 await assert.rejects(pending,/HOST_SESSION_EXPIRED/);h.workspace.close();
});
