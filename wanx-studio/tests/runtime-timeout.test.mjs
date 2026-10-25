import{test}from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{createRequire}from'node:module';import vm from'node:vm';import path from'node:path';
const require=createRequire(import.meta.url);
test('full PRD repair has time for two bounded calls without expanding application or data timeouts',()=>{
 const{requestTimeout}=require('../shell/request-policy.cjs'),prefix='/api/app-studio/projects/'+'a'.repeat(32);
 assert.equal(requestTimeout(prefix+'/chat','POST'),390000);
 assert.equal(requestTimeout(prefix+'/interview/start','POST'),390000);
 assert.equal(requestTimeout('/api/app-studio/runtime/synthetic-session/invoke','POST',{method:'model.generate'}),210000);
 assert.equal(requestTimeout(prefix+'/interview/turns','POST'),240000);
 assert.equal(requestTimeout(prefix+'/build','POST'),240000);
 assert.equal(requestTimeout('/api/app-studio/_builder/projects/'+'a'.repeat(32)+'/build','POST'),240000);
 assert.equal(requestTimeout('/api/app-studio/_builder/projects/'+'a'.repeat(32)+'/edits/'+'b'.repeat(32)+'/retry','POST'),240000);
 assert.equal(requestTimeout(prefix,'GET'),undefined);
});
for(const standalone of [false,true])test((standalone?'installed miniapp':'workbench preview')+' waits for a slow model through its real IPC entrypoint',async()=>{
 const filename=path.resolve('shell/'+(standalone?'runtime-main.cjs':'main.cjs')),handlers=new Map();let window,quit=false;const calls=[];
 class Window{constructor(){window=this;this.webContents={mainFrame:{},session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},setWindowOpenHandler(){},on(){},send(){}}}async loadFile(){}on(){}close(){}setBackgroundColor(){}}
 const payload={applicationId:'ai.wanx.selfmade.'+'a'.repeat(32),manifest:{},bundle:'',css:'',name:'合成测试'};
 const host={async context(){return{applicationId:payload.applicationId}},onSessionInvalidated(){},close(){},async request(route,options={}){calls.push({route,options});if(options.body?.method==='model.generate'){if((options.timeoutMs??15000)<20000)throw Error('HOST_REQUEST_TIMEOUT');await new Promise(r=>setTimeout(r,20));return{ok:true,json:async()=>({text:'slow-model-completed'})}}return{ok:true,json:async()=>({session:'synthetic-session',manifest:{}})}}};
 const electron={app:{dock:{setIcon(){}},setName(){},setAboutPanelOptions(){},whenReady:()=>Promise.resolve(),on(){},quit(){quit=true}},BrowserWindow:Window,ipcMain:{handle:(key,fn)=>handlers.set(key,fn)},nativeTheme:{shouldUseDarkColors:false},Menu:{buildFromTemplate:value=>value,setApplicationMenu(){}}};
 vm.runInNewContext(await readFile(filename,'utf8'),{require:name=>name==='electron'?electron:name==='@centaurai/wanx-host-sdk'?{fromEnvironment:()=>host}:name==='@centaurai/wanx-host-sdk/electron'?{attachElectronHost(){}}:name==='node:fs'?{readFileSync:()=>JSON.stringify(payload)}:name==='./request-policy.cjs'?require('../shell/request-policy.cjs'):require(name),__dirname:path.dirname(filename),process:{env:{}},Buffer,URL,AbortSignal,setInterval:()=>1,clearInterval(){}});
 for(let n=0;n<5;n++)await new Promise(r=>setImmediate(r));assert.equal(quit,false);
 const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};const handler=handlers.get(standalone?'miniapp:invoke':'studio:request');assert.ok(handler);
 const result=standalone?await handler(event,'model.generate',{prompt:'合成测试'}):await handler(event,'/api/app-studio/runtime/synthetic-session/invoke','POST',{method:'model.generate',params:{prompt:'合成测试'}});
 assert.equal(result.text,'slow-model-completed');const modelCall=calls.find(c=>c.options.body?.method==='model.generate');assert.ok(modelCall.options.timeoutMs>=20000);
 if(standalone)await handler(event,'data.list',{collection:'items'});else await handler(event,'/api/app-studio/runtime/synthetic-session/invoke','POST',{method:'data.list',params:{collection:'items'}});
 assert.equal(calls.at(-1).options.timeoutMs,undefined,'ordinary data requests keep the SDK default');
 if(!standalone){
  await handler(event,'/api/app-studio/projects/'+'a'.repeat(32)+'/chat','POST',{text:'完整七部分 PRD'});
  assert.equal(calls.at(-1).options.timeoutMs,390000,'the actual workbench IPC forwards the bounded interview-repair timeout');
 }
});
