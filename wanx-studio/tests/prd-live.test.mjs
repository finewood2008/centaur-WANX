import {test} from 'node:test';
import assert from 'node:assert/strict';
import {revealText,revealDuration,canReviewPrd} from '../ui/prd-reveal.mjs';

test('saved prose reveals from the shared prefix and converges to the latest revision',()=>{
 assert.equal(revealText('保存草稿','保存并预览草稿',0),'保存');
 assert.equal(revealText('保存草稿','保存并预览草稿',1),'保存并预览草稿');
 const partial=revealText('原方案','新方案第一轮',.4);
 assert.equal(revealText(partial,'新方案第二轮',1),'新方案第二轮');
 assert.equal(revealText('要删除的内容','',.2),'');
 assert.equal(revealText('保留原文','保留原文',0),'保留原文');
 assert.equal(revealText('😀内容','😃新内容',0),'');
 assert.ok(revealDuration('', '长'.repeat(20000))<=1800);
});
test('full PRD and development actions require a finished, synchronized, complete conversation',()=>{
 const p={solution:{prd:{}},readiness:{ready:true},preparation:{interview:{state:'completed',sync:'saved',turns:[{state:'completed'}]}}};
 assert.equal(canReviewPrd(p),true);
 assert.equal(canReviewPrd(p,{active:true}),false);
 assert.equal(canReviewPrd(p,{proposalReady:false}),false);
 assert.equal(canReviewPrd(p,{reason:'等待检查'}),false);
 for(const [state,sync] of [['running','saved'],['failed','saved'],['completed','pending']])assert.equal(canReviewPrd({...p,preparation:{interview:{state,sync,turns:[]}}}),false);
 for(const state of ['queued','paused','running'])assert.equal(canReviewPrd({...p,preparation:{interview:{...p.preparation.interview,turns:[{state}]}}}),false);
 assert.equal(canReviewPrd({...p,readiness:{ready:false}}),false);
 assert.equal(canReviewPrd({...p,preparation:{interview:{...p.preparation.interview,state:'idle'}}}),true);
});
