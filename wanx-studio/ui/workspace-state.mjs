// Pure presentation policy. Authority remains in the WANX service.
export function initialPhase(project) {
  return project.artifacts.length || project.tasks.length ? 'product' : 'discovery';
}
export function previewArtifact(project, selectedTaskId = '') {
  const task = project.tasks.find(t => t.id === selectedTaskId) || project.tasks.at(-1);
  return task ? project.artifacts.find(a => a.taskId === task.id) || null : null;
}
export function canAcceptArtifact(project, artifact) {
  return Boolean(artifact && project.artifacts.at(-1)?.hash === artifact.hash &&
    project.tasks.at(-1)?.id === artifact.taskId && !project.tasks.some(t => ['running','waiting','queued'].includes(t.state)) &&
    artifact.solutionHash === project.solutionHash && project.confirmation?.hash === project.solutionHash);
}
export async function confirmAndStart(project, sections, ids, request, onConfirmed) {
  let frozen = project;
  if (project.confirmation?.hash !== project.solutionHash) {
    frozen = await request(`/projects/${project.id}/confirm`, 'POST', {operationId:ids.confirm,solutionHash:project.solutionHash,reviewedSections:sections});
    onConfirmed(frozen);
  }
  return request(`/projects/${project.id}/build`, 'POST', {operationId:ids.build,solutionHash:frozen.solutionHash,instruction:ids.instruction || ''});
}

export function selectedVersion(project, hash='') {
  if(hash)return project.artifacts.find(a=>a.hash===hash)||null;
  const it=project.versioning?.iteration;
  return project.artifacts.find(a=>a.hash===it?.latestHash)||project.artifacts.find(a=>a.hash===project.versioning?.adoptedHash)||project.artifacts.at(-1)||null;
}
export function canAdoptVersion(project, artifact) {
  const it=project.versioning?.iteration;
  return Boolean(artifact && !project.preparation?.interview?.turns?.some(t=>['queued','paused'].includes(t.state)) && project.tasks.find(t=>t.id===artifact.taskId)?.state==='completed' && !project.tasks.some(t=>['running','waiting','queued'].includes(t.state)) && project.preparation?.interview?.state!=='running' && artifact.solutionHash===project.solutionHash && project.confirmation?.hash===project.solutionHash && (it ? project.versions?.find(v=>v.hash===artifact.hash)?.status==='trial' : project.tasks.at(-1)?.id===artifact.taskId));
}
