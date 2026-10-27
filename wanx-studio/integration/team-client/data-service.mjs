import {assistantAwareTeamDataService} from './assistant-team-data-addon.mjs';
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
function createBaseTeamDataService({client,applications,selectFiles,starlinkPackageDir,writeClipboard,getMcpDetails,knowledgeCapabilities,identitySecurityEnabled=true,emit=()=>{}}){
  const secure=identitySecurityEnabled!==false;
  let service,serviceConnection,creating,scopeKey,link,share,disposed=false,scopeRevision=0,selectedWarehouse=null;
  const key=()=>{const s=client.snapshot();return s.phase==='ready'?JSON.stringify(secure?[s.dataIdentity?.profileId,s.dataIdentity?.generation,s.dataIdentity?.selected?.principalId,s.dataIdentity?.selected?.bindingId,s.connection?.deviceId]:[s.account?.accountId,s.account?.clientId,s.connection?.deviceId]):null};
  const invalidate=()=>{scopeRevision++;const old=service;service=null;serviceConnection=null;creating=null;scopeKey=null;link=null;selectedWarehouse=null;old?.close();share?.clear();emit({type:'invalidated'})};
  const stop=client.subscribe(()=>{if(scopeKey&&scopeKey!==key())invalidate()});
  async function identity(){
    if(disposed)throw fail('TEAM_SESSION_CHANGED');
    const next=key();if(!next)throw fail('TEAM_SESSION_CHANGED');
    const connection=await client.applicationConnection(secure?undefined:'wanx');
    const context=connection.context(),state=client.snapshot();
    if(!secure&&(context.protocolVersion!==1||context.authorization!=null||context.dataIdentity||state.account?.phase!=='authenticated'||!context.accountId||!context.clientId||!context.boxId||context.accountId!==state.account.accountId||context.clientId!==state.account.clientId||context.boxId!==state.connection?.deviceId)){invalidate();throw fail('TEAM_IDENTITY_INVALID')}
    const response=await connection.request({path:'/api/auth/me'});
    if(next!==key())throw fail('TEAM_SESSION_CHANGED');
    if(response.status!==200){invalidate();throw fail('TEAM_LOGIN_EXPIRED')}
    const me=JSON.parse(response.body.toString('utf8'));
    if(secure?(!me.team?.permissions?.includes('resources.manage')||me.role!=='user'||me.application_id!=='wanx'||connection.context().authorization!=='local-trust-v1'):(me.role!=='admin'||me.application_id!=='wanx'||!Number.isSafeInteger(me.id)||me.id<=0||me.id!==context.user?.id)){invalidate();throw fail('TEAM_ADMIN_REQUIRED')}
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
        if(!secure&&/^\/api\/semantica\//.test(input.path)&&!input.path.startsWith('/api/semantica/open/'))headers['x-wanx-data-context']='team';
        if(secure&&/^\/api\/semantica\//.test(input.path)&&!input.path.startsWith('/api/semantica/open/')) {
          const url=new URL(input.path,'https://local.invalid');
          let bodyWarehouse=null; if(input.body instanceof Uint8Array && input.body.byteLength<=1048576 && Object.entries(headers).some(([name,value])=>name.toLowerCase()==='content-type'&&value==='application/json')){try{bodyWarehouse=JSON.parse(Buffer.from(input.body).toString('utf8')).warehouse_id||null}catch{throw fail('TEAM_DATA_REQUEST_INVALID')}}
          const warehouse=/^\/api\/semantica\/warehouses\/([a-f0-9-]{36})(?:\/|$)/.exec(url.pathname)?.[1] || url.searchParams.get('warehouse_id') || bodyWarehouse || target?.warehouseId || selectedWarehouse;
          if(warehouse){
            const resource='team:knowledge:'+warehouse;
            if(!base.context().dataIdentity?.grants?.some(grant=>grant.resourceId===resource))throw fail('TEAM_RESOURCE_APPROVAL_REQUIRED');
            headers['x-wanx-data-context']=resource;
          } else if(!['/api/semantica/capabilities','/api/semantica/health'].includes(url.pathname))throw fail('TEAM_RESOURCE_SELECTION_REQUIRED');
        }
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
  share=createDataShareAccess({identity,instance,writeClipboard,getMcpDetails,knowledgeCapabilities,identitySecurityEnabled});
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
      if(action==='select-warehouse'){if(input.warehouseId&&!/^[a-f0-9-]{36}$/.test(input.warehouseId))throw fail('TEAM_DATA_TARGET_INVALID');selectedWarehouse=input.warehouseId||null}
      if(secure&&action==='warehouses'){
        const {connection:link}=await identity();const grants=link.context().dataIdentity?.grants||[];const items=[];
        for(const grant of grants.filter(row=>/^team:knowledge:[a-f0-9-]{36}$/.test(row.resourceId))){
          const scope=await connection({warehouseId:grant.resourceId.slice('team:knowledge:'.length)});
          const response=await scope.request({path:'/api/semantica/warehouses'});
          if(response.status!==200)throw fail('TEAM_DATA_REQUEST_FAILED');const result=JSON.parse(response.body.toString('utf8'));
          if(!Array.isArray(result.items))throw fail('TEAM_DATA_RESPONSE_INVALID');items.push(...result.items);
        }return {items};
      }
      if(!secure&&action==='create-warehouse')input={name:input.name,description:input.description||'',operationId:randomUUID()};
      if(secure&&action==='create-warehouse'){
        const {connection:current}=await identity();let candidate=null;
        for(const grant of current.context().dataIdentity?.grants||[]){
          if(!/^team:knowledge:[a-f0-9-]{36}$/.test(grant.resourceId)||!grant.actions.includes('write'))continue;
          const warehouseId=grant.resourceId.slice('team:knowledge:'.length),scope=await connection({warehouseId});
          const response=await scope.request({path:'/api/semantica/warehouses'});
          if(response.status!==200)throw fail('TEAM_DATA_REQUEST_FAILED');
          let result;try{result=JSON.parse(response.body.toString('utf8'))}catch{throw fail('TEAM_DATA_RESPONSE_INVALID')}
          if(!Array.isArray(result.items))throw fail('TEAM_DATA_RESPONSE_INVALID');
          if(result.items.length===0){candidate=warehouseId;break}
        }
        if(!candidate)throw fail('TEAM_RESOURCE_APPROVAL_REQUIRED');
        selectedWarehouse=candidate;input={name:input.name,description:input.description||'',operationId:randomUUID()};
      }
      if(['retry-job','build-index'].includes(action))input={...input,operationId:randomUUID()};
      const active=await instance();
      if(['select-files','select-space-files','upload'].includes(action)&&!active.capabilities)active.capabilities=await active.api('/capabilities');
      return active.call(action,input);
    },
    close(){disposed=true;stop();invalidate()}
  };
}

export const createTeamDataService=options=>assistantAwareTeamDataService(createBaseTeamDataService,options);
