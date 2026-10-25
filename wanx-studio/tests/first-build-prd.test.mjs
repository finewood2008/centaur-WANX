import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productQuestions,questionAnswers} from '../ui/question-batch-state.mjs';
import {prdDocumentHtml,embeddedPrdHtml} from '../ui/prd-document.mjs';
import {meetingProject} from './fixtures/meeting-prd.mjs';

const message={id:'round1',role:'assistant',questions:[
 {id:'q1',text:'先支持哪种场景？',options:['例会（推荐）｜频率高，便于验证','客户会｜需要更多背景']},
 {id:'q2',text:'怎样保存？',options:['核对后保存（推荐）｜避免误写','只看草稿｜不保存']},
 {id:'q3',text:'重点是什么？',options:['纪要与行动项（推荐）｜覆盖下一步','仅纪要｜范围较小']}
]};
test('a batch never preselects recommendations or accepts an unanswered other choice',()=>{
 const qs=productQuestions({artifacts:[]},message);
 assert.equal(qs.length,3);assert.equal(qs[0].choices[0].recommended,true);
 assert.equal(questionAnswers(qs).canSend,false);
 const answers={q1:{choice:qs[0].choices[1].value},q2:{choice:qs[1].choices[0].value},q3:{choice:'other'}};
 assert.equal(questionAnswers(qs,answers).canSend,false);
 answers.q3.extra='还希望单独列出关键决定';
 const result=questionAnswers(qs,answers);
 assert.equal(result.answered,3);assert.equal(result.canSend,true);
 assert.match(result.text,/客户会/);assert.match(result.text,/还希望单独列出关键决定/);
 assert.doesNotMatch(result.text,/我的选择：例会/);
 answers.q1.extra='未选中的其他想法';
 assert.doesNotMatch(questionAnswers(qs,answers).text,/未选中的其他想法/);
});
test('free-form clarification preserves undecided questions and rounds have independent drafts',()=>{
 const qs=productQuestions({artifacts:[]},message);
 const result=questionAnswers(qs,{q1:{choice:qs[0].choices[0].value}},'第二题我还想讨论');
 assert.equal(result.canSend,true);assert.equal(result.complete,false);
 assert.equal((result.text.match(/本题暂未决定/g)||[]).length,2);
 const next=productQuestions({artifacts:[]},{...message,id:'round2',questions:message.questions.map(q=>({...q,id:q.id+'next'}))});
 assert.equal(questionAnswers(next,{q1:{choice:qs[0].choices[0].value}}).answered,0);
 assert.deepEqual(productQuestions({artifacts:[{}]},message),[]);
 assert.deepEqual(productQuestions({artifacts:[]},{role:'user',questions:message.questions}),[]);
});
test('HTML PRD retains every chapter, page, flow step, field and acceptance case',()=>{
 const p=meetingProject();const html=prdDocumentHtml(p,{ready:true,contract:{collections:{meetings:{title:'string'}}}});
 for(const id of ['goal','flow','scope','pages','data','rules','acceptance']){
  assert.match(html,new RegExp('id="'+id+'"'));assert.match(html,new RegExp('href="#'+id+'"'));
 }
 for(const x of [...p.solution.prd.pages.map(p=>p.name),...p.solution.prd.scenarios[0].steps,...p.solution.prd.dataFields.map(f=>f.description),...p.solution.prd.tests.map(t=>t.then)])assert.ok(html.includes(x),x);
 assert.match(html,/<details><summary>接口、数据保存与访问范围/);
 assert.match(html,/成稿待确认/);assert.match(html,/@media\(max-width:720px\)/);assert.match(html,/@media print/);
 assert.doesNotMatch(html,/<script|<iframe|<form|https?:\/\//i);
 assert.match(html,/default-src 'none'/);
 const many=meetingProject();many.solution.prd.tests=Array.from({length:41},(_,i)=>({title:'验收'+i,given:'准备'+i,when:'操作'+i,then:'结果'+i}));
 assert.match(prdDocumentHtml(many),/结果40/);
});
test('untrusted PRD text cannot inject HTML, script, CSS or document links',()=>{
 const p=meetingProject();p.name='<img src=x onerror=alert(1)>';p.originalGoal='</details><script>alert(1)</script>';
 p.solution.prd.pages[0].blocks[0].kind='"><img src=x>';
 p.solution.prd.rules.push('</style><script>injected</script>');
 const html=prdDocumentHtml(p);
 assert.doesNotMatch(html,/<script|<img|onerror="/i);
 assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);
 p.solution.capabilities=['reports','knowledge'];
 assert.match(prdDocumentHtml(p),/私有报告按本人隔离/);
});


test('embedded chapters stay in srcdoc while downloaded HTML keeps portable anchors',()=>{
 const html=prdDocumentHtml(meetingProject());const embedded=embeddedPrdHtml(html);
 assert.match(embedded,/href="about:srcdoc#flow"/);assert.match(embedded,/href="about:srcdoc#screen-1"/);
 assert.doesNotMatch(embedded,/href="#/);assert.match(html,/href="#flow"/);
});
