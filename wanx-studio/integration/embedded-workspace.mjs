import path from'node:path';
import{randomUUID,createHash}from'node:crypto';
import{studioRoute,scopeKey,validatePlacement}from'./workspace-policy.mjs';

// One trusted UI WebContents per Host. Moving it never reloads its preview.
export function createEmbeddedWorkspace({BrowserWindow,WebContentsView,ipcMain,control,createConnection,assets,onChanged=()=>{},onNavigate=()=>{}}){
 let view=null,detached=null,connection=null,identity='',invalid=false,visible=false,destination=null,watching=new Map(),subscription=null,opening=0,openedProject;
 const keys=['request','navigation','return','placement'];
 function assertLive(){if(invalid||!connection||scopeKey(connection.context())!==identity)throw Error('HOST_SESSION_EXPIRED')}
 function sender(e){assertLive();if(e.sender!==view?.webContents||e.senderFrame!==view.webContents.mainFrame)throw Error('STUDIO_SENDER_DENIED')}
 function layout(){if(!view||!visible||detached)return;const[w,h]=control.getContentSize();view.setBounds({x:0,y:Math.min(86,h),width:w,height:Math.max(0,h-86)})}
 async function request(raw,method='GET',body){
  assertLive();const origin=connection,originView=view,originScope=identity;const check=()=>{assertLive();if(connection!==origin||view!==originView||identity!==originScope)throw Error('HOST_SESSION_EXPIRED')};const route=studioRoute(raw,method);if(body&&Buffer.byteLength(JSON.stringify(body))>512*1024)throw Error('STUDIO_REQUEST_DENIED');
  const timeout=route.endsWith('/invoke')&&body?.method==='model.generate'?210000:route.endsWith('/chat')||route.endsWith('/interview/start')?390000:route.endsWith('/intake')||route.endsWith('/capabilities/check')?240000:route==='/api/app-studio/preflight'?60000:60000;
  const r=await origin.request({path:route,method,signal:AbortSignal.timeout(timeout),...(body?{headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))}:{})});check();
  let rawBody=r.body;if(rawBody?.[Symbol.asyncIterator]){let size=0;const parts=[];for await(const b of rawBody){size+=b.length;if(size>16*1024*1024)throw Error('STUDIO_RESPONSE_TOO_LARGE');parts.push(b)}rawBody=Buffer.concat(parts)}
  const value=JSON.parse(Buffer.isBuffer(rawBody)?rawBody.toString():typeof rawBody==='string'?rawBody:JSON.stringify(rawBody));check();
  if(r.status!==200)throw Error(value.code||value.detail?.code||'STUDIO_REQUEST_FAILED');
  if(route==='/api/app-studio/context')value.scopeId=createHash('sha256').update(identity+value.scopeId).digest('hex');
  return value;
 }
 function watch(p){if(!p?.id||watching.has(p.id))return;if(!p.tasks?.some(t=>['queued','running','waiting'].includes(t.state))&&p.preparation?.interview?.state!=='running')return;
  let pending=false;const timer=setInterval(async()=>{if(pending)return;pending=true;try{const next=await request('/api/app-studio/projects/'+p.id);view?.webContents.send('studio:project',next);onChanged();if(!next.tasks.some(t=>['queued','running','waiting'].includes(t.state))&&next.preparation?.interview?.state!=='running'){clearInterval(timer);watching.delete(p.id)}}catch{clearInterval(timer);watching.delete(p.id)}finally{pending=false}},1500);watching.set(p.id,timer);
 }
 function hide(explicit=false){if(detached){if(explicit){detached.hide();visible=false}return}if(view&&visible){control.contentView.removeChildView(view);visible=false}}
 function attach(){if(!view)return;if(detached){const old=detached;detached=null;old.contentView.removeChildView(view);visible=false;old.destroy()}if(!visible)control.contentView.addChildView(view);visible=true;layout();view.webContents.send('studio:placement',{detached:false});onNavigate('workspace');control.show()}
 function detach(){if(!view)return;if(detached){detached.show();detached.focus();visible=true;return}hide();detached=new BrowserWindow({title:'半人马AI-万象Builder',icon:path.join(assets,'workbench/assets/centaurai-mark.png'),width:1440,height:900,minWidth:900,minHeight:680,backgroundColor:'#faf8f4',webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});detached.contentView.addChildView(view);const fit=()=>{if(detached){const[w,h]=detached.getContentSize();view.setBounds({x:0,y:0,width:w,height:h})}};detached.on('resize',fit);detached.on('close',e=>{if(!invalid){e.preventDefault();hide(true)}});fit();visible=true;view.webContents.send('studio:placement',{detached:true});detached.show();detached.focus()}
 // Ordinary client redraws must never attach, hide, or refocus a detached Builder.
 function place(action){if(action==='detach')detach();else if(action==='attach')attach();else if(action==='show'){if(!detached)attach()}else hide()}
 function invalidate(){opening++;invalid=true;for(const timer of watching.values())clearInterval(timer);watching.clear();subscription?.();subscription=null;if(view&&!view.webContents.isDestroyed()){view.webContents.send('studio:invalidated');if(!detached&&visible&&!control.isDestroyed())control.contentView.removeChildView(view);view.webContents.close()}view=null;if(detached){detached.destroy();detached=null}visible=false;connection=null;destination=null;openedProject=undefined}
 async function open(input={}){
  if(input.protocolVersion!==2||input.projectId!=null&&!/^[a-f0-9]{32}$/.test(input.projectId))throw Error('STUDIO_PROJECT_INVALID');
  let turn=++opening;const c=await createConnection('ai.wanx.studio');if(turn!==opening)return{protocolVersion:1,superseded:true};const key=scopeKey(c.context());if(view&&key!==identity){invalidate();turn=++opening}
  if(!view){invalid=false;connection=c;identity=key;subscription=c.subscribe?.(event=>{if(event?.type==='invalidated'){invalidate();return}try{assertLive()}catch{invalidate()}});
   view=new WebContentsView({webPreferences:{preload:path.join(assets,'embedded-preload.cjs'),sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,backgroundThrottling:false,partition:'wanx-studio-'+randomUUID()}});
   view.webContents.session?.setPermissionRequestHandler((_wc,_permission,reply)=>reply(false));
   view.webContents.session?.setPermissionCheckHandler(()=>false);
   view.webContents.setWindowOpenHandler(()=>({action:'deny'}));view.webContents.on('will-navigate',e=>e.preventDefault());view.webContents.on('will-attach-webview',e=>e.preventDefault());
   view.webContents.on('page-title-updated',e=>{e.preventDefault();detached?.setTitle('半人马AI-万象Builder')});
   await view.webContents.loadFile(path.join(assets,'workbench/ui/index.html'));
  }
  if(turn!==opening)return{protocolVersion:1,superseded:true};assertLive();if(input.projectId){const p=await request('/api/app-studio/projects/'+input.projectId);watch(p)}
  if(turn!==opening)return{protocolVersion:1,superseded:true};const projectId=input.projectId||null;if(openedProject!==projectId){openedProject=projectId;destination={projectId,navigationId:randomUUID(),protocolVersion:2};view.webContents.send('studio:navigation')}detach();return{protocolVersion:1,projectId};
 }
 for(const key of keys)ipcMain.handle('studio-embedded:'+key,async(e,...args)=>{sender(e);
  if(key==='request'){const result=await request(...args);watch(result);if(args[1]&&args[1]!=='GET')onChanged();return result}
  if(key==='navigation'){const next=destination||{projectId:null};destination=null;return next}
  if(key==='placement'){place(validatePlacement(args[0]));return{detached:Boolean(detached)}}
  const target=args[0];if(!['projects','models','connectors','skills','environment'].includes(target))throw Error('STUDIO_DESTINATION_DENIED');hide(true);onNavigate(target);control.show();control.focus?.();return{protocolVersion:2};
 });
 control.on('resize',layout);control.on('closed',invalidate);
 return{open,placement(input){place(validatePlacement(input));return{protocolVersion:1,detached:Boolean(detached),open:Boolean(view)}},close(){invalidate();for(const key of keys)ipcMain.removeHandler('studio-embedded:'+key)}};
}
