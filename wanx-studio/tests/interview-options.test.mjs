import{test}from'node:test';import assert from'node:assert/strict';
import{interviewChoices,isSupplementChoice}from'../ui/interview-options.mjs';

test('saved model alternatives share one canonical free-text entry',()=>{
 const options=['只列未完成事项的负责人','列出所有负责人','其他，我再补充','其他，我来补充'];
 assert.deepEqual(interviewChoices(options),[
  {value:options[0],label:options[0]},{value:options[1],label:options[1]},
  {value:'other',label:'其他，我来补充'}
 ]);
 assert.equal(options.length,4);
});
test('ordinary answers retain their text and generic variants open the supplement input',()=>{
 for(const value of ['其他','其它（请说明）',' 其他，我再补充 ','Other: specify','other'])assert.equal(isSupplementChoice(value),true);
 const business='其他负责人的事项也显示';
 assert.equal(isSupplementChoice(business),false);
 assert.deepEqual(interviewChoices([business]),[{value:business,label:business},{value:'other',label:'其他，我来补充'}]);
});
test('no pending choices keeps the normal text composer',()=>{
 assert.deepEqual(interviewChoices([]),[]);
 assert.deepEqual(interviewChoices(['其他']),[{value:'other',label:'其他，我来补充'}]);
});
