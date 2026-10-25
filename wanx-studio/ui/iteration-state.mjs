// Presentation only: these helpers never create an iteration or change a version.
export function initialWorkspace(project) {
  const building=project?.tasks.some(t=>['queued','running','waiting'].includes(t.state));
  return {phase:building||!project?.artifacts.length?'discovery':'product',iterationPane:building?'process':'plan',chatOpen:!building};
}
export function restoreWorkspace(project,saved={}) {
  const next={...initialWorkspace(project),...saved};
  if(next.phase==='execution')next.phase='product';
  if(!['discovery','product','versions'].includes(next.phase))next.phase=initialWorkspace(project).phase;
  if(!['plan','process'].includes(next.iterationPane))next.iterationPane=saved.details?'process':initialWorkspace(project).iterationPane;
  if(!['split','chat','plan'].includes(next.planMode))next.planMode='split';
  next.chatWidths=Object.fromEntries(Object.entries(saved.chatWidths||{}).filter(([stage,width])=>['discuss','review','build','preview','history'].includes(stage)&&Number.isFinite(width)&&width>=0&&width<=100));
  next.mobilePane=['chat','workspace'].includes(saved.mobilePane)?saved.mobilePane:'chat';
  // Opening an active build defaults to its live process, not a stale PRD tab.
  // Ordinary project updates do not call restoreWorkspace or change user tabs.
  if(project?.tasks.some(t=>['queued','running','waiting'].includes(t.state))){
    next.phase='discovery';next.iterationPane='process';next.taskId='';next.mobilePane='workspace';
  }
  next.chatWidth=Math.max(35,Math.min(70,Number(next.chatWidth)||60));
  return next;
}
export function iterationSummary(project) {
  const iteration=project?.versioning?.iteration,task=project?.tasks.at(-1);
  const base=project?.artifacts.find(a=>a.hash===iteration?.baseHash);
  const active=task&&['running','queued','waiting'].includes(task.state);
  const interview=project?.preparation?.interview;
  const hasCandidate=Boolean(iteration?.latestHash);
  const status=interview?.state==='running'?'产品经理正在整理':task?.state==='waiting'?'等待你回答':active?'正在构建':hasCandidate?'成果待试用':iteration&&task&&['failed','cancelled','interrupted'].includes(task.state)?({failed:'本次构建未完成',cancelled:'本次构建已停止',interrupted:'本次构建已中断'})[task.state]:iteration?'正在讨论改进':project?.artifacts.length?'准备下一轮改进':'深入定义产品';
  return {title:iteration?.goal||(project?.artifacts.length?'让产品继续变得好用':'首次产品定义'),base:base?'基于 v'+base.version:iteration?.baseHash?'历史基线资料不完整':project?.artifacts.length&&!iteration?'尚未开始下一轮':'首次构建，无基线版本',status,hasCandidate,active:Boolean(active)};
}
export function iterationGroups(project) {
  const current=project.versioning?.iteration;
  const known=[...(current?[{...current,current:true}]:[]),...[...(project.versioning?.iterations||[])].reverse()];
  const groups=known.map(i=>({...i,versions:(project.versions||[]).filter(v=>v.iterationId===i.id),tasks:project.tasks.filter(t=>t.iterationId===i.id)}));
  const ids=new Set(known.map(i=>i.id));
  const versions=(project.versions||[]).filter(v=>!v.iterationId||!ids.has(v.iterationId));
  const tasks=project.tasks.filter(t=>!t.iterationId||!ids.has(t.iterationId));
  if(versions.length||tasks.length)groups.push({id:'legacy',state:'legacy',goal:'早期制作与版本',versions,tasks});
  return groups;
}
