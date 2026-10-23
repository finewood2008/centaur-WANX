import{test}from'node:test';import assert from'node:assert/strict';import{builderJourney}from'../ui/builder-journey-state.mjs';
const base=()=>({solutionHash:'p',solution:{prd:{}},readiness:{ready:true},confirmation:null,tasks:[],artifacts:[],versioning:{iteration:null}});
test('new users begin with a concrete work story; intake never claims plan confirmation',()=>{
 assert.equal(builderJourney(null).step,0);assert.equal(builderJourney({...base(),preparation:{phase:'intake',interview:{}}}).step,0);
 assert.equal(builderJourney(base()).step,1);
 assert.equal(builderJourney({...base(),readiness:{ready:false,missing:['flow']}}).step,0);
});
test('running or failed interviews remain in discussion despite previously confirmed output',()=>{
 const p={...base(),confirmation:{hash:'p'},tasks:[{id:'t',state:'completed'}],artifacts:[{hash:'a',taskId:'t',solutionHash:'p'}]};
 for(const state of ['running','failed'])assert.equal(builderJourney({...p,preparation:{phase:'acp',interview:{state}}}).step,0);
});
test('live, waiting and failed builds never announce a new trial or adopted success',()=>{
 for(const state of ['running','queued','waiting','failed','cancelled','interrupted']){
  const p={...base(),confirmation:{hash:'p'},tasks:[{id:'t',state}],artifacts:[{hash:'a',taskId:'t',solutionHash:'p'}]};
  assert.equal(builderJourney(p).step,2);
 }
});
test('trial and adoption require the completed current task and current confirmed plan',()=>{
 const p={...base(),confirmation:{hash:'p'},tasks:[{id:'t',state:'completed'}],artifacts:[{hash:'a',taskId:'t',solutionHash:'p'}]};
 assert.equal(builderJourney(p).step,3);assert.equal(builderJourney({...p,versioning:{adoptedHash:'a'}}).step,4);
 assert.equal(builderJourney({...p,solutionHash:'new'}).step,1);
 assert.equal(builderJourney({...p,tasks:[{id:'new',state:'completed'}]}).step,1);
 assert.equal(builderJourney({...p,versioning:{iteration:{latestHash:'other'}}}).step,1);
});
test('adopting an earlier candidate still shows adopted after the iteration ends',()=>{
 const p={...base(),confirmation:{hash:'p'},tasks:[{id:'first',state:'completed'},{id:'latest',state:'completed'}],artifacts:[{hash:'chosen',taskId:'first',solutionHash:'p'},{hash:'other',taskId:'latest',solutionHash:'p'}],versioning:{iteration:null,adoptedHash:'chosen'}};
 assert.equal(builderJourney(p).step,4);
 assert.equal(builderJourney({...p,versioning:{...p.versioning,iteration:{id:'next'}}}).step,1);
 assert.equal(builderJourney({...p,confirmation:null}).step,1);
});
