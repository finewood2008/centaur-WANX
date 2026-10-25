import{randomUUID}from'node:crypto';
// Record context before sending HTTP, so invalidation also fences late responses.
function rememberRequest(tracked,path,body){
 const m=/^\/api\/app-studio\/_builder\/projects\/([a-f0-9]{32})\/edits(?:[/?]|$)/.exec(path);if(!m)return;
 const context=body?.contextId||new URL(path,'http://studio.invalid').searchParams.get('contextId');
 if(context){const contexts=tracked.get(m[1])||new Set();contexts.add(context);tracked.set(m[1],contexts)}
}
function rememberEdits(tracked,result){
 if(!result?.project?.id||!Array.isArray(result.items))return;
 for(const e of result.items)if(e.contextId&&['queued','preparing','building','validating','clarifying'].includes(e.state))rememberRequest(tracked,`/api/app-studio/_builder/projects/${result.project.id}/edits`,{contextId:e.contextId});
}
function stopEdits(tracked,send){
 const waits=[];for(const[pid,contexts]of tracked)for(const contextId of contexts){const body={operationId:randomUUID(),contextId};try{waits.push(Promise.resolve(send(`/api/app-studio/_builder/projects/${pid}/edits/stop`,body)).catch(()=>{}))}catch{}}
 tracked.clear();return Promise.all(waits);
}
function heartbeatEdits(tracked,send,interval=15000){
 let pending=false,closed=false;
 const timer=setInterval(async()=>{if(pending||closed)return;pending=true;try{
  for(const[pid,contexts]of tracked)for(const contextId of [...contexts]){
   if(closed||tracked.get(pid)!==contexts)break;
   try{const result=await send(`/api/app-studio/_builder/projects/${pid}/edits/heartbeat`,{operationId:randomUUID(),contextId});if(!closed&&result?.active===false)contexts.delete(contextId)}catch{/* A lost connection must expire on the server. */}
  }
 }finally{pending=false}},interval);timer.unref?.();
 return()=>{closed=true;clearInterval(timer)};
}
export{rememberRequest,rememberEdits,stopEdits,heartbeatEdits};
export default{rememberRequest,rememberEdits,stopEdits,heartbeatEdits};
