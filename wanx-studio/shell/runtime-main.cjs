const{app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const{requestTimeout}=require('./request-policy.cjs');
const{fromEnvironment}=require('@centaurai/wanx-host-sdk');
const{attachElectronHost}=require('@centaurai/wanx-host-sdk/electron');
// WANX 0.1.4 local shared runtime uses the earlier data-path variable.
if(!process.env.WANX_HOST_USER_DATA_DIR&&process.env.WANX_HOST_APPLICATION_DATA)process.env.WANX_HOST_USER_DATA_DIR=process.env.WANX_HOST_APPLICATION_DATA;
attachElectronHost();
const host=fromEnvironment();let win,session,invalid=false;
const payload=JSON.parse(fs.readFileSync(path.join(__dirname,'miniapp.runtime.json'),'utf8'));
async function request(route,method='GET',body){if(invalid||!host)throw new Error('HOST_SESSION_EXPIRED');const target='/api/app-studio'+route;const response=await host.request(target,{method,body,timeoutMs:requestTimeout(target,method,body)});const value=await response.json();if(!response.ok)throw new Error(value.code||value.detail?.code||'RUNTIME_FAILED');return value}
function sender(event){if(invalid||event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('RUNTIME_SENDER_DENIED')}
app.whenReady().then(async()=>{
  if(!host)throw new Error('HOST_REQUIRED');
  const context=await host.context();if(context.applicationId&&context.applicationId!==payload.applicationId)throw new Error('APP_IDENTITY_MISMATCH');
  const runtime=await request('/apps/'+payload.applicationId+'/runtime','POST',{artifactHash:payload.artifactHash,environment:'production'});session=runtime.session;
  win=new BrowserWindow({width:1120,height:820,minWidth:700,minHeight:560,title:payload.name,backgroundColor:'#f8fafc',webPreferences:{preload:path.join(__dirname,'runtime-preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
  if(JSON.stringify(runtime.manifest)!==JSON.stringify(payload.manifest))throw new Error('APP_CONTRACT_CHANGED');
  ipcMain.handle('miniapp:load',event=>{sender(event);return{bundle:payload.bundle,css:payload.css,name:payload.name}});
  ipcMain.handle('miniapp:invoke',async(event,method,params)=>{sender(event);if(!['data.list','data.get','data.put','data.delete','model.generate','files.read','knowledge.search','knowledge.documents','knowledge.graph','knowledge.evidence'].includes(method))throw new Error('METHOD_NOT_ALLOWED');return request('/runtime/'+session+'/invoke','POST',{method,params})});
  ipcMain.handle('miniapp:files-list',async(event,parent)=>{sender(event);if(typeof parent!=='string'||parent.length>128)throw new Error('FILE_INPUT_INVALID');return request('/files?parent='+encodeURIComponent(parent))});
  ipcMain.handle('miniapp:files-select',async(event,ids)=>{sender(event);return request('/runtime/'+session+'/files','POST',{ids})});
  host.onSessionInvalidated(()=>{invalid=true;win?.close()});
  await win.loadFile(path.join(__dirname,'runtime.html'));win.on('closed',()=>app.quit());
}).catch(()=>app.quit());
app.on('before-quit',()=>{invalid=true;host?.close()});
