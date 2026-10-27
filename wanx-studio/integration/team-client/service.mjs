import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeMiniappPackage} from '../../core/package.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const integer=v=>Number.isSafeInteger(v)&&v>0;
const membershipDigest=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))return false;const decoded=Buffer.from(value,'base64url');return decoded.length===32&&decoded.toString('base64url')===value};
const nativeMemberId=value=>integer(Number(value))&&String(Number(value))===String(value);
export function createTeamService({client,applications,assets,deviceTrust,openDeviceTrust,identitySecurityEnabled=true}){
  const secure=identitySecurityEnabled!==false;
  const nativeContext=c=>{const state=client.snapshot();if(c.protocolVersion!==1||c.authorization!=null||c.dataIdentity||!integer(c.user?.id)||state.account?.phase!=='authenticated'||!['ready','recovering'].includes(state.phase)||!c.accountId||!c.clientId||!c.boxId||c.accountId!==state.account.accountId||c.clientId!==state.account.clientId||c.boxId!==state.connection?.deviceId)throw fail('TEAM_IDENTITY_INVALID')};
  const nativeMember=member=>({...member,membershipId:String(member.id),subject:member.display_name||member.username,roleId:member.role==='admin'?'manager':'member',status:member.disabled?'disabled':'active'});
  const pendingTeamReads=new Map();
  const teamState=s=>{const context=s.link.context(),key=JSON.stringify([context.boxId,context.principalId,context.dataIdentity?.bindingId,context.dataIdentity?.generation]);let pending=pendingTeamReads.get(key);if(!pending){pending=deviceTrust.refreshTeam({boxId:s.me.team.boxId}).finally(()=>{if(pendingTeamReads.get(key)===pending)pendingTeamReads.delete(key)});pendingTeamReads.set(key,pending)}return pending};
  async function session(){
    const link=await client.applicationConnection(secure?undefined:'wanx');
    const c=link.context();
    if(!secure)nativeContext(c);
    const request=async(route,method='GET',body,resource)=>{
      if(!secure)nativeContext(link.context());else link.context();const r=await link.request({path:route,method,headers:{...(body?{'content-type':'application/json'}:{}),...(secure&&resource?{'x-wanx-data-context':resource}:{})},...(body?{body:Buffer.from(JSON.stringify(body))}:{})});if(!secure)nativeContext(link.context());else link.context();
      if(r.body.length>8*1024*1024)throw fail('TEAM_RESPONSE_TOO_LARGE');
      let value;try{value=r.body.length?JSON.parse(r.body.toString('utf8')):null}catch{throw fail('TEAM_RESPONSE_INVALID')}
      if(r.status<200||r.status>=300){const code=typeof value?.code==='string'&&/^[A-Z_]+$/.test(value.code)?value.code:[401,403].includes(r.status)?'TEAM_PERMISSION_DENIED':r.status===404?'TEAM_SERVICE_UNAVAILABLE':'TEAM_REQUEST_FAILED';throw Object.assign(fail(code),{status:r.status})}return value;
    };
    const me=await request('/api/auth/me');
    if(!integer(me.id)||me.id!==c.user?.id||me.application_id!=='wanx'||(secure?(me.role!=='user'||c.authorization!=='local-trust-v1'||!me.team||me.team.principalId!==c.principalId||!Array.isArray(me.team.permissions)):!['admin','user'].includes(me.role)))throw fail('TEAM_IDENTITY_INVALID');
    return {request,link,me};
  }
  const manages=me=>secure?me.team.permissions.includes('applications.manage'):me.role==='admin';
  const identity=me=>secure?({membershipId:me.team.membershipId,principalId:me.team.principalId,username:me.username,displayName:me.display_name||me.username,roleId:me.team.roleId,permissions:[...me.team.permissions]}):({id:me.id,membershipId:String(me.id),username:me.username,displayName:me.display_name||me.username,roleId:me.role==='admin'?'manager':'member',permissions:me.role==='admin'?['applications.manage','members.read','resources.manage']:[]});
  const directory=async s=>{if(!secure)return (await s.request('/api/users')).map(nativeMember);if(!s.me.team.permissions.includes('members.read'))throw fail('TEAM_PERMISSION_DENIED');return (await teamState(s)).members};
  async function ready(s){const c=await s.request('/api/app-studio/context');if(c.features?.teamPublishing!==1)throw fail('TEAM_PUBLISHING_UNAVAILABLE')}
  async function catalog(s){
    if(!manages(s.me)){
      if(!secure){await ready(s);return (await s.request('/api/app-studio/projects')).projects}
      const items=[];for(const grant of s.link.context().dataIdentity?.grants||[]){
        const match=/^team:application:(ai\.wanx\.selfmade\.[a-f0-9]{32})$/.exec(grant.resourceId);if(!match||!grant.actions.includes('read'))continue;
        const item=await s.request('/api/app-studio/apps/'+match[1],'GET',undefined,grant.resourceId);
        if(item?.project)items.push({...item.project,appId:match[1]});
      }return items;
    }
    await ready(s);
    const products=await s.request('/api/admin/applications'),items=[];
    for(const product of products.filter(p=>/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(p.application_id))){
      const deployment=await s.request('/api/admin/applications/'+product.application_id+'/deployment');
      const p=deployment.configuration?.studio_team;if(p)items.push({id:p.projectId,appId:product.application_id,name:product.name,installed:{artifactHash:p.artifactHash},enabled:deployment.enabled,audience:p.audience});
    }return items;
  }
  async function publication(s,input){
    await ready(s);if(!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(input.applicationId))throw fail('TEAM_INPUT_INVALID');
    const route='/api/admin/applications/'+input.applicationId;
    const product=await s.request(route),deployment=await s.request(route+'/deployment');
    if(!deployment.configuration?.studio_team)throw fail('TEAM_APPLICATION_UNAVAILABLE');
    return {route,product,deployment};
  }
  function audienceMembers(input,members){
    const selected=[...new Set((input.members||[]).map(id=>secure?id:String(id)))];
    if(!['all','selected'].includes(input.audience)||input.audience==='selected'&&(!selected.length||selected.some(id=>!(secure?membershipDigest(id):nativeMemberId(id))||!members.some(m=>m.membershipId===id&&m.status==='active'))))throw fail('TEAM_MEMBERS_REQUIRED');
    return selected;
  }
  async function writeAudience(s,route,input,members,selected){
    for(const member of members.filter(m=>m.status==='active'))await s.request(route+'/access','PUT',{...(secure?{membership_id:member.membershipId}:{user_id:member.id}),enabled:input.audience==='all'||selected.includes(member.membershipId)||member.membershipId===identity(s.me).membershipId});
  }
  return {async action(operation,input={}){
    if(secure&&['join','security','invite.create','invite.revoke','member.update'].includes(operation)){if(!openDeviceTrust)throw fail('LOCAL_TRUST_UNAVAILABLE');await openDeviceTrust({view:'team'});return {opened:true}}
    if(['login','join','security'].includes(operation))throw fail('TEAM_CLOUD_LOGIN_REQUIRED');
    const s=await session();
    if(operation==='identity')return identity(s.me);
    if(operation==='catalog')return catalog(s);
    if(operation==='open'){
      if(!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(input.applicationId)||!/^[a-f0-9]{64}$/.test(input.artifactHash))throw fail('TEAM_INPUT_INVALID');
      const payload=await s.request('/api/app-studio/apps/'+input.applicationId+'/install','GET',undefined,'team:application:'+input.applicationId);
      if(payload.applicationId!==input.applicationId||payload.artifactHash!==input.artifactHash)throw fail('TEAM_ARTIFACT_MISMATCH');
      // Each launch derives this member's locally approved binding and exact grants.
      const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-team-app-'));
      try{await writeMiniappPackage(payload,directory,{assets});s.link.context();const existing=(await applications.listInstalled()).find(p=>p.applicationId===payload.applicationId);if(existing?.version===payload.version){const record=JSON.parse(await readFile(path.join(existing.installPath,'miniapp.runtime.json'),'utf8'));if(record.artifactHash!==payload.artifactHash)throw fail('TEAM_ARTIFACT_MISMATCH')}else await applications.install({sourceDir:directory});s.link.context();return await applications.launch(payload.applicationId)}finally{await rm(directory,{recursive:true,force:true})}
    }
    if(!manages(s.me))throw fail('TEAM_ADMIN_REQUIRED');
    if(operation==='members')return directory(s);
    if(operation==='invites')return secure?(await teamState(s)).invitations:(await s.request('/api/users/invites')).map(invite=>({...invite,invitationId:String(invite.id),roleId:'member'}));
    if(!secure&&operation==='invite.create')return s.request('/api/users/invites','POST',{note:String(input.note||'团队成员').slice(0,200),expires_in_days:7,role:'user'});
    if(!secure&&operation==='invite.revoke'){if(!integer(input.id))throw fail('TEAM_INPUT_INVALID');return s.request('/api/users/invites/'+input.id+'/revoke','POST')}
    if(!secure&&operation==='member.update'){
      if(!integer(input.id)||input.id===s.me.id||Object.keys(input).some(k=>!['id','disabled','role'].includes(k)))throw fail('TEAM_INPUT_INVALID');
      const body={};if('disabled'in input){if(typeof input.disabled!=='boolean')throw fail('TEAM_INPUT_INVALID');body.disabled=input.disabled}
      if('role'in input){if(!['admin','user'].includes(input.role))throw fail('TEAM_INPUT_INVALID');body.role=input.role}
      if(!Object.keys(body).length)throw fail('TEAM_INPUT_INVALID');return s.request('/api/users/'+input.id,'PATCH',body);
    }
    if(operation==='publication'){
      const {route,product,deployment}=await publication(s,input),access=await s.request(route+'/access');
      const p=deployment.configuration.studio_team;
      return {applicationId:input.applicationId,artifactHash:p.artifactHash,audience:p.audience,enabled:deployment.enabled,canPublish:product.created_by===s.me.id,members:access.filter(a=>a.enabled).map(a=>secure?a.membership_id:String(a.user_id))};
    }
    if(operation==='publication-audience'){
      const {route,product,deployment}=await publication(s,input);
      if(product.created_by!==s.me.id)throw fail('TEAM_PUBLISHER_MISMATCH');
      if(input.artifactHash!==deployment.configuration.studio_team.artifactHash)throw fail('TEAM_PUBLICATION_CHANGED');
      let payload;try{payload=await s.request(`/api/app-studio/projects/${deployment.configuration.studio_team.projectId}/install/${input.artifactHash}`)}catch(e){if(['USER_ADOPTION_REQUIRED','USER_ACCEPTANCE_REQUIRED'].includes(e.code))throw fail('TEAM_SCOPE_REQUIRES_CURRENT');throw e}
      const members=await directory(s),selected=audienceMembers(input,members);
      const next={enabled:false,resource_bindings:deployment.resource_bindings||{},configuration:{...deployment.configuration,studio_team:{...deployment.configuration.studio_team,audience:input.audience}}};
      await s.request(route+'/deployment','PUT',next);
      await writeAudience(s,route,input,members,selected);
      await s.request(`/api/app-studio/projects/${deployment.configuration.studio_team.projectId}/installed`,'POST',{operationId:randomUUID(),artifactHash:payload.artifactHash,applicationId:input.applicationId,version:payload.version});
      return s.request(route+'/deployment','PUT',{...next,enabled:deployment.enabled});
    }
    if(operation==='projects'){await ready(s);return (await s.request('/api/app-studio/projects')).projects}
    if(operation==='publish'){
      await ready(s);
      if(!/^[a-f0-9]{32}$/.test(input.projectId)||!/^[a-f0-9]{64}$/.test(input.artifactHash)||!['all','selected'].includes(input.audience))throw fail('TEAM_INPUT_INVALID');
      const payload=await s.request(`/api/app-studio/projects/${input.projectId}/install/${input.artifactHash}`),id=payload.applicationId;
      const members=await directory(s),selected=audienceMembers(input,members);
      let product;try{product=await s.request('/api/admin/applications/'+id)}catch(e){if(e.status!==404)throw e;product=await s.request('/api/admin/applications','POST',{application_id:id,name:payload.name,description:'团队内部应用',capabilities:[],agent_template:{},resource_requirements:{}})}
      if(product.created_by!==s.me.id)throw fail('TEAM_PUBLISHER_MISMATCH');
      const previous=await s.request('/api/admin/applications/'+id+'/deployment');
      const deployment={enabled:false,resource_bindings:previous.resource_bindings||{},configuration:{...previous.configuration,studio_team:{projectId:input.projectId,artifactHash:input.artifactHash,audience:input.audience}}};
      await s.request('/api/admin/applications/'+id+'/deployment','PUT',deployment);
      await writeAudience(s,'/api/admin/applications/'+id,input,members,selected);
      await s.request(`/api/app-studio/projects/${input.projectId}/installed`,'POST',{operationId:randomUUID(),artifactHash:payload.artifactHash,applicationId:id,version:payload.version});
      await s.request('/api/admin/applications/'+id+'/deployment','PUT',{...deployment,enabled:true});
      return {applicationId:id,version:payload.version,published:true};
    }
    if(operation==='unpublish'){
      if(!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(input.applicationId))throw fail('TEAM_INPUT_INVALID');const route='/api/admin/applications/'+input.applicationId+'/deployment';const p=await s.request(route);if(!p.configuration?.studio_team)throw fail('TEAM_APPLICATION_UNAVAILABLE');return s.request(route,'PUT',{enabled:false,resource_bindings:p.resource_bindings,configuration:p.configuration});
    }
    if(operation==='access'){
      if(!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(input.applicationId)||!(secure?membershipDigest(input.membershipId):integer(input.userId))||typeof input.enabled!=='boolean')throw fail('TEAM_INPUT_INVALID');return s.request('/api/admin/applications/'+input.applicationId+'/access','PUT',{...(secure?{membership_id:input.membershipId}:{user_id:input.userId}),enabled:input.enabled});
    }
    throw fail('TEAM_OPERATION_DENIED');
  },identity:async()=>identity((await session()).me)};
}

