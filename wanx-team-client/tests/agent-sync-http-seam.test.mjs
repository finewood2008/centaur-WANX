import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createSpaceLinkBridge} from '../shell/space-links.mjs';
import {createAgentTransport} from '../shell/agent-space-profile.mjs';
import {callTool} from '../shell/space-links-mcp.mjs';

test('real HTTP approval, loss after committed context, policy changes and independent task scopes',{skip:!process.env.WANX_SPACE_PYTHON,timeout:60000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'wanx-sync-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.env.WANX_SPACE_PYTHON,[fileURLToPath(new URL('./support/personal-space-api.py',import.meta.url)),root,String(port)],{stdio:['ignore','ignore','pipe']});
 let error='';child.stderr.on('data',v=>error+=v);t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}});
 const base=`http://127.0.0.1:${port}`;
 for(const deadline=Date.now()+30000;;){try{if((await fetch(base+'/api/personal-space/overview')).ok)break;}catch{}if(Date.now()>deadline)throw Error(error);await new Promise(r=>setTimeout(r,30));}
 let saved;const bridge=await createSpaceLinkBridge({client:{snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:'owner'},connection:{deviceId:'box'}}),subscribe:()=>()=>{},applicationConnection:async()=>({context(){},request:async input=>{
  const response=await fetch(base+input.path,{method:input.method,headers:input.headers,body:input.body,signal:input.signal});return {status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())};
 }})},serviceURL:base,store:{load:async()=>saved,save:async v=>saved=structuredClone(v)}});t.after(()=>bridge.close());
 let drop=true,attempts=0;
 const a=await createAgentTransport({profileFile:path.join(root,'a.json'),endpoint:`http://127.0.0.1:${saved.port}`,fetchImpl:async(url,init)=>{
  const response=await fetch(url,init);
  if(JSON.parse(init.body).action==='task-begin'){attempts++;if(drop){drop=false;await response.arrayBuffer();throw new TypeError('controlled lost response after box commit');}}
  return response;
 }});
 const b=await createAgentTransport({profileFile:path.join(root,'b.json'),endpoint:`http://127.0.0.1:${saved.port}`});
 for(const agent of [a,b]){await agent.enroll({name:'same'});await assert.rejects(agent.request({action:'sync-status'}),/SPACE_APPROVAL_REQUIRED/);}
 const pending=await bridge.manage('requests'),policy={context:true,progress:true,outcome:true};
 const aa=await bridge.manage('approve',{id:pending[0].id,name:'A',sync_policy:policy});
 await bridge.manage('approve',{id:pending[1].id,name:'B',sync_policy:policy});
 await assert.rejects(a.request({action:'list'}),/SPACE_CONTEXT_REQUIRED/);
 const begin={action:'task-begin',request_id:'same-context-request',title:'合成任务',policy_revision:1,categories:{context:{status:'provided',summary:'只处理合成样本'}}};
 const task=await a.request(begin);assert.equal(attempts,2);
 const bind={task_id:task.task_id,policy_revision:1,progress:'创建合成文件',operation_id:'file-once'};
 const file=await callTool('space_write_text',{...bind,name:'合成.txt',text:'test data'},a.request);
 assert.equal((await callTool('space_read_text',{task_id:task.task_id,policy_revision:1,target:file.id},a.request)).text,'test data');
 let state=await bridge.manage('sync-status',{id:aa.connection});assert.equal(state.tasks.length,1);assert.equal(state.tasks[0].record_count,2);
 const bt=await b.request({...begin,request_id:'b-context'});
 await assert.rejects(b.request({action:'task-records',task_id:task.task_id}),/SPACE_LINK_SCOPE/);
 await assert.rejects(b.request({action:'stat',task_id:bt.task_id,policy_revision:1,target:file.id}),/SPACE_LINK_SCOPE/);
 const reconnected=await createAgentTransport({profileFile:path.join(root,'a.json'),endpoint:`http://127.0.0.1:${saved.port}`});
 assert.equal((await reconnected.enroll()).space_id,aa.space_id);
 assert.deepEqual(await reconnected.request(begin),task);
 const finish={action:'task-finish',task_id:task.task_id,policy_revision:1,expected:2,request_id:'finish-once',categories:{outcome:{status:'provided',summary:'合成文件读写已核对'}}};
 const result=await reconnected.request(finish);assert.deepEqual(await reconnected.request(finish),result);
 state=await bridge.manage('sync-status',{id:aa.connection});assert.equal(state.tasks[0].record_count,3);assert.equal(state.tasks[0].state,'finished');
 await bridge.manage('connection-manage',{id:aa.connection,action:'pause'});await assert.rejects(a.request({action:'task-records',task_id:task.task_id}),/SPACE_AGENT_PAUSED/);
 await bridge.manage('connection-manage',{id:aa.connection,action:'resume'});
 await bridge.manage('task-delete',{id:aa.connection,task_id:task.task_id});assert.equal((await bridge.manage('sync-status',{id:aa.connection})).bytes,0);
});
