export function redact(value,taskRoot=''){
  if(typeof value==='string')return value.replaceAll(taskRoot||'\0','<任务目录>').replace(/\bsk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[凭据已隐藏]');
  if(Array.isArray(value))return value.map(v=>redact(v,taskRoot));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:authorization|api.?key|access.?token|refresh.?token|secret)/i.test(k)).map(([k,v])=>[k,redact(v,taskRoot)]));
  return value;
}
export function activity(update,taskRoot){
  const kind=update.sessionUpdate;
  if(kind==='agent_thought_chunk'||kind==='usage_update'||kind==='available_commands_update')return null;
  if(kind==='agent_message_chunk')return update.content?.type==='text'?{type:'message',text:redact(update.content.text,taskRoot)}:null;
  if(kind==='plan')return {type:'plan',text:'Codex 更新了开发计划',entries:redact(update.entries,taskRoot)};
  if(kind==='tool_call'||kind==='tool_call_update')return {type:'activity',text:redact(update.title||'工具执行进展',taskRoot),...redact(update,taskRoot)};
  return null;
}
