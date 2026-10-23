import{isSupplementChoice}from'./interview-options.mjs';
// Keep unsent text visible as replies add, remove or replace answer choices.
export function conversationInput(value,options){
 if(!options.length){const text=value.draft||value.extra;return {choice:'',text,answer:text}}
 const previous=isSupplementChoice(value.choice)?'other':value.choice;
 const choice=options.includes(previous)?previous:value.draft||value.extra?'other':'';
 const text=choice==='other'?value.extra||value.draft:'';
 return {choice,text,answer:choice==='other'?text:choice};
}
/** Safe text runs: formatting never turns model/user text into HTML. */
export function conversationParagraphs(text){
 return String(text||'').split(/\n\s*\n/).filter(Boolean).map(paragraph=>paragraph.split(/(\*\*[^*\n]+\*\*)/g).filter(Boolean).map(value=>({text:value.startsWith('**')&&value.endsWith('**')?value.slice(2,-2):value,bold:value.startsWith('**')&&value.endsWith('**')})));
}
export function conversationFollows(scrollTop,scrollHeight,clientHeight){return scrollHeight-scrollTop-clientHeight<96}
export function conversationStatus(preparation){
 if(!preparation)return '边聊边整理完整方案';
 if(preparation.phase==='intake')return '任务助手 · 背景尚未交接';
 const s=preparation.interview;
 if(s.state==='running')return '正在理解和整理…';
 if(s.state==='failed'||s.sync==='failed')return '本轮尚未同步，请重试';
 return s.sync==='saved'?'产品方案已保存':'等待继续整理';
}

export function conversationMessages(project){
 if(!project)return [];
 const intake=project.preparation?.messages||[];
 if(project.preparation?.phase==='intake')return intake;
 if(!intake.length)return project.messages;
 return [...intake.map(m=>({...m,author:m.role==='assistant'?'任务助手':'你'})),...project.messages.filter(m=>!(m.role==='user'&&m.text===project.originalGoal))];
}
