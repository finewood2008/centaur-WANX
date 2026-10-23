import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SemanticaService} from './starlink/service.mjs';
import drive from './starlink/drive.cjs';
import {createDataShareAccess} from './data-share-service.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const ID='centaurai.wanx.semantica';
const ACTIONS=new Set(['initialize','warehouses','warehouse','create-warehouse','select-warehouse','documents','document','jobs','graph','retrieval','search','retry-job','build-index','processing','reprocess-models','select-files','select-space-files','space-list','release-files','upload']);
const VIEWS=new Set(['warehouses','materials','graph','search','tasks','sensitive','models','skills','reasoning','api','data']);
export function starlinkTarget(input={}){
  if(Object.keys(input).some(k=>!['warehouseId','view'].includes(k))||
     (input.warehouseId!=null&&!/^[a-f0-9-]{36}$/.test(input.warehouseId))||!VIEWS.has(input.view||'graph'))throw fail('TEAM_DATA_TARGET_INVALID');
  return {kind:'team-data',version:1,warehouseId:input.warehouseId||null,view:input.view||'graph'};
}
export function createTeamDataService({client,applications,selectFiles,starlinkPackageDir,writeClipboard,getMcpDetails,emit=()=>{}}){
  let service,serviceConnection,creating,scopeKey,link,share,disposed=false,scopeRevision=0;
  const key=()=>{const s=client.snapshot();return s.phase==='ready'?JSON.stringify([s.account?.accountId,s.account?.clientId,s.connection?.deviceId]):null};
  const invalidate=()=>{scopeRevision++;const old=service;service=null;serviceConnection=null;creating=null;scopeKey=null;link=null;old?.close();share?.clear();emit({type:'invalidated'})};
  const stop=client.subscribe(()=>{if(scopeKey&&scopeKey!==key())invalidate()});
  async function identity(){
    if(disposed)throw fail('TEAM_SESSION_CHANGED');
    const next=key();if(!next)throw fail('TEAM_SESSION_CHANGED');
    const connection=await client.applicationConnection('wanx');
    const response=await connection.request({path:'/api/auth/me'});
    if(next!==key())throw fail('TEAM_SESSION_CHANGED');
    if(response.status!==200){invalidate();throw fail('TEAM_LOGIN_EXPIRED')}
    const me=JSON.parse(response.body.toString('utf8'));
    if(me.role!=='admin'||me.application_id!=='wanx'){invalidate();throw fail('TEAM_ADMIN_REQUIRED')}
    if(scopeKey&&scopeKey!==next)invalidate();
    scopeKey=next;link=connection;return {connection,me,next};
  }
  async function connection(target){
    const {connection:base,me,next}=await identity();
    const assertLive=()=>{base.context();if(next!==key())throw fail('TEAM_SESSION_CHANGED')};
    return {...base,context:()=>{assertLive();return {...base.context(),user:me,dataScope:'team',starlinkTarget:target||null}},
      async request(input){
        assertLive();await identity();assertLive();
        const headers={...input.headers};delete headers['x-wanx-data-context'];
        if(/^\/api\/semantica\//.test(input.path)&&!input.path.startsWith('/api/semantica/open/'))headers['x-wanx-data-context']='team';
        const result=await base.request({...input,headers});assertLive();return result;
      }};
  }
  async function instance(){
    await identity();
    if(service){
      try{service.assertLive();serviceConnection.context();return service}
      catch{invalidate();await identity()}
    }
    if(creating)return creating;
    const version=scopeRevision;
    const pending=(async()=>{
      const base=await connection();
      if(version!==scopeRevision)throw fail('TEAM_SESSION_CHANGED');
      let candidate;
      const host={context:async()=>base.context(),
        // Platform subscribe emits health/directory snapshots too. Only a dead
        // captured connection invalidates this service, never a healthy snapshot.
        onSessionInvalidated:notify=>base.subscribe(()=>{
          try{base.context();return}catch{}
          if(service===candidate)invalidate();
          notify({type:'invalidated',code:'HOST_SESSION_EXPIRED'});
        }),close(){},
        async request(path,options={}){
          let {body,headers={},method='GET'}=options;
          if(body!=null&&!(body instanceof Uint8Array)){body=Buffer.from(JSON.stringify(body));headers={...headers,'content-type':'application/json'}}
          const r=await base.request({path,method,headers,...(body!=null?{body}:{})});
          return new Response(r.body.length?r.body:null,{status:r.status,headers:r.headers});
        }};
      host.drive=drive.createDriveClient(host);
      candidate=new SemanticaService({host,selectFiles,emit});
      try{candidate.context=base.context();candidate.assertLive();if(version!==scopeRevision)throw fail('TEAM_SESSION_CHANGED')}
      catch(error){candidate.close();throw error}
      service=candidate;serviceConnection=base;return candidate;
    })();
    creating=pending;
    try{return await pending}finally{if(creating===pending)creating=null}
  }
  share=createDataShareAccess({identity,instance,writeClipboard,getMcpDetails});
  return {connection,
    async action(action,input={}){
      if(action==='release-share-key')return share.action(action,input);
      await identity();
      if(share.supports(action))return share.action(action,input);
      if(action==='install-starlink'){
        if(!starlinkPackageDir)throw fail('TEAM_STARLINK_NOT_INSTALLED');
        const temporary=await mkdtemp(path.join(os.tmpdir(),'wanx-starlink-'));
        async function materialize(source,target){
          await mkdir(target,{recursive:true});
          for(const entry of await readdir(source,{withFileTypes:true})){
            const from=path.join(source,entry.name),to=path.join(target,entry.name);
            if(entry.isDirectory())await materialize(from,to);
            else if(entry.isFile())await writeFile(to,await readFile(from),{flag:'wx'});
            else throw fail('TEAM_STARLINK_PACKAGE_INVALID');
          }
        }
        try{await materialize(starlinkPackageDir,path.join(temporary,'package'));await identity();const installed=await applications.install({sourceDir:path.join(temporary,'package')});await identity();return installed}
        finally{await rm(temporary,{recursive:true,force:true})}
      }
      if(action==='open-starlink'){
        const target=starlinkTarget(input);
        if(target.warehouseId)await (await instance()).call('warehouse',{id:target.warehouseId});
        const installed=(await applications.listInstalled()).find(a=>a.applicationId===ID);
        if(!installed)throw fail('TEAM_STARLINK_NOT_INSTALLED');
        return applications.launch({applicationId:ID,launchContext:target});
      }
      if(!ACTIONS.has(action))throw fail('TEAM_DATA_ACTION_DENIED');
      if(action==='create-warehouse')input={name:input.name,description:input.description||'',operationId:randomUUID()};
      if(['retry-job','build-index'].includes(action))input={...input,operationId:randomUUID()};
      const active=await instance();
      if(['select-files','select-space-files','upload'].includes(action)&&!active.capabilities)active.capabilities=await active.api('/capabilities');
      return active.call(action,input);
    },
    close(){disposed=true;stop();invalidate()}
  };
}
