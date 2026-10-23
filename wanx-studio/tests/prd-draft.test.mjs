import{test}from'node:test';import assert from'node:assert/strict';import{draftLines,preparePrdDraft}from'../ui/prd-draft.mjs';
test('enter can create a new row without deleting the newline or partial input',()=>{
 const input='先核对负责人\n';const rows=draftLines(input);assert.deepEqual(rows,['先核对负责人','']);assert.equal(rows.join('\n'),input);
 assert.equal(draftLines('第一项\n\n正在输入第三项').join('\n'),'第一项\n\n正在输入第三项');
});
test('explicit save removes empty list rows without modifying the editable draft',()=>{
 const s={fields:['原字段'],acceptance:[],prd:{rules:[' 保留原值 ',''],exceptions:['','允许重试'],outOfScope:['不发送消息',''],scenarios:[{steps:['输入','']}],pages:[{blocks:[{fields:['称呼',''],actions:['保存','']}]}]}};
 const next=preparePrdDraft(s,'rules');assert.deepEqual(next.prd.rules,['保留原值']);assert.deepEqual(next.prd.scenarios[0].steps,['输入']);assert.deepEqual(next.prd.pages[0].blocks[0].actions,['保存']);assert.deepEqual(s.prd.rules,[' 保留原值 ','']);assert.deepEqual(next.fields,['原字段']);
});
test('field and acceptance projections update only for the section explicitly saved',()=>{
 const s={fields:['旧字段'],acceptance:['旧条件'],prd:{dataFields:[{name:'称呼'}],tests:[{title:'保存',given:'填写称呼',when:'点击保存',then:'列表显示'}]}};
 assert.deepEqual(preparePrdDraft(s,'data').fields,['称呼']);assert.deepEqual(preparePrdDraft(s,'data').acceptance,['旧条件']);assert.deepEqual(preparePrdDraft(s,'acceptance').acceptance,['保存：填写称呼，点击保存，列表显示']);
});
