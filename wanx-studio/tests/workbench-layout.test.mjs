import{test}from'node:test';import assert from'node:assert/strict';
import{workbenchStage,workbenchWidth,turnStatus}from'../ui/workbench-layout.mjs';
import{restoreWorkspace}from'../ui/iteration-state.mjs';
test('conversation gets room in discovery and product gets room in preview, each phase keeps its own manual width',()=>{
 const discovery=workbenchWidth('discuss'),review=workbenchWidth('review'),build=workbenchWidth('build'),preview=workbenchWidth('preview');
 assert(discovery>review&&review>build&&build>preview);
 const widths={preview:42};assert.equal(workbenchWidth('preview',widths),42);assert.equal(workbenchWidth('discuss',widths),discovery);
 assert.equal(workbenchWidth('preview',{preview:0}),preview);
 for(const width of [900,1024,1440])for(const stage of ['discuss','review','build','preview','history']){
  for(const n of [-900,0,40,10000]){const percent=workbenchWidth(stage,{[stage]:n},width);assert(percent*width/100>=320);assert((100-percent)*width/100>=350-1e-6)}
 }
});
test('working surface selection does not depend on a completed artifact and stored layouts are scoped presentation only',()=>{
 const p={tasks:[],artifacts:[],preparation:{phase:'acp',interview:{turns:[]}},readiness:{ready:false}};
 assert.equal(workbenchStage(p,{phase:'discovery',iterationPane:'plan'}),'discuss');
 p.readiness.ready=true;assert.equal(workbenchStage(p,{phase:'discovery',iterationPane:'plan'}),'review');
 assert.equal(workbenchStage(p,{phase:'discovery',iterationPane:'process'}),'build');
 assert.equal(workbenchStage(p,{phase:'product'}),'preview');
 assert.equal(workbenchStage(p,{phase:'versions'}),'history');
 const original=JSON.stringify(p),restored=restoreWorkspace(p,{chatWidths:{preview:42,build:Infinity,unknown:50},mobilePane:'workspace'});
 assert.deepEqual(restored.chatWidths,{preview:42});assert.equal(restored.mobilePane,'workspace');assert.equal(JSON.stringify(p),original);
});
test('delivery state belongs to the actual operation, including queued and paused messages',()=>{
 const p={preparation:{interview:{turns:[{operationId:'one',state:'completed'},{operationId:'two',state:'queued'}]}}};
 assert.equal(turnStatus(p,{operationId:'two'}).state,'queued');assert.equal(turnStatus(p,{operationId:'missing'}),undefined);
});
