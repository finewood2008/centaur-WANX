import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

test('ACP discovers scoped Starlink research tools through the existing private channel', async()=>{
 const seen=[];
 const proxy=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  seen.push({authorization:req.headers.authorization,body:JSON.parse(text)});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({items:[]}));
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const child=spawn(process.execPath,['codex/interview-tools.mjs'],{
  cwd:new URL('..',import.meta.url),stdio:['pipe','pipe','pipe'],
  env:{PATH:process.env.PATH,WANX_INTERVIEW_PROXY:`http://127.0.0.1:${proxy.address().port}`,WANX_INTERVIEW_TOKEN:'synthetic-research-channel'},
 });
 const lines=readline.createInterface({input:child.stdout})[Symbol.asyncIterator]();let id=0;
 const rpc=async(method,params={})=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,params})+'\n');return JSON.parse((await lines.next()).value)};
 try{
  await rpc('initialize',{protocolVersion:'2025-11-25'});
  const tools=(await rpc('tools/list')).result.tools;
  const search=tools.find(t=>t.name==='search_context'),read=tools.find(t=>t.name==='read_context');
  assert.match(search.description,/星图/);assert.match(search.description,/本项目已选且获准/);
  assert.deepEqual(Object.keys(search.inputSchema.properties),['query']);
  assert.equal(search.annotations.readOnlyHint,true);assert.equal(search.annotations.openWorldHint,false);
  assert.match(read.description,/运行时授权/);assert.ok(!JSON.stringify(tools).includes('synthetic-research-channel'));
  assert.ok((await rpc('tools/call',{name:'search_context',arguments:{query:'会议',warehouseId:'foreign'}})).error);
  assert.equal(seen.length,0);
  assert.equal((await rpc('tools/call',{name:'search_context',arguments:{query:'会议 行动项'}})).result.isError,false);
  assert.deepEqual(seen[0],{authorization:'Bearer synthetic-research-channel',body:{method:'search_context',args:{query:'会议 行动项'}}});
  assert.equal((await rpc('tools/call',{name:'read_context',arguments:{ref:'xingtu:selected',offset:0,limit:24}})).result.isError,false);
  assert.deepEqual(seen[1].body,{method:'read_context',args:{ref:'xingtu:selected',offset:0,limit:24}});
 }finally{
  child.stdin.end();child.kill('SIGTERM');proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
 }
});
