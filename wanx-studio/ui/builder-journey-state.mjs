// Explain the current step; this never confirms a plan or starts work.
export function builderJourney(project) {
 const task=project?.tasks.at(-1),interview=project?.preparation?.interview;
 const confirmed=Boolean(project?.solutionHash&&project.confirmation?.hash===project.solutionHash);
 const iteration=project?.versioning?.iteration;
 const adopted=project?.artifacts.find(a=>a.hash===project.versioning?.adoptedHash);
 const artifact=project?.artifacts.find(a=>a.taskId===task?.id&&a.solutionHash===project.solutionHash&&(!iteration||a.hash===iteration.latestHash));
 let step=0,title='先聊一次真实的工作经历',detail='告诉我谁遇到了什么困难，以及你希望事情变成什么样。';
 if(project?.preparation?.phase==='intake')detail='先讲清目标，再选择背景资料，交给产品经理一起完善方案。';
 else if(interview?.state==='running'){title='正在把你的想法整理成方案';detail='你已经说过的内容会保留，整理完成后再继续回答。'}
 else if(interview?.state==='failed'||interview?.sync==='failed'){title='这一轮整理还没有完成';detail='原话已经保留。请重试本轮整理，或检查资料与能力。'}
 else if(task&&['queued','running','waiting'].includes(task.state)){
  step=2;title=task.state==='waiting'?'制作需要你补充信息':task.state==='queued'?'正在准备制作':'正在按确认的方案制作';
  detail=task.state==='waiting'?'在制作过程中查看具体问题，再补充回答。':'完成后先试用，你可以继续提出改进意见。';
 }else if(!iteration&&confirmed&&adopted?.solutionHash===project?.solutionHash&&project?.tasks.find(t=>t.id===adopted.taskId)?.state==='completed'){
  step=4;title='这个版本已由你采用';detail='可回到万象导出，也可以记录下一轮改进。';
 }else if(confirmed&&artifact&&task?.state==='completed'){
  step=project.versioning?.adoptedHash===artifact.hash?4:3;
  title=step===4?'这个版本已由你采用':'成果已准备好，先用一用';
  detail=step===4?'可回到万象导出，也可以记录下一轮改进。':'按真实业务走一遍，确认好用后再采用；需要调整就记录意见。';
 }else if(task&&['failed','cancelled','interrupted'].includes(task.state)&&confirmed){step=2;title='本次制作尚未完成';detail='方案和已有记录仍保留。查看原因后，再决定如何继续。'}
 else if(project?.solution?.prd&&(confirmed||project.readiness?.ready)&&project?.preparation?.phase!=='intake'){
  step=1;title=confirmed?'方案已确认，可以开始制作':'一起核对产品方案';
  detail=confirmed?'检查所需能力后开始制作，已有确认会保留。':'逐节核对目标、流程和页面；有不合适的地方，继续用自己的话修改。';
 }
 return {step,title,detail,steps:['聊清想法','核对方案','制作产品','亲自试用','采用版本']};
}
