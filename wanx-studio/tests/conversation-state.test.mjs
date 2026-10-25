import{test}from'node:test';
import assert from'node:assert/strict';
import{conversationParagraphs,conversationFollows,conversationStatus,conversationInput,interviewRetry}from'../ui/conversation-state.mjs';

test('notes drafted during a reply remain visible when new choices arrive and never send implicitly',()=>{
 const note={draft:'先记下下一步想法\n还没有发送',choice:'',extra:''};
 const options=['先记录客户','other'];
 assert.equal(conversationInput(note,[]).text,note.draft);
 assert.deepEqual(conversationInput(note,options),{choice:'other',text:note.draft,answer:note.draft});
 assert.equal(note.choice,'');
 const selected=conversationInput({...note,choice:'先记录客户'},options);
 assert.equal(selected.answer,'先记录客户');assert.equal(selected.text,'');
 assert.equal(conversationInput({draft:'',choice:'other',extra:'我补充的回答'},options).answer,'我补充的回答');
});

test('a reply without choices keeps a supplemental draft visible',()=>{
 const note={draft:'',choice:'other',extra:'整理期间写下的补充\n尚未发送'};
 assert.deepEqual(conversationInput(note,[]),{choice:'',text:note.extra,answer:note.extra});
 assert.equal(note.draft,'');
});

test('a replaced question cannot silently submit its previous selected answer',()=>{
 const note={draft:'',choice:'先记录客户',extra:''};
 assert.deepEqual(conversationInput(note,['先整理课程','other']),{choice:'',text:'',answer:''});
 assert.deepEqual(conversationInput({...note,extra:'自己的想法'},['先整理课程','other']),{choice:'other',text:'自己的想法',answer:'自己的想法'});
});

test('conversation formatting preserves content and treats markup as plain text',()=>{
 const text='建议**只保存摘要**，由你决定。\n\n<script>alert(1)</script>\n未确认前不开发';
 assert.deepEqual(conversationParagraphs(text),[
  [{text:'建议',bold:false},{text:'只保存摘要',bold:true},{text:'，由你决定。',bold:false}],
  [{text:'<script>alert(1)</script>\n未确认前不开发',bold:false}]
 ]);
 assert.deepEqual(conversationParagraphs(''),[]);
 assert.equal(conversationParagraphs('**未闭合')[0][0].text,'**未闭合');
});
test('readers browsing older messages do not follow incoming output',()=>{
 assert.equal(conversationFollows(30,1600,500),false);
 assert.equal(conversationFollows(1005,1600,500),true);
 assert.equal(conversationFollows(0,300,500),true);
});
test('conversation sync status does not claim a running or failed round is saved',()=>{
 assert.equal(conversationStatus({interview:{state:'running',sync:'saved'}}),'正在理解和整理…');
 assert.equal(conversationStatus({interview:{state:'idle',sync:'failed'}}),'本轮尚未同步，请重试');
 assert.equal(conversationStatus({interview:{state:'failed',sync:'saved'}}),'本轮尚未同步，请重试');
 assert.equal(conversationStatus({interview:{state:'idle',sync:'saved'}}),'产品方案已保存');
 assert.equal(conversationStatus(undefined),'边聊边整理完整方案');
});

test('starting a confirmed build retires its old answer choices but keeps new discussion choices',async()=>{
 const {pendingConversationOptions}=await import('../ui/conversation-state.mjs');
 const last={role:'assistant',question:{options:['确认构建','继续调整']}};const p={solutionHash:'current',confirmation:{hash:'current'},tasks:[{solutionHash:'current'}]};
 assert.deepEqual(pendingConversationOptions(p,last),[]);
 assert.deepEqual(pendingConversationOptions({...p,confirmation:null},last),last.question.options);
});


test('retry uses the saved operation and words instead of inserting a generic extra turn',()=>{
 const p={preparation:{handoff:{id:'original'},interview:{turns:[{operationId:'done',text:'已回答',state:'completed'},{operationId:'saved',text:'定期工作汇报',state:'paused'}]}}};
 assert.deepEqual(interviewRetry(p),{operationId:'saved',text:'定期工作汇报'});
 p.preparation.interview.turns[1].state='completed';assert.equal(interviewRetry(p),null);
 p.preparation.interview.turns=[];assert.deepEqual(interviewRetry(p),{operationId:'handoff_original',text:''});
});
