/** @type {Record<string,string>} */
export const editLabels={queued:'等待接续',preparing:'理解修改',clarifying:'等待你的选择',building:'正在修改',validating:'正在验证',completed:'已完成',discussed:'已讨论，尚未修改',no_change:'无需重复修改',failed:'本轮未完成',interrupted:'已中断，可继续',cancelled:'已停止'};
export function activeEdit(state){return state?.items.find(e=>['preparing','building','validating'].includes(e.state))||null}
export function waitingEdit(state){return state?.items.find(e=>e.state==='clarifying')||null}
export function editDelivery(state,message){return state?.items.find(e=>e.sourceOperations.includes(message.operationId))||null}
export function autoPreview(previous,next,view,dirty){
 const newest=next?.artifacts.at(-1);if(!newest||previous?.id!==next?.id||previous?.artifacts.at(-1)?.hash===newest.hash||view.followLatest===false||view.phase==='versions')return null;
 return{hash:newest.hash,needsConfirmation:Boolean(dirty)};
}
export function editJourney(state){
 const running=activeEdit(state),waiting=waitingEdit(state),last=state?.items.at(-1);
 return{steps:['提出修改','修改与验证','查看结果'],step:running?running.state==='preparing'?0:1:waiting?0:2,title:editLabels[(running||waiting||last)?.state]||'直接说出你想改的地方',detail:waiting?.question?.why||'在左侧直接发送修改，完成后自动显示新版；旧版始终保留。'};
}
export function iterationMessage(text,mode='modify',visualText=''){
 const content=[text.trim(),visualText.trim()].filter(Boolean).join('\n\n');
 return content&&mode==='discuss'?'先讨论，不修改代码或生成新版本：\n'+content:content;
}
export function migrateFeedback(draft,feedback){
 const old=(feedback||'').trim();
 return old&&!draft.includes(old)?[draft,old].filter(Boolean).join('\n\n'):draft;
}
