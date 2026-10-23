import{test}from'node:test';import assert from'node:assert/strict';
import{initialWorkspace,restoreWorkspace,iterationSummary,iterationGroups}from'../ui/iteration-state.mjs';
const p=()=>({tasks:[],artifacts:[],versions:[],versioning:{iteration:null,iterations:[]}});
test('iteration default opens live work, otherwise real preview, otherwise product definition',()=>{
 assert.deepEqual(initialWorkspace(p()),{phase:'discovery',iterationPane:'plan',chatOpen:true});
 assert.equal(initialWorkspace({...p(),artifacts:[{hash:'a'}]}).phase,'product');
 assert.deepEqual(initialWorkspace({...p(),artifacts:[{hash:'a'}],tasks:[{state:'running'}]}),{phase:'discovery',iterationPane:'process',chatOpen:false});
 assert.equal(initialWorkspace({...p(),tasks:[{state:'failed'}]}).iterationPane,'plan');
});
test('restoring older workspace preferences retains independent drafts without letting polling take focus',()=>{
 const a={draft:'未发送',extra:'补充',choice:'other',feedback:'改进想法',scroll:{prd:230},phase:'versions'};
 const restored=restoreWorkspace(p(),a);assert.equal(restored.phase,'versions');assert.equal(restored.draft,a.draft);assert.equal(restored.scroll.prd,230);
 const fresh=restoreWorkspace({...p(),tasks:[{state:'running'}]});assert.equal(fresh.draft,undefined);assert.equal(fresh.phase,'discovery');
 const legacy=restoreWorkspace(p(),{phase:'execution',chatWidth:32});assert.equal(legacy.phase,'product');assert.equal(legacy.chatWidth,35);
 initialWorkspace({...p(),artifacts:[{hash:'new'}]});assert.equal(restored.phase,'versions');assert.equal(restored.feedback,a.feedback);
});
test('iteration summary does not call an adopted old preview the result of an active build',()=>{
 const project={...p(),artifacts:[{hash:'old',version:'0.1.1'}],tasks:[{state:'running'}],versioning:{iteration:{id:'i',goal:'让录入更简单',baseHash:'old'}}};
 assert.equal(iterationSummary(project).status,'正在构建');assert.equal(iterationSummary(project).hasCandidate,false);assert.equal(iterationSummary(project).base,'基于 v0.1.1');
 project.versioning.iteration.latestHash='candidate';assert.equal(iterationSummary(project).hasCandidate,true);
 assert.equal(iterationSummary(p()).title,'首次产品定义');
});
test('history groups only explicit iteration ownership; failed attempts and legacy facts remain visible',()=>{
 const project={...p(),tasks:[{id:'failed',iterationId:'i',state:'failed'},{id:'legacy'}],versions:[{hash:'new',iterationId:'i'},{hash:'old'}],versioning:{iteration:{id:'i',goal:'改进'},iterations:[{id:'older',state:'abandoned'}]}};
 const groups=iterationGroups(project);assert.equal(groups[0].tasks[0].state,'failed');assert.equal(groups[0].versions[0].hash,'new');assert.equal(groups[1].state,'abandoned');assert.equal(groups[2].state,'legacy');assert.equal(groups[2].tasks[0].id,'legacy');assert.equal(groups[2].versions[0].hash,'old');assert.equal(project.tasks.length,2);
});
