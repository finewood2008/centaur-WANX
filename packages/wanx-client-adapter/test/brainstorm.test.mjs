import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createCentaurAIWanxClient,createHTTPTransport,createNativeHTTPTransport,operationRegistry} from '../dist/index.js';
test('brainstorm bindings work through JS and native HTTP without granting other operations',async()=>{
  const requests=[];const server=createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);requests.push({url:req.url,method:req.method,token:req.headers.authorization,body:Buffer.concat(parts).toString()});if(req.url.endsWith('/report/document')) {res.writeHead(200,{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});res.end(Buffer.from([80,75,3,4,255]));} else {res.writeHead(200,{'content-type':'application/json'});res.end('{"native":true}');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const baseURL=`http://127.0.0.1:${server.address().port}`;
  const policy={applicationId:'super-advisory',operations:operationRegistry.filter(o=>o.tags.includes('brainstorm')).map(o=>o.operationId),sockets:[]};
  try{for(const native of [false,true]){
    const transport=native?await createNativeHTTPTransport({baseURL,token:'host-only',policy}):createHTTPTransport({baseURL,token:async()=>'host-only'});
    const client=createCentaurAIWanxClient({transport,policy});try{
      const b=client.modules.brainstorm;
      await b.getProfile({});await b.configureProfile({body:{expert_ids:['brainstorm-product','brainstorm-challenge'],expert_models:{'brainstorm-product':'wanx/model-a','brainstorm-challenge':'wanx/model-b'}}});
      await b.importExpert({path:{slug:'growth'}});await b.listSessions({});await b.createSession({body:{topic:'寻找新思路',context_enabled:true}});
      await b.getSession({path:{thread_id:'room-1'}});await b.controlSession({path:{thread_id:'room-1'},body:{action:'respond',decision_id:'choice-1',option_index:1,revision:4}});
      await b.getReport({path:{thread_id:'room-1'}});assert.deepEqual(Array.from((await b.exportReport({path:{thread_id:'room-1'}})).body),[80,75,3,4,255]);
      await assert.rejects(client.modules.auth.me({}),{code:'OPERATION_NOT_ALLOWED'});
    }finally{await client.close();}
  }
  assert.equal(requests.length,18);assert.ok(requests.every(r=>r.token==='Bearer host-only'));
  const configured=requests.filter(r=>r.url==='/api/brainstorm/profile'&&r.method==='POST');
  assert.equal(configured.length,2);
  for(const r of configured)assert.deepEqual(JSON.parse(r.body).expert_models,{'brainstorm-product':'wanx/model-a','brainstorm-challenge':'wanx/model-b'});
  for(const index of [6,15]) assert.deepEqual(JSON.parse(requests[index].body),{action:'respond',decision_id:'choice-1',option_index:1,revision:4});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
