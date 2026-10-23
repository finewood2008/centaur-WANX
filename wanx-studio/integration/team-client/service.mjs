import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeMiniappPackage} from '../../core/package.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const integer=v=>Number.isSafeInteger(v)&&v>0;
export function createTeamService({client,applications,assets}){
  async function session(){
    const link=await client.applicationConnection('wanx');
    const c=link.context();
    const request=async(route,method='GET',body)=>{
      link.context();const r=await link.request({path:route,method,...(body?{headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(body))}:{})});link.context();
      if(r.body.length>8*1024*1024)throw fail('TEAM_RESPONSE_TOO_LARGE');
      let value;try{value=r.body.length?JSON.parse(r.body.toString('utf8')):null}catch{throw fail('TEAM_RESPONSE_INVALID')}
      if(r.status<200||r.status>=300){const code=typeof value?.code==='string'&&/^[A-Z_]+$/.test(value.code)?value.code:[401,403].includes(r.status)?'TEAM_PERMISSION_DENIED':r.status===404?'TEAM_SERVICE_UNAVAILABLE':'TEAM_REQUEST_FAILED';throw Object.assign(fail(code),{status:r.status})}return value;
    };
    const me=await request('/api/auth/me');
    if(!integer(me.id)||me.id!==c.user.id||me.application_id!=='wanx'||typeof me.role!=='string')throw fail('TEAM_IDENTITY_INVALID');
    return {request,link,me};
  }
  const identity=me=>({id:me.id,username:me.username,displayName:me.display_name||me.username,role:me.role==='admin'?'admin':'user'});
  async function ready(s){const c=await s.request('/api/app-studio/context');if(c.features?.teamPublishing!==1)throw fail('TEAM_PUBLISHING_UNAVAILABLE')}
  async function catalog(s){
    await ready(s);
    if(s.me.role!=='admin')return (await s.request('/api/app-studio/projects')).projects;
    const products=await s.request('/api/admin/applications'),items=[];
    for(const product of products.filter(p=>/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(p.application_id))){
      const deployment=await s.request('/api/admin/applications/'+product.application_id+'/deployment');
      const p=deployment.configuration?.studio_team;if(p)items.push({id:p.projectId,appId:product.application_id,name:product.name,installed:{artifactHash:p.artifactHash},enabled:deployment.enabled,audience:p.audience});
    }return items;
  }
  return {async action(operation,input={}){
    if(operation==='login')return client.teamLogin(input);
    if(operation==='join')return client.teamJoin(input);
    const s=await session();
    if(operation==='identity')return identity(s.me);
    if(operation==='catalog')return catalog(s);
    if(operation==='open'){
      await ready(s);
      if(!/^[a-f0-9]{32}$/.test(input.projectId)||!/^[a-f0-9]{64}$/.test(input.artifactHash))throw fail('TEAM_INPUT_INVALID');
      const payload=await s.request(`/api/app-studio/projects/${input.projectId}/install/${input.artifactHash}`);
      // Always reauthorize with this member's own JWT; never reuse an administrator runtime.
      const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-team-app-'));
      try{await writeMiniappPackage(payload,directory,{assets});s.link.context();const existing=(await applications.listInstalled()).find(p=>p.applicationId===payload.applicationId);if(existing?.version===payload.version){const record=JSON.parse(await readFile(path.join(existing.installPath,'miniapp.runtime.json'),'utf8'));if(record.artifactHash!==payload.artifactHash)throw fail('TEAM_ARTIFACT_MISMATCH')}else await applications.install({sourceDir:directory});s.link.context();return await applications.launch(payload.applicationId)}finally{await rm(directory,{recursive:true,force:true})}
    }
    if(s.me.role!=='admin')throw fail('TEAM_ADMIN_REQUIRED');
    if(operation==='members')return s.request('/api/users');
    if(operation==='invites')return s.request('/api/users/invites');
    if(operation==='invite.create')return s.request('/api/users/invites','POST',{note:String(input.note||'团队成员').slice(0,200),expires_in_days:7,role:'user'});
    if(operation==='invite.revoke'){if(!integer(input.id))throw fail('TEAM_INPUT_INVALID');return s.request('/api/users/invites/'+input.id+'/revoke','POST')}
    if(operation==='member.update'){
      if(!integer(input.id)||input.id===s.me.id||Object.keys(input).some(k=>!['id','disabled','role'].includes(k)))throw fail('TEAM_INPUT_INVALID');
      const body={};if('disabled'in input){if(typeof input.disabled!=='boolean')throw fail('TEAM_INPUT_INVALID');body.disabled=input.disabled}
      if('role'in input){if(!['admin','user'].includes(input.role))throw fail('TEAM_INPUT_INVALID');body.role=input.role}
      if(!Object.keys(body).length)throw fail('TEAM_INPUT_INVALID');return s.request('/api/users/'+input.id,'PATCH',body);
    }
    if(operation==='projects'){await ready(s);return (await s.request('/api/app-studio/projects')).projects}
    if(operation==='publish'){
      await ready(s);
      if(!/^[a-f0-9]{32}$/.test(input.projectId)||!/^[a-f0-9]{64}$/.test(input.artifactHash)||!['all','selected'].includes(input.audience))throw fail('TEAM_INPUT_INVALID');
      const payload=await s.request(`/api/app-studio/projects/${input.projectId}/install/${input.artifactHash}`),id=payload.applicationId;
      const members=await s.request('/api/users');const selected=[...new Set(input.members||[])];
      if(input.audience==='selected'&&(!selected.length||selected.some(id=>!integer(id)||!members.some(m=>m.id===id&&!m.disabled))))throw fail('TEAM_MEMBERS_REQUIRED');
      let product;try{product=await s.request('/api/admin/applications/'+id)}catch(e){if(e.status!==404)throw e;product=await s.request('/api/admin/applications','POST',{application_id:id,name:payload.name,description:'团队内部应用',capabilities:[],agent_template:{},resource_requirements:{}})}
      if(product.created_by!==s.me.id)throw fail('TEAM_PUBLISHER_MISMATCH');
      const previous=await s.request('/api/admin/applications/'+id+'/deployment');
      const deployment={enabled:false,resource_bindings:previous.resource_bindings||{},configuration:{...previous.configuration,studio_team:{projectId:input.projectId,artifactHash:input.artifactHash,audience:input.audience}}};
      await s.request('/api/admin/applications/'+id+'/deployment','PUT',deployment);
      if(input.audience==='selected')for(const member of members.filter(m=>!m.disabled))await s.request('/api/admin/applications/'+id+'/access','PUT',{user_id:member.id,enabled:selected.includes(member.id)||member.id===s.me.id});
      await s.request(`/api/app-studio/projects/${input.projectId}/installed`,'POST',{operationId:randomUUID(),artifactHash:payload.artifactHash,applicationId:id,version:payload.version});
      await s.request('/api/admin/applications/'+id+'/deployment','PUT',{...deployment,enabled:true});
      return {applicationId:id,version:payload.version,published:true};
    }
    if(operation==='unpublish'){
      if(!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(input.applicationId))throw fail('TEAM_INPUT_INVALID');const route='/api/admin/applications/'+input.applicationId+'/deployment';const p=await s.request(route);if(!p.configuration?.studio_team)throw fail('TEAM_APPLICATION_UNAVAILABLE');return s.request(route,'PUT',{enabled:false,resource_bindings:p.resource_bindings,configuration:p.configuration});
    }
    if(operation==='access'){
      if(!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(input.applicationId)||!integer(input.userId)||typeof input.enabled!=='boolean')throw fail('TEAM_INPUT_INVALID');return s.request('/api/admin/applications/'+input.applicationId+'/access','PUT',{user_id:input.userId,enabled:input.enabled});
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
        if((await team.identity()).role!=='admin')throw fail('TEAM_ADMIN_REQUIRED');
      }
      if(client.isTeamDirect()&&/^wanx-client:(wallet-|panel-balance|profile-|change-password|send-change-code|support-)/.test(name))throw fail('TEAM_PLATFORM_ACCOUNT_REQUIRED');
      return handler(event,...args);
    });
  }});
}
