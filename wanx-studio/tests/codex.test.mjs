import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {activity,redact} from '../codex/events.mjs';
import {observeRequest,createObserver} from '../codex/observer.mjs';
import {toml} from '../codex/shared-server.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';

test('native CLI observer is bound to one thread and cannot steer, write, approve or execute',()=>{
  for(const method of ['turn/start','turn/steer','turn/interrupt','thread/inject_items','command/exec','fs/writeFile','config/value/write','account/login/start','account/logout','thread/archive']){
    assert.equal(observeRequest({id:1,method,params:{threadId:'task'}},'task'),null,method);
  }
  assert.equal(observeRequest({method:'thread/read',params:{threadId:'other'}},'task'),null);
  assert.deepEqual(observeRequest({id:1,method:'thread/resume',params:{threadId:'task',sandbox:'dangerFullAccess',config:{shell_tool:true}}},'task'),{id:1,method:'thread/resume',params:{threadId:'task',excludeTurns:true}});
  assert.equal(toml({features:{shell_tool:false},projects:{'/task':{trust_level:'trusted'}}}),'{"features"={"shell_tool"=false},"projects"={"/task"={"trust_level"="trusted"}}}');
});

test('observer transport rejects mutation before upstream and filters other thread history',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'wanx-observer-test-')),socket=path.join(folder,'s.sock');
  const httpServer=http.createServer(),server=new WebSocketServer({server:httpServer});let observed=[],attached=false;
  server.on('connection',peer=>peer.on('message',raw=>{const msg=JSON.parse(raw);observed.push(msg);const result=msg.method==='thread/list'?{data:[{id:'task'},{id:'other'}]}:msg.method==='thread/resume'?{thread:{id:'task'}}:{};peer.send(JSON.stringify({id:msg.id,result}))}));
  await new Promise(resolve=>httpServer.listen(socket,resolve));
  const observer=await createObserver({socket,sessionId:'task',onReady:()=>attached=true});
  const client=new WebSocket('ws+unix://'+observer.socket+':/');await new Promise(resolve=>client.once('open',resolve));
  const rpc=(method,params)=>new Promise(resolve=>{client.once('message',raw=>resolve(JSON.parse(raw)));client.send(JSON.stringify({id:1,method,params}))});
  try{
    assert.equal((await rpc('turn/start',{threadId:'task'})).error.message,'WANX_TERMINAL_READ_ONLY');assert.equal(observed.length,0);
    const listing=await rpc('thread/list',{});assert.deepEqual(listing.result.data,[{id:'task'}]);
    await rpc('thread/resume',{threadId:'task',config:{danger:true}});assert.ok(attached);assert.deepEqual(observed.at(-1).params,{threadId:'task',excludeTurns:true});
  }finally{client.terminate();await observer.close();for(const peer of server.clients)peer.terminate();server.close();await new Promise(resolve=>httpServer.close(resolve));await rm(folder,{recursive:true,force:true})}
});

test('Codex public progress retains full tool details and excludes private reasoning and credentials',()=>{
  assert.equal(activity({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private reasoning'}}),null);
  const text='x'.repeat(20000);
  const update=activity({sessionUpdate:'tool_call_update',toolCallId:'t1',title:'写入源码',status:'completed',rawOutput:{text,authorization:'Bearer private-value'},locations:[{path:'/private/task/src/app.js'}]},'/private/task');
  assert.equal(update.rawOutput.text,text);
  assert.equal(update.rawOutput.authorization,undefined);
  assert.equal(update.locations[0].path,'<任务目录>/src/app.js');
  assert.ok(!redact('Bearer '+ 'a'.repeat(32)).includes('a'.repeat(32)));
  assert.equal(activity({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'正在校验'}}).text,'正在校验');
});

test('Codex task MCP exposes only fixed tools, rejects arbitrary operations and keeps its channel private',async()=>{
  const seen=[];
  const proxy=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({body:JSON.parse(body),auth:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify({files:['src/app.js']}))});
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const child=spawn(process.execPath,['codex/tools.mjs'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,WANX_TASK_PROXY:`http://127.0.0.1:${proxy.address().port}`,WANX_TASK_TOKEN:'synthetic-task-token'},stdio:['pipe','pipe','pipe']});
  const lines=readline.createInterface({input:child.stdout})[Symbol.asyncIterator]();let id=0;
  const rpc=async(method,params={})=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})+'\n');return JSON.parse((await lines.next()).value)};
  try{
    assert.ok((await rpc('initialize',{protocolVersion:'2024-11-05'})).result.capabilities.tools);
    const tools=(await rpc('tools/list')).result.tools;
    assert.deepEqual(tools.map(t=>t.name),['read_material','list_sources','read_source','update_plan','write_source','validate_app','require_plan']);
    assert.ok(!JSON.stringify(tools).includes('synthetic-task-token'));
    assert.ok((await rpc('tools/call',{name:'ask_product',arguments:{}})).error);
    assert.ok((await rpc('tools/call',{name:'read_source',arguments:{path:'src/app.js',owner:'another-user'}})).error);
    assert.equal(seen.length,0);
    const listed=await rpc('tools/call',{name:'list_sources',arguments:{}});
    assert.equal(listed.result.isError,false);
    assert.equal(seen[0].body.operation,'list');
    assert.equal(seen[0].auth,'Bearer synthetic-task-token');
  }finally{child.stdin.end();child.kill('SIGTERM');proxy.closeAllConnections();await new Promise(r=>proxy.close(r))}
});
