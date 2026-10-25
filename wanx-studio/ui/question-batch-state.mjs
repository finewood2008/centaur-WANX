import {interviewChoices} from './interview-options.mjs';

export function productQuestions(project,last){
 if(project?.artifacts?.length||last?.role!=='assistant')return [];
 return (last.questions||[]).slice(0,3).map((q,i)=>({...q,id:q.id||last.id+':'+i,choices:interviewChoices(q.options)}));
}

export function questionAnswers(questions,answers={},extra=''){
 let answered=0;
 const rows=questions.map((q,i)=>{
  const value=answers[q.id]||{};
  const choice=q.choices.find(item=>item.value===value.choice);
  const text=choice?.value==='other'?(value.extra||'').trim():choice?.value||'';
  if(text)answered++;
  return `${i+1}. ${q.text}\n${text?'我的选择：'+text:'本题暂未决定'}`;
 });
 const complete=answered===questions.length&&questions.length>0;
 return {answered,total:questions.length,complete,canSend:complete||Boolean(extra.trim()),text:[...rows,...(extra.trim()?['整体补充：'+extra.trim()]:[])].join('\n\n')};
}
