import path from'node:path';
import{randomUUID,createHash}from'node:crypto';
import{studioRoute,scopeKey,validatePlacement}from'./workspace-policy.mjs';
import capture from'./preview-capture.cjs';
import editScope from'./edit-scope.mjs';
import requestPolicy from'../shell/request-policy.cjs';
import{requestErrorCode}from'../core/request-errors.mjs';

// One trusted UI WebContents per Host. Moving it never reloads its preview.
export function createEmbeddedWorkspace({BrowserWindow,WebContentsView,ipcMain,control,createConnection,assets,onChanged=()=>{},onNavigate=()=>{}}){
 let view=null,detached=null,connection=null,identity='',invalid=false,visible=false,destination=null,watching=new Map(),subscription=null,opening=0,openedProject;
 const edits=new Map();
 const stopHeartbeats=editScope.heartbeatEdits(edits,(path,body)=>request(path,'POST',body));
 const keys=['request','navigation','return','placement','capture-preview'];
 function assertLive(){if(invalid||!connection||scopeKey(connection.context())!==identity)throw Error('HOST_SESSION_EXPIRED')}
 function sender(e){assertLive();if(e.sender!==view?.webContents||e.senderFrame!==view.webContents.mainFrame)throw Error('STUDIO_SENDER_DENIED')}
 function layout(){if(!view||!visible||detached)return;const[w,h]=control.getContentSize();view.setBounds({x:0,y:Math.min(86,h),width:w,height:Math.max(0,h-86)})}
 async function request(raw,method='GET',body){
  assertLive();const origin=connection,originView=view,originScope=identity;const check=()=>{assertLive();if(connection!==origin||view!==originView||identity!==originScope)throw Error('HOST_SESSION_EXPIRED')};const route=studioRoute(raw,method);editScope.rememberRequest(edits,route,body);if(body&&Buffer.byteLength(JSON.stringify(body))>(/^\/api\/app-studio\/_builder\/projects\/[a-f0-9]{32}\/(build|edits(?:\/[a-f0-9]{32}\/answer)?)$/.test(route)?2*1024*1024:512*1024))throw Error('STUDIO_REQUEST_DENIED');
  const timeout=requestPolicy.requestTimeout(route,method,body)||60000;
  try{
  const r=await origin.request({path:route,method,signal:AbortSignal.timeout(timeout),...(body?{headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))}:{})});check();
  let rawBody=r.body;if(rawBody?.[Symbol.asyncIterator]){let size=0;const parts=[];for await(const b of rawBody){size+=b.length;if(size>16*1024*1024)throw Error('STUDIO_RESPONSE_TOO_LARGE');parts.push(b)}rawBody=Buffer.concat(parts)}
  const value=JSON.parse(Buffer.isBuffer(rawBody)?rawBody.toString():typeof rawBody==='string'?rawBody:JSON.stringify(rawBody));check();
  if(r.status!==200)throw Error(value.code||value.detail?.code||'STUDIO_REQUEST_FAILED');
  if(route==='/api/app-studio/context')value.scopeId=createHash('sha256').update(identity+value.scopeId).digest('hex');
  editScope.rememberEdits(edits,value);return value;
  }catch(error){check();throw Error(requestErrorCode(error))}
 }
 function hasWork(p){return p.tasks?.some(t=>['queued','running','waiting'].includes(t.state))||p.preparation?.interview?.state==='running'||p.preparation?.interview?.turns?.some(t=>t.state==='queued'&&!t.transferredTo)||p.preparation?.currentProbe?.state==='running'}
 function watch(p){if(!p?.id||watching.has(p.id)||!hasWork(p))return;
  let pending=false,idleReads=0;const timer=setInterval(async()=>{if(pending)return;pending=true;try{const next=await request('/api/app-studio/projects/'+p.id);view?.webContents.send('studio:project',next);onChanged();idleReads=hasWork(next)?0:idleReads+1;if(idleReads>=2){clearInterval(timer);watching.delete(p.id)}}catch(error){if(invalid||['HOST_SESSION_EXPIRED','STUDIO_ADMIN_REQUIRED','STUDIO_IDENTITY_FORBIDDEN','PROJECT_NOT_FOUND'].includes(error.message)){clearInterval(timer);watching.delete(p.id)}else if(view&&!view.webContents.isDestroyed())view.webContents.send('studio:connection',{state:'retrying'})}finally{pending=false}},1500);watching.set(p.id,timer);
 }
 function hide(explicit=false){if(detached){if(explicit){detached.hide();visible=false}return}if(view&&visible){control.contentView.removeChildView(view);visible=false}}
 function attach(){if(!view)return;if(detached){const old=detached;detached=null;old.contentView.removeChildView(view);visible=false;old.destroy()}if(!visible)control.contentView.addChildView(view);visible=true;layout();view.webContents.send('studio:placement',{detached:false});onNavigate('workspace');control.show()}
 function detach(){if(!view)return;if(detached){detached.show();detached.focus();visible=true;return}hide();detached=new BrowserWindow({title:'万象·开物',icon:path.join(assets,'workbench/assets/centaurai-mark.png'),width:1440,height:900,minWidth:900,minHeight:680,backgroundColor:'#faf8f4',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});detached.contentView.addChildView(view);const fit=()=>{if(detached){const[w,h]=detached.getContentSize();view.setBounds({x:0,y:0,width:w,height:h})}};detached.on('resize',fit);detached.on('close',e=>{if(!invalid){e.preventDefault();hide(true)}});fit();visible=true;view.webContents.send('studio:placement',{detached:true});detached.show();detached.focus()}
 // Ordinary client redraws must never attach, hide, or refocus a detached Builder.
 function place(action){if(action==='detach')detach();else if(action==='attach')attach();else if(action==='show'){if(!detached)attach()}else hide()}
 function invalidate(){const old=connection;editScope.stopEdits(edits,(path,body)=>old?.request({path,method:'POST',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))}));opening++;invalid=true;for(const timer of watching.values())clearInterval(timer);watching.clear();subscription?.();subscription=null;if(view&&!view.webContents.isDestroyed()){view.webContents.send('studio:invalidated');if(!detached&&visible&&!control.isDestroyed())control.contentView.removeChildView(view);view.webContents.close()}view=null;if(detached){detached.destroy();detached=null}visible=false;connection=null;destination=null;openedProject=undefined}
 async function open(input={}){
  if(input.protocolVersion!==2||input.projectId!=null&&!/^[a-f0-9]{32}$/.test(input.projectId))throw Error('STUDIO_PROJECT_INVALID');
  let turn=++opening;const c=await createConnection('ai.wanx.studio');if(turn!==opening)return{protocolVersion:1,superseded:true};const key=scopeKey(c.context());if(view&&key!==identity){invalidate();turn=++opening}
  if(!view){invalid=false;connection=c;identity=key;subscription=c.subscribe?.(event=>{if(event?.type==='invalidated'){invalidate();return}try{assertLive()}catch{invalidate()}});
   view=new WebContentsView({webPreferences:{preload:path.join(assets,'embedded-preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,backgroundThrottling:false,partition:'wanx-studio-'+randomUUID()}});
   view.webContents.session?.setPermissionRequestHandler((_wc,_permission,reply)=>reply(false));
   view.webContents.session?.setPermissionCheckHandler(()=>false);
   view.webContents.setWindowOpenHandler(()=>({action:'deny'}));view.webContents.on('will-navigate',e=>e.preventDefault());view.webContents.on('will-attach-webview',e=>e.preventDefault());
   view.webContents.on('page-title-updated',e=>{e.preventDefault();detached?.setTitle('万象·开物')});
   await view.webContents.loadFile(path.join(assets,'workbench/ui/index.html'));
  }
  if(turn!==opening)return{protocolVersion:1,superseded:true};assertLive();if(input.projectId){const p=await request('/api/app-studio/projects/'+input.projectId);watch(p)}
  if(turn!==opening)return{protocolVersion:1,superseded:true};const projectId=input.projectId||null;if(openedProject!==projectId){openedProject=projectId;destination={projectId,navigationId:randomUUID(),protocolVersion:2};view.webContents.send('studio:navigation')}detach();return{protocolVersion:1,projectId};
 }
 for(const key of keys)ipcMain.handle('studio-embedded:'+key,async(e,...args)=>{sender(e);
  if(key==='capture-preview'){const origin=view,originScope=identity;const result=await capture.capturePreview(view.webContents,view.getBounds(),args[0]);assertLive();if(view!==origin||identity!==originScope)throw Error('HOST_SESSION_EXPIRED');return result}
  if(key==='request'){const result=await request(...args);watch(result?.project||result);if(args[1]&&args[1]!=='GET')onChanged();return result}
  if(key==='navigation'){const next=destination||{projectId:null};destination=null;return next}
  if(key==='placement'){place(validatePlacement(args[0]));return{detached:Boolean(detached)}}
  const target=args[0];if(!['projects','models','connectors','skills','environment'].includes(target))throw Error('STUDIO_DESTINATION_DENIED');hide(true);onNavigate(target);control.show();control.focus?.();return{protocolVersion:2};
 });
 control.on('resize',layout);control.on('closed',invalidate);
 return{open,placement(input){place(validatePlacement(input));return{protocolVersion:1,detached:Boolean(detached),open:Boolean(view)}},close(){stopHeartbeats();invalidate();for(const key of keys)ipcMain.removeHandler('studio-embedded:'+key)}};
}
