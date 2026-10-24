const{app,BrowserWindow,ipcMain,nativeTheme,Menu}=require('electron');
const path=require('node:path');
const{createHash}=require('node:crypto');
const{studioRoute}=require('../integration/workspace-policy.mjs');
const{requestErrorCode}=require('../core/request-errors.mjs');
const{requestTimeout}=require('./request-policy.cjs');
const{capturePreview}=require('../integration/preview-capture.cjs');
const{rememberRequest,rememberEdits,stopEdits,heartbeatEdits}=require('../integration/edit-scope.mjs');
const edits=new Map();
function cancelEdits(){stopEdits(edits,(path,body)=>host?.request(path,{method:'POST',body,timeoutMs:5000}))}
const{fromEnvironment}=require('@centaurai/wanx-host-sdk');
const{attachElectronHost}=require('@centaurai/wanx-host-sdk/electron');
// WANX 0.1.4 local shared runtime uses the earlier data-path variable.
if(!process.env.WANX_HOST_USER_DATA_DIR&&process.env.WANX_HOST_APPLICATION_DATA)process.env.WANX_HOST_USER_DATA_DIR=process.env.WANX_HOST_APPLICATION_DATA;
attachElectronHost();
app.setName('万象·开物');
let win,invalid=false;
const host=fromEnvironment();
const beats=new Map();
const stopHeartbeats=heartbeatEdits(edits,(path,body)=>request(path,'POST',body));
function sender(event){if(invalid||event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('STUDIO_SENDER_DENIED')}
async function request(raw,method='GET',body){
  if(!host||invalid)throw new Error('HOST_SESSION_EXPIRED');
  if(!['GET','POST','PUT','DELETE'].includes(method)||body&&Buffer.byteLength(JSON.stringify(body))>(/^\/api\/app-studio\/_builder\/projects\/[a-f0-9]{32}\/(build|edits(?:\/[a-f0-9]{32}\/answer)?)$/.test(raw)?2*1024*1024:512*1024))throw new Error('STUDIO_REQUEST_DENIED');
  const target=studioRoute(raw,method);rememberRequest(edits,target,body);
  try{
  const response=await host.request(target,{method,body,timeoutMs:requestTimeout(target,method,body)});
  const result=await response.json();
  if(invalid)throw new Error('HOST_SESSION_EXPIRED');
  if(!response.ok)throw new Error(result.code||result.detail?.code||'STUDIO_REQUEST_FAILED');
  if(target==='/api/app-studio/context'){const c=await host.context();result.scopeId=createHash('sha256').update(JSON.stringify([c.accountId,c.boxId,c.user?.id,result.scopeId])).digest('hex')}
  rememberEdits(edits,result);return result;
  }catch(error){if(invalid)throw new Error('HOST_SESSION_EXPIRED');throw new Error(requestErrorCode(error))}
}
async function control(action,body){
  if(invalid||!host)throw new Error('HOST_SESSION_EXPIRED');
  await host.context();
  const response=await fetch(process.env.WANX_HOST_BASE_URL+'/__wanx/studio/'+action,{method:'POST',headers:{authorization:'Bearer '+process.env.WANX_HOST_TOKEN,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const value=await response.json();if(!response.ok)throw new Error(value.code||'STUDIO_HOST_UNAVAILABLE');return value;
}
function hasWork(p){return p.tasks?.some(t=>['running','waiting','queued'].includes(t.state))||p.preparation?.interview?.state==='running'||p.preparation?.interview?.turns?.some(t=>t.state==='queued'&&!t.transferredTo)||p.preparation?.currentProbe?.state==='running'}
function watch(projectId){
  if(beats.has(projectId))return;
  let pending=false,last='',idleReads=0;
  const timer=setInterval(async()=>{if(pending)return;pending=true;try{const p=await request('/api/app-studio/projects/'+projectId);win?.webContents.send('studio:project',p);const revision=JSON.stringify([p.stage,p.updatedAt]);if(last&&last!==revision)await control('projectChanged',{protocolVersion:2,projectId}).catch(()=>{});last=revision;idleReads=hasWork(p)?0:idleReads+1;if(idleReads>=2){clearInterval(timer);beats.delete(projectId)}}catch(error){if(invalid||['HOST_SESSION_EXPIRED','STUDIO_ADMIN_REQUIRED','STUDIO_IDENTITY_FORBIDDEN','PROJECT_NOT_FOUND'].includes(error.message)){clearInterval(timer);beats.delete(projectId)}}finally{pending=false}},1500);
  beats.set(projectId,timer);
}
app.whenReady().then(async()=>{
  if(!host)throw new Error('请通过万象打开万象·开物');
  await host.context();
  nativeTheme.themeSource='light';
  const brandIcon=path.join(__dirname,'../assets/centaurai-mark.png');
  app.dock?.setIcon(brandIcon);
  app.setAboutPanelOptions({applicationName:'万象·开物',copyright:'WanX Builder · 半人马AI',iconPath:brandIcon});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'万象·开物',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},
    {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
    {label:'窗口',submenu:[{role:'minimize'},{role:'togglefullscreen'}]},
  ]));
  win=new BrowserWindow({icon:brandIcon,width:1440,height:900,minWidth:900,minHeight:680,title:'万象·开物 · WanX Builder',backgroundColor:nativeTheme.shouldUseDarkColors?'#262421':'#faf7f2',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('page-title-updated',event=>event.preventDefault());
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,reply)=>reply(false));
  win.webContents.session.setPermissionCheckHandler(()=>false);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  ipcMain.handle('studio:capture-preview',async(event,rect)=>{sender(event);await host.context();const result=await capturePreview(win.webContents,{width:win.getContentSize()[0],height:win.getContentSize()[1]},rect);sender(event);await host.context();return result});
  ipcMain.handle('studio:theme',(event,theme)=>{sender(event);if(!['light','dark','system'].includes(theme))throw new Error('THEME_INVALID');nativeTheme.themeSource=theme;win.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#262421':'#faf7f2')});
  ipcMain.handle('studio:return',async(event,destination)=>{sender(event);if(!['projects','models','connectors','skills','environment'].includes(destination))throw new Error('STUDIO_DESTINATION_DENIED');return control('return',{protocolVersion:2,destination})});
  ipcMain.handle('studio:navigation',event=>{sender(event);return control('navigation',{})});
  ipcMain.handle('studio:request',async(event,raw,method,body)=>{sender(event);const result=await request(raw,method,body);const match=/^\/api\/app-studio\/(?:_builder\/)?projects\/([a-f0-9]{32})\/build$/.exec(raw);if(match)watch(match[1]);if(result.id&&hasWork(result))watch(result.id);if(method!=='GET'&&/^\/api\/app-studio\/projects(?:\/|$)/.test(raw))await control('projectChanged',{protocolVersion:2,projectId:result.id}).catch(()=>{});return result});
  ipcMain.handle('studio:install',async(event,projectId,artifactHash)=>{sender(event);return control('install',{projectId,artifactHash})});
  ipcMain.handle('studio:open',async(event,applicationId)=>{sender(event);return control('open',{applicationId})});
  host.onSessionInvalidated(()=>{cancelEdits();invalid=true;for(const timer of beats.values())clearInterval(timer);beats.clear();win?.webContents.send('studio:invalidated');win?.close()});
  await win.loadFile(path.join(__dirname,'../ui/index.html'));
  win.on('closed',()=>app.quit());
}).catch(()=>app.quit());
app.on('before-quit',()=>{stopHeartbeats();cancelEdits();invalid=true;for(const timer of beats.values())clearInterval(timer);beats.clear();host?.close()});
