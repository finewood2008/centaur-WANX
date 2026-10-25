import{test}from'node:test';import assert from'node:assert/strict';import vm from'node:vm';
import{autoPreview,editJourney,editDelivery,waitingEdit,iterationMessage,migrateFeedback}from'../ui/direct-edit-state.mjs';
import{frameDocument}from'../core/frame.mjs';
import scope from'../integration/edit-scope.mjs';
test('preview follows successful output and conservatively protects dirty input and history',()=>{
 const p={id:'p',artifacts:[{hash:'a'}]},q={id:'p',artifacts:[{hash:'a'},{hash:'b'}]};
 assert.deepEqual(autoPreview(p,q,{followLatest:true},false),{hash:'b',needsConfirmation:false});
 assert.deepEqual(autoPreview(p,q,{followLatest:true},true),{hash:'b',needsConfirmation:true});
 assert.equal(autoPreview(p,q,{followLatest:false},false),null);assert.equal(autoPreview(p,q,{phase:'versions'},false),null);
 assert.equal(autoPreview(p,{...q,id:'other'},{},false),null);assert.equal(autoPreview(q,q,{},false),null);
});
test('queued and clarified requests retain their original operation delivery',()=>{
 const s={items:[{id:'first',sourceOperations:['one'],state:'clarifying',question:{why:'需要明确业务'}},{id:'second',sourceOperations:['two'],state:'queued'}]};
 assert.equal(editDelivery(s,{operationId:'one'}).id,'first');assert.equal(waitingEdit(s).id,'first');assert.equal(editJourney(s).step,0);
});
test('composer combines text and all marks into one turn; discussion is explicit and empty turns stay empty',()=>{
 const marks='请一次完成以下 2 处圈选修改：\n1. 缩小标题\n2. 调整按钮';
 assert.equal(iterationMessage(' 保持现有数据 ','modify',marks),'保持现有数据\n\n'+marks);
 assert.equal(iterationMessage('','modify',marks),marks);
 assert.equal(iterationMessage('还有哪些方案？','discuss'),'先讨论，不修改代码或生成新版本：\n还有哪些方案？');
 assert.equal(iterationMessage('','discuss'), '');
 assert.equal(migrateFeedback('未发送文字','旧面板意见'),'未发送文字\n\n旧面板意见');
 assert.equal(migrateFeedback('未发送文字\n\n旧面板意见','旧面板意见'),'未发送文字\n\n旧面板意见');
});
test('iteration chat renders its tools and multi-mark draft while keeping first-build conversation separate',async()=>{
 const{build}=await import('esbuild'),{renderToStaticMarkup}=await import('react-dom/server'),React=await import('react');
 const bundle=await build({entryPoints:[new URL('../ui/conversation.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',external:['react','react-dom'],loader:{'.css':'empty'},write:false});
 // Resolve the shared React instance from this workspace instead of a data URL.
 const{mkdtemp,writeFile,rm}=await import('node:fs/promises'),path=await import('node:path');const directory=await mkdtemp(new URL('../node_modules/.composer-test-',import.meta.url));
 try{
  const file=path.join(directory,'conversation.mjs');await writeFile(file,bundle.outputFiles[0].text);const{Conversation}=await import(file);
  const noop=()=>{},props={project:null,value:{draft:'',choice:'',extra:''},busy:false,active:false,interviewRunning:false,ready:true,modelAvailable:true,onPatch:noop,onScroll:noop,onSend:noop,onRetry:noop,onHistory:noop,onConfigure:noop,onCapabilities:noop};
  const first=renderToStaticMarkup(React.createElement(Conversation,props));assert.doesNotMatch(first,/本轮处理方式|圈选修改|取消排队/);
  const visualDraft={id:'draft',version:'0.1.2',image:'data:image/png;base64,cGl4ZWxz',regions:[{instruction:'标题缩小'},{instruction:'按钮改绿'}]};
  const html=renderToStaticMarkup(React.createElement(Conversation,{...props,direct:true,baseVersion:'0.1.2',visualDraft}));
  assert.match(html,/本轮处理方式/);assert.match(html,/标记修改/);assert.match(html,/标题缩小/);assert.match(html,/按钮改绿/);assert.match(html,/发送 2 处修改/);assert.doesNotMatch(html,/记录改进意见/);
 }finally{await rm(directory,{recursive:true,force:true})}
});
test('only current sandbox port reports dirty events without granting another runtime capability',()=>{
 let init;const listeners={},messages=[];const parent={};
 const html=frameDocument('const WanxMiniapp={mount(){}};');const script=html.match(/<script>([\s\S]*)<\/script>/)[1];
 vm.runInNewContext(script,{parent,window:{addEventListener:(name,fn)=>{init=fn}},document:{addEventListener:(name,fn)=>{listeners[name]=fn},getElementById:()=>({})},Promise,Map,Error,Object});
 const port={postMessage:m=>messages.push(m)};init({source:{},data:{type:'wanx:init'},ports:[port]});assert.equal(listeners.input,undefined);
 init({source:parent,data:{type:'wanx:init'},ports:[port]});listeners.input();listeners.change();
 assert.deepEqual(messages.map(x=>JSON.parse(JSON.stringify(x))),[{type:'wanx:dirty',dirty:true},{type:'wanx:dirty',dirty:true}]);assert.match(html,/connect-src 'none'/);
});
test('Host invalidation cancels only requests received in that Host context',async()=>{
 const m=new Map(),calls=[];scope.rememberEdits(m,{project:{id:'a'.repeat(32)},items:[{id:'a',contextId:'old',state:'building'},{id:'b',contextId:'old',state:'completed'}]});
 scope.stopEdits(m,(path,body)=>calls.push({path,body}));await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].body.contextId,'old');assert.match(calls[0].path,/\/edits\/stop$/);assert.equal(m.size,0);
});