export function registerTeamIPC({ipcMain,isTrusted,team}){
  ipcMain.handle('wanx-client:team',async(event,input)=>{
    if(!isTrusted(event)||!input||Object.keys(input).some(k=>!['operation','input'].includes(k)))throw fail('TEAM_ORIGIN_DENIED');
    try{return await team.action(input.operation,input.input)}catch(e){throw fail(/^[A-Z][A-Z0-9_]+$/.test(e.code||e.message)?e.code||e.message:'TEAM_REQUEST_FAILED')}
  });
}
export function guardTeamIPC({ipcMain,client,team,isTrusted}){
  return new Proxy(ipcMain,{get(target,key){
    if(key!=='handle')return typeof target[key]==='function'?target[key].bind(target):target[key];
    return(name,handler)=>target.handle(name,async(event,...args)=>{
      if(/^wanx-client:(studio-|builder-|maintenance-open)/.test(name)){
        if(!isTrusted(event))throw fail('TEAM_ORIGIN_DENIED');
        if(!(await team.identity()).permissions.includes('applications.manage'))throw fail('TEAM_ADMIN_REQUIRED');
      }
      if(client.isTeamDirect()&&/^wanx-client:(wallet-|panel-balance|profile-|change-password|send-change-code|support-)/.test(name))throw fail('TEAM_PLATFORM_ACCOUNT_REQUIRED');
      return handler(event,...args);
    });
  }});
}
