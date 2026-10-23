import {randomUUID} from "node:crypto";
const views=new Set(['warehouses','materials','graph','search','tasks','sensitive','models','skills','reasoning','api','data']);
const fail=code=>Object.assign(new Error(code),{code});
export function createStarlinkTarget({host,service,emit,send=message=>process.send?.(message,()=>{}),launchId=process.env.WANX_HOST_LAUNCH_ID}){
  let pending=null;
  async function receive(message){
    if(message?.type!=='wanx:starlink-target'||message.launchId!==launchId||typeof message.requestId!=='string')return;
    const reply=(ok,code)=>send({type:'wanx:starlink-target-result',launchId,requestId:message.requestId,ok,code});
    try{
      const target=message.target;
      if(!target||target.kind!=='team-data'||target.version!==1||!views.has(target.view)||
         (target.warehouseId!==null&&!/^[a-f0-9-]{36}$/.test(target.warehouseId)))throw fail('TEAM_DATA_TARGET_INVALID');
      const context=await host.context();if(context.dataScope!=='team')throw fail('TEAM_DATA_CONTEXT_REQUIRED');
      if(target.warehouseId)await service.call('warehouse',{id:target.warehouseId});
      if(pending)send({type:'wanx:starlink-target-result',launchId,requestId:pending.requestId,ok:false,code:'TEAM_STARLINK_OPEN_SUPERSEDED'});
      pending={target,requestId:message.requestId};emit({type:'launch-target',...pending});
    }catch(error){reply(false,error.code||'TEAM_STARLINK_OPEN_FAILED')}
  }
  return {receive,
    async call(action,input){
      if(action==='launch-target')return pending;
      if(['team-applications','grant-team-application'].includes(action)){
        if((await host.context()).dataScope!=='team')throw fail('TEAM_DATA_CONTEXT_REQUIRED');
        const json=async(path,options)=>{const r=await host.request(path,options);if(!r.ok)throw fail('TEAM_APPLICATION_AUTHORIZATION_FAILED');return r.json()};
        const [products,projects]=await Promise.all([json('/api/admin/applications'),json('/api/app-studio/projects')]);
        const items=new Map(products.filter(p=>/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(p.application_id)).map(p=>[p.application_id,{id:p.application_id,name:p.name}]));
        for(const p of projects.projects||[])if(!items.has(p.appId))items.set(p.appId,{id:p.appId,name:p.name});
        if(action==='team-applications')return {items:[...items.values()]};
        const app=items.get(input.applicationId);
        if(!app||!input.warehouseId)throw fail('TEAM_DATA_TARGET_INVALID');
        await service.call('warehouse',{id:input.warehouseId});
        if(!products.some(p=>p.application_id===app.id))await json('/api/admin/applications',{method:'POST',body:{application_id:app.id,name:app.name,capabilities:[],agent_template:{},resource_requirements:{}}});
        const deployment=await json('/api/admin/applications/'+app.id+'/deployment');
        const grant=await service.call('create-key',{warehouseId:input.warehouseId,name:'内部应用：'+app.name.slice(0,45),days:Math.max(1,Math.min(365,Number(input.days)||30)),operationId:randomUUID()});
        try{
          await json('/api/admin/applications/'+app.id+'/deployment',{method:'PUT',body:{enabled:deployment.enabled,resource_bindings:deployment.resource_bindings||{},configuration:{...deployment.configuration,studio_team_data:{...deployment.configuration?.studio_team_data,[input.warehouseId]:{keyId:grant.key.id}}}}});
        }catch(error){await service.call('revoke-key',{warehouseId:input.warehouseId,id:grant.key.id,operationId:randomUUID()}).catch(()=>{});throw error}
        return {applicationId:app.id,warehouseId:input.warehouseId,granted:true};
      }
      if(action==='launch-target-applied'){
        if(!pending||input.requestId!==pending.requestId)throw fail('TEAM_DATA_TARGET_INVALID');
        await host.context();service.assertLive();
        send({type:'wanx:starlink-target-result',launchId,requestId:pending.requestId,ok:input.ok===true,code:input.code});pending=null;return {acknowledged:true};
      }
      throw fail('TEAM_DATA_TARGET_INVALID');
    }
  };
}
