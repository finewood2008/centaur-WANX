import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';

const source=await readFile(new URL('../shell/main.cjs',import.meta.url),'utf8');
const require=createRequire(import.meta.url),id='a'.repeat(32);
async function shell(){
 const handlers=new Map(),timers=new Set(),windows=[];let invalidated,failRead=null;
 let project={id,tasks:[],preparation:{interview:{state:'idle',turns:[{state:'queued'}]}}};
 const app=new EventEmitter();Object.assign(app,{whenReady:async()=>{},setName:name=>{app.name=name},setAboutPanelOptions:info=>{app.about=info},quit:()=>{app.quitCalled=true},dock:{setIcon(){}}});
 class Window extends EventEmitter{
  constructor(options){super();this.options=options;windows.push(this);this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},setWindowOpenHandler(){},send(){}})}
  async loadFile(file){this.file=file}getContentSize(){return[1440,900]}close(){this.closed=true;this.emit('closed')}
 }
 const host={context:async()=>({accountId:'admin',boxId:'box',user:{id:1}}),request:async()=>{if(failRead){const error=failRead;failRead=null;throw error}return{ok:true,json:async()=>project}},onSessionInvalidated:fn=>{invalidated=fn},close(){}};
 vm.runInNewContext(source,{
  require:name=>name==='electron'?{app,BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},nativeTheme:{},Menu:{buildFromTemplate:value=>value,setApplicationMenu:menu=>{app.menu=menu}}}:name==='@centaurai/wanx-host-sdk'?{fromEnvironment:()=>host}:name==='@centaurai/wanx-host-sdk/electron'?{attachElectronHost(){}}:name.endsWith('request-policy.cjs')?{requestTimeout:()=>60000}:name.endsWith('preview-capture.cjs')?{capturePreview(){}}:name.endsWith('edit-scope.mjs')?{rememberRequest(){},rememberEdits(){},stopEdits(){},heartbeatEdits:()=>()=>{}}:require(name),
  __dirname:path.resolve('shell'),process:{env:{}},Buffer,URL,AbortSignal,
  setInterval:fn=>{timers.add(fn);return fn},clearInterval:fn=>timers.delete(fn),
 });
 await new Promise(resolve=>setImmediate(resolve));
 const win=windows[0];assert.ok(win,'the managed app creates its own window');assert.ok(!app.quitCalled);
 const event={sender:win.webContents,senderFrame:win.webContents.mainFrame};
 return{app,win,timers,request:(route='/api/app-studio/projects/'+id)=>handlers.get('studio:request')(event,route,'GET'),invalidate:()=>invalidated(),fail:(error=Error('ECONNRESET'))=>{failRead=error},idle:()=>{project={id,tasks:[]}},dispose:()=>app.emit('before-quit')};
}

test('independent Builder owns its window and menu and stops access when the Host session expires',async()=>{
 const h=await shell();try{
  assert.equal(h.app.name,'万象·开物');assert.equal(h.win.options.title,'万象·开物 · WanX Builder');
  assert.equal(h.app.menu[0].label,'万象·开物');assert.match(h.app.about.copyright,/WanX Builder/);
  assert.equal(h.win.options.webPreferences.nodeIntegration,false);
  await assert.rejects(h.request('/api/auth/me'),/STUDIO_PATH_DENIED/);
  h.fail(Object.assign(Error('The operation was aborted'),{name:'AbortError'}));
  await assert.rejects(h.request(),/HOST_REQUEST_TIMEOUT/);
  await h.request();h.invalidate();assert.equal(h.win.closed,true);assert.equal(h.timers.size,0);
  await assert.rejects(h.request(),/STUDIO_SENDER_DENIED/);
 }finally{h.dispose()}
});

test('independent window continues queued work after a transient disconnect and stops after two idle reads',async()=>{
 const h=await shell();try{
  await h.request();assert.equal(h.timers.size,1);const tick=[...h.timers][0];
  h.fail();await tick();assert.equal(h.timers.size,1);
  await tick();assert.equal(h.timers.size,1);
  h.idle();await tick();assert.equal(h.timers.size,1);await tick();assert.equal(h.timers.size,0);
 }finally{h.dispose()}
});
