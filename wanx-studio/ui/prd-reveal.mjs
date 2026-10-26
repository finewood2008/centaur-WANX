// Reveal persisted text only; the canonical PRD never contains partial strings.
export function revealText(previous,next,progress){
  const before=Array.from(previous),after=Array.from(next);let prefix=0;
  while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
  const count=prefix+Math.ceil((after.length-prefix)*Math.max(0,Math.min(1,progress)));
  return after.slice(0,count).join('');
}
export function revealDuration(previous,next){
  return Math.min(1800,Math.max(360,Array.from(next).length*12));
}
export function canReviewPrd(project,{active=false,reason='',proposalReady=true}={}){
  const s=project.preparation?.interview;
  const settled=!s||s.state==='completed'||(s.state==='idle'&&s.turns?.length&&s.turns.every(t=>t.state==='completed'));
  return Boolean(project.readiness?.ready&&project.solution?.prd&&proposalReady&&!active&&!reason&&
    (!s||(settled&&s.sync==='saved'&&!s.turns?.some(t=>['queued','paused','running'].includes(t.state)))));
}
