// Presentation policy only: switching a work surface never starts model work.
export function workbenchStage(project,view){
 const task=project?.tasks.at(-1),running=task&&['queued','running','waiting'].includes(task.state);
 if(view.phase==='versions')return 'history';
 if(view.phase==='product')return 'preview';
 if(view.iterationPane==='process')return 'build';
 return !project?.preparation||project.preparation.phase==='intake'||!project.readiness?.ready&&!project.confirmation?'discuss':'review';
}
export function workbenchWidth(stage,widths={},containerWidth=1440){
 const automatic={discuss:60,review:47,build:35,preview:32,history:34}[stage]||47;
 const value=Number(widths[stage])||automatic;
 // Both panes remain usable in the native client's 900px minimum window.
 const low=Math.max(25,320/containerWidth*100),high=Math.min(70,(1-350/containerWidth)*100);
 return Math.max(low,Math.min(high,value));
}
export function turnStatus(project,message){
 return project?.preparation?.interview?.turns.find(t=>t.operationId===message.operationId);
}
