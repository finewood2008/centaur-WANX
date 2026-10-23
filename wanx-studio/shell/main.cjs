const{app,BrowserWindow,ipcMain,nativeTheme}=require('electron');
const path=require('node:path');
const{createHash}=require('node:crypto');
const{requestTimeout}=require('./request-policy.cjs');
const{fromEnvironment}=require('@centaurai/wanx-host-sdk');
const{attachElectronHost}=require('@centaurai/wanx-host-sdk/electron');
// WANX 0.1.4 local shared runtime uses the earlier data-path variable.
if(!process.env.WANX_HOST_USER_DATA_DIR&&process.env.WANX_HOST_APPLICATION_DATA)process.env.WANX_HOST_USER_DATA_DIR=process.env.WANX_HOST_APPLICATION_DATA;
attachElectronHost();
let win,invalid=false;
const host=fromEnvironment();
const beats=new Map();
function route(raw){
  if(typeof raw!=='string'||raw.includes('\\')||raw.includes('%')||raw.includes('#'))throw new Error('STUDIO_PATH_DENIED');
  const url=new URL(raw,'http://studio.invalid');
  if(url.origin!=='http://studio.invalid'||!url.pathname.startsWith('/api/app-studio/'))throw new Error('STUDIO_PATH_DENIED');
  return url.pathname+url.search;
}
function sender(event){if(invalid||event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame)throw new Error('STUDIO_SENDER_DENIED')}
async function request(raw,method='GET',body){
  if(!host||invalid)throw new Error('HOST_SESSION_EXPIRED');
  if(!['GET','POST','PUT','DELETE'].includes(method)||body&&Buffer.byteLength(JSON.stringify(body))>512*1024)throw new Error('STUDIO_REQUEST_DENIED');
  const target=route(raw);
  const response=await host.request(target,{method,body,timeoutMs:requestTimeout(target,method,body)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.code||result.detail?.code||'STUDIO_REQUEST_FAILED');
  if(target==='/api/app-studio/context'){const c=await host.context();result.scopeId=createHash('sha256').update(JSON.stringify([c.accountId,c.boxId,c.user?.id,result.scopeId])).digest('hex')}
  return result;
}
async function control(action,body){
  if(invalid||!host)throw new Error('HOST_SESSION_EXPIRED');
  await host.context();
  const response=await fetch(process.env.WANX_HOST_BASE_URL+'/__wanx/studio/'+action,{method:'POST',headers:{authorization:'Bearer '+process.env.WANX_HOST_TOKEN,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
  const value=await response.json();if(!response.ok)throw new Error(value.code||'STUDIO_HOST_UNAVAILABLE');return value;
}
function watch(projectId){
  if(beats.has(projectId))return;
  let pending=false,last='';
  const timer=setInterval(async()=>{if(pending)return;pending=true;try{const p=await request('/api/app-studio/projects/'+projectId);win?.webContents.send('studio:project',p);const revision=JSON.stringify([p.stage,p.updatedAt]);if(last&&last!==revision)await control('projectChanged',{protocolVersion:2,projectId}).catch(()=>{});last=revision;if(!p.tasks.some(t=>['running','waiting','queued'].includes(t.state))&&p.preparation?.interview?.state!=='running'){clearInterval(timer);beats.delete(projectId)}}catch{clearInterval(timer);beats.delete(projectId)}finally{pending=false}},1500);
  beats.set(projectId,timer);
}
app.whenReady().then(async()=>{
  if(!host)throw new Error('请通过万象打开应用开发工作台');
  await host.context();
  nativeTheme.themeSource='light';
  const brandIcon=path.join(__dirname,'../assets/centaurai-mark.png');
  app.dock?.setIcon(brandIcon);
  win=new BrowserWindow({icon:brandIcon,width:1440,height:900,minWidth:900,minHeight:680,title:'半人马AI-万象Builder',backgroundColor:nativeTheme.shouldUseDarkColors?'#262421':'#faf7f2',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  ipcMain.handle('studio:theme',(event,theme)=>{sender(event);if(!['light','dark','system'].includes(theme))throw new Error('THEME_INVALID');nativeTheme.themeSource=theme;win.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#262421':'#faf7f2')});
  ipcMain.handle('studio:return',async(event,destination)=>{sender(event);if(!['projects','models','connectors','skills','environment'].includes(destination))throw new Error('STUDIO_DESTINATION_DENIED');return control('return',{protocolVersion:2,destination})});
  ipcMain.handle('studio:navigation',event=>{sender(event);return control('navigation',{})});
  ipcMain.handle('studio:request',async(event,raw,method,body)=>{sender(event);const result=await request(raw,method,body);const match=/^\/api\/app-studio\/projects\/([a-f0-9]{32})\/build$/.exec(raw);if(match)watch(match[1]);if((method==='GET'&&/^\/api\/app-studio\/projects\/[a-f0-9]{32}$/.test(raw)||raw.endsWith('/interview/turns'))&&(result.tasks?.some(t=>['running','waiting','queued'].includes(t.state))||result.preparation?.interview?.state==='running'))watch(result.id);if(method!=='GET'&&/^\/api\/app-studio\/projects(?:\/|$)/.test(raw))await control('projectChanged',{protocolVersion:2,projectId:result.id}).catch(()=>{});return result});
  ipcMain.handle('studio:install',async(event,projectId,artifactHash)=>{sender(event);return control('install',{projectId,artifactHash})});
  ipcMain.handle('studio:open',async(event,applicationId)=>{sender(event);return control('open',{applicationId})});
  host.onSessionInvalidated(()=>{invalid=true;for(const timer of beats.values())clearInterval(timer);beats.clear();win?.webContents.send('studio:invalidated');win?.close()});
  await win.loadFile(path.join(__dirname,'../ui/index.html'));
  win.on('closed',()=>app.quit());
}).catch(()=>app.quit());
app.on('before-quit',()=>{invalid=true;for(const timer of beats.values())clearInterval(timer);beats.clear();host?.close()});