test('context is tracked before a response arrives and cancellation stays on a fixed route',async()=>{
 const m=new Map(),calls=[];const path='/api/app-studio/_builder/projects/'+'a'.repeat(32)+'/edits?contextId=before-response';
 scope.rememberRequest(m,path);scope.stopEdits(m,(path,body)=>calls.push({path,body}));await Promise.resolve();assert.equal(calls[0].body.contextId,'before-response');assert.match(calls[0].path,/\/edits\/stop$/);
});

test('main-process heartbeat keeps only a bound pending context alive and stops after disposal',async()=>{
 const m=new Map(),calls=[];scope.rememberRequest(m,'/api/app-studio/_builder/projects/'+'a'.repeat(32)+'/edits',{contextId:'host'});
 let completed;const finished=new Promise(resolve=>{completed=resolve});
 const dispose=scope.heartbeatEdits(m,async(path,body)=>{calls.push({path,body});if(calls.length===2)completed();return{active:calls.length<2}},10);
 let deadline;try{await Promise.race([finished,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('heartbeat did not complete')),2000)})])}finally{clearTimeout(deadline);dispose()};assert.equal(calls.length,2);assert.match(calls[0].path,/\/edits\/heartbeat$/);assert.equal(calls[0].body.contextId,'host');
 dispose();await new Promise(r=>setTimeout(r,25));assert.equal(calls.length,2);
});

test('packaged ESM scope module can send cancellation and heartbeat with real operation IDs',async()=>{
 const{build}=await import('esbuild');const bundle=await build({entryPoints:[new URL('../integration/edit-scope.mjs',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
 const packed=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
 const m=new Map(),calls=[];const path='/api/app-studio/_builder/projects/'+'a'.repeat(32)+'/edits';
 packed.rememberRequest(m,path,{contextId:'packaged'});await packed.stopEdits(m,async(path,body)=>{calls.push({path,body})});
 assert.equal(calls.length,1);assert.match(calls[0].body.operationId,/^[0-9a-f-]{36}$/);
 let completed;const finished=new Promise(resolve=>{completed=resolve});
 packed.rememberRequest(m,path,{contextId:'packaged'});const dispose=packed.heartbeatEdits(m,async(path,body)=>{calls.push({path,body});completed();return{active:false}},10);
 let deadline;try{await Promise.race([finished,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('packaged heartbeat did not complete')),2000)})])}finally{clearTimeout(deadline);dispose()};assert.equal(calls.length,2);assert.match(calls[1].path,/\/heartbeat$/);
});
