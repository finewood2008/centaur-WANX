import{test}from'node:test';import assert from'node:assert/strict';
import{initialPhase,previewArtifact,canAcceptArtifact,confirmAndStart}from'../ui/workspace-state.mjs';
const p=()=>({id:'a',stage:'discovery',solutionHash:'s',confirmation:null,tasks:[],artifacts:[]});
test('default phase follows actual tasks; polling does not own a manually selected phase',()=>{assert.equal(initialPhase(p()),'discovery');assert.equal(initialPhase({...p(),stage:'adopted',artifacts:[{hash:'h'}]}),'product');const v={phase:'discovery',draft:'未发送',extra:'补充',feedback:'修改'};const completed={...p(),tasks:[{id:'t',state:'completed'}]};initialPhase(completed);assert.deepEqual(v,{phase:'discovery',draft:'未发送',extra:'补充',feedback:'修改'})});
test('new tasks never show older artifacts; explicit record selection can show historical preview',()=>{const project={...p(),tasks:[{id:'old',state:'completed'},{id:'new',state:'running'}],artifacts:[{hash:'old',taskId:'old'}]};assert.equal(previewArtifact(project),null);assert.equal(previewArtifact(project,'old').hash,'old');assert.equal(canAcceptArtifact(project,previewArtifact(project,'old')),false)});
test('one explicit action confirms then starts; a partial failure preserves confirmation and does not auto retry',async()=>{const calls=[],ids={confirm:'c',build:'b'};let frozen;const request=async(path,method,body)=>{calls.push({path,body});if(path.endsWith('/confirm'))return{...p(),confirmation:{hash:'s'}};throw new Error('START_FAILED')};await assert.rejects(()=>confirmAndStart(p(),['goal'],ids,request,p=>frozen=p),/START_FAILED/);assert.equal(frozen.confirmation.hash,'s');assert.equal(calls.length,2);await assert.rejects(()=>confirmAndStart(frozen,[],ids,request,()=>assert.fail()),/START_FAILED/);assert.equal(calls.length,3);assert.equal(calls.at(-1).body.operationId,'b')});
test('only latest completed task bound to confirmed solution can be accepted',()=>{const a={hash:'h',taskId:'t',solutionHash:'s'};const project={...p(),confirmation:{hash:'s'},tasks:[{id:'t',state:'completed'}],artifacts:[a]};assert.equal(canAcceptArtifact(project,a),true);assert.equal(canAcceptArtifact({...project,solutionHash:'changed'},a),false);assert.equal(canAcceptArtifact({...project,tasks:[{id:'next',state:'waiting'}]},a),false)});

test('current product preview stays pinned while new output becomes available',async()=>{
 const{selectedVersion,canAdoptVersion}=await import('../ui/workspace-state.mjs');
 const old={hash:'old',taskId:'a',solutionHash:'s'},next={hash:'next',taskId:'b',solutionHash:'s'};
 const project={...p(),confirmation:{hash:'s'},artifacts:[old,next],tasks:[{id:'a',state:'completed'},{id:'b',state:'completed'}],versioning:{adoptedHash:'old',iteration:{id:'i',baseHash:'old',latestHash:'next'}},versions:[{hash:'next',status:'trial'}]};
 assert.equal(selectedVersion(project).hash,'next');assert.equal(selectedVersion(project,'old').hash,'old');
 assert.equal(canAdoptVersion(project,next),true);assert.equal(canAdoptVersion(project,old),true);
 const draft={...project,solutionHash:'changed'};assert.equal(canAdoptVersion(draft,next),true);
});

test('user may choose an earlier successful candidate from this iteration and frozen plan',async()=>{
 const{canAdoptVersion}=await import('../ui/workspace-state.mjs');
 const first={hash:'first',taskId:'a',solutionHash:'s'},next={hash:'next',taskId:'b',solutionHash:'s'};
 const project={...p(),confirmation:{hash:'s'},artifacts:[first,next],tasks:[{id:'a',state:'completed'},{id:'b',state:'completed'}],versioning:{iteration:{id:'i',latestHash:'next'}},versions:[{hash:'first',status:'trial'},{hash:'next',status:'trial'}]};
 assert.equal(canAdoptVersion(project,first),true);assert.equal(canAdoptVersion(project,next),true);
 assert.equal(canAdoptVersion({...project,solutionHash:'changed'},first),true);
 assert.equal(canAdoptVersion({...project,versions:[{hash:'first',status:'historical'}]},first),true);
 assert.equal(canAdoptVersion({...project,tasks:[{id:'a',state:'failed'},{id:'b',state:'completed'}]},first),false);
 assert.equal(canAdoptVersion({...project,tasks:[...project.tasks,{id:'c',state:'running'}]},first),false);
});
