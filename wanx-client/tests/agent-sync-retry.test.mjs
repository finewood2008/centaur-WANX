import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAgentTransport} from '../shell/agent-space-profile.mjs';

test('lost acknowledgements retry the exact task request; permission refusals do not retry',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'wanx-sync-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const calls=[];let denied=false;
 const transport=await createAgentTransport({profileFile:path.join(root,'profile.json'),endpoint:'http://127.0.0.1:12345',fetchImpl:async(url,init)=>{
  calls.push(init.body);if(calls.length===1)throw new TypeError('connection lost after commit');
  return denied?new Response(JSON.stringify({error:{code:'SPACE_AGENT_PAUSED'}}),{status:403}):new Response(JSON.stringify({saved:true,task_id:'same-task'}));
 }});
 const result=await transport.request({action:'task-begin',request_id:'same-request',policy_revision:1,title:'sample'});
 assert.equal(result.task_id,'same-task');assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);
 denied=true;await assert.rejects(transport.request({action:'task-checkpoint',request_id:'later'}),/SPACE_AGENT_PAUSED/);assert.equal(calls.length,3);
});

test('trusted owner sees saving/failure receipts without any submitted content in the client store',async()=>{
 const {createAgentSpaces}=await import('../shell/agent-spaces.mjs');
 const record={id:'request',key:'x'.repeat(43),scope:'owner:box',status:'approved',connection:'a'.repeat(32),token:'not-exposed'};
 const state={agents:[record]},events=[];let finish,fail=false;
 const agents=createAgentSpaces({state,scope:()=>record.scope,assertScope:bound=>assert.equal(bound,record.scope),persist:async()=>{},onChanged:()=>events.push(record.delivery?.state),remote:async()=>{
  if(fail)throw Object.assign(Error('paused'),{code:'SPACE_AGENT_PAUSED'});
  return new Promise(r=>finish=()=>r({value:{saved:true}}));
 }});
 const pending=agents.access(record.key,{action:'task-begin',request_id:'one',categories:{context:{summary:'private synthetic context'}}});
 assert.equal(record.delivery.state,'saving');assert.ok(!JSON.stringify(record.delivery).includes('synthetic'));
 finish();await pending;assert.equal(record.delivery.state,'saved');
 fail=true;await assert.rejects(agents.access(record.key,{action:'task-checkpoint',request_id:'two'}),/paused/);
 assert.equal(record.delivery.state,'failed');assert.equal(record.delivery.code,'SPACE_AGENT_PAUSED');assert.deepEqual(events,['saving','saved','saving','failed']);
 record.delivery.state='saving';createAgentSpaces({state,scope:()=>record.scope,assertScope(){},remote(){},persist(){},onChanged(){}});
 assert.equal(record.delivery.state,'failed');assert.equal(record.delivery.code,'SPACE_SYNC_INTERRUPTED');
});
