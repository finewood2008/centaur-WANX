import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {WebSocketServer} from 'ws';
import {NativeSession} from '../codex/native-session.mjs';

async function fixture(t,handle){
 const folder=await mkdtemp(path.join(os.tmpdir(),'wanx-native-rpc-')),socket=path.join(folder,'s.sock');
 const httpServer=http.createServer(),wss=new WebSocketServer({server:httpServer});const calls=[];let peer;
 wss.on('connection',ws=>{peer=ws;ws.on('message',raw=>{
  const m=JSON.parse(raw);calls.push(m);
  if(m.id===undefined||!m.method)return;
  if(handle?.(m,ws))return;
  const result=m.method.startsWith('thread/')?{thread:{id:m.params.threadId||'thread-one'},approvalPolicy:'never',sandbox:{type:'readOnly'}}:{};
  ws.send(JSON.stringify({id:m.id,result}));
 })});
 await new Promise(resolve=>httpServer.listen(socket,resolve));
 const events=[];const native=new NativeSession({config:{features:{shell_tool:false},mcp_servers:{ambient:{enabled:false}}},onEvent:e=>events.push(e),startServer:async()=>({socket,close:async()=>{}})});
 t.after(async()=>{await native.close();for(const ws of wss.clients)ws.terminate();wss.close();await new Promise(resolve=>httpServer.close(resolve));await rm(folder,{recursive:true,force:true})});
 return {native,calls,events,get peer(){return peer}};
}

test('native thread reuse keeps one handshake and one scoped tool configuration',async t=>{
 const {native,calls}=await fixture(t);const options={cwd:'/synthetic/task',scope:'project',mcpServers:{wanx_task:{command:'synthetic'}}};
 const a=await native.open(options),b=await native.open({...options,cwd:'/synthetic/next-task'});
 assert.equal(native.cwd,'/synthetic/task');
 assert.equal(a.sessionId,b.sessionId);assert.equal(b.reused,true);
 assert.equal(calls.filter(m=>m.method==='initialize').length,1);
 assert.equal(calls.filter(m=>m.method==='thread/start').length,1);
 const start=calls.find(m=>m.method==='thread/start');assert.equal(start.params.approvalPolicy,'never');assert.equal(start.params.sandbox,'read-only');
 assert.deepEqual(start.params.config.mcp_servers.ambient,{enabled:false});
 await native.open({...options,scope:'different-edit'});
 assert.equal(calls.filter(m=>m.method==='thread/start').length,2);
});

test('only matching public events are streamed; failed turns never count as success',async t=>{
 let number=0;
 const {native,events}=await fixture(t,(m,ws)=>{
  if(m.method!=='turn/start')return false;
  const id='turn-'+(++number);ws.send(JSON.stringify({id:m.id,result:{turn:{id}}}));
  for(const [method,params] of [
   ['item/agentMessage/delta',{threadId:'other',turnId:id,delta:'wrong owner'}],
   ['item/reasoning/textDelta',{threadId:'thread-one',turnId:id,delta:'private reasoning'}],
   ['item/agentMessage/delta',{threadId:'thread-one',turnId:id,delta:'public progress'}],
   ['turn/completed',{threadId:'thread-one',turn:{id,status:number===1?'completed':'failed'}}]
  ])ws.send(JSON.stringify({method,params}));
  return true;
 });
 await native.open({cwd:'/synthetic/task',scope:'p',mcpServers:{}});
 await native.prompt([{type:'text',text:'synthetic'}]);
 assert.deepEqual(events,[{type:'message',text:'public progress'}]);
 await assert.rejects(native.prompt([{type:'text',text:'synthetic'}]),/CODEX_TURN_FAILED/);
});

test('server approvals are denied without user or terminal interaction',async t=>{
 const f=await fixture(t);await f.native.open({cwd:'/synthetic/task',scope:'p',mcpServers:{}});
 f.peer.send(JSON.stringify({id:991,method:'item/commandExecution/requestApproval',params:{}}));
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(f.calls.find(m=>m.id===991).result,{decision:'decline'});
});
