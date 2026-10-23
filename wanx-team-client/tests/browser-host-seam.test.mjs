import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {createDashboardGateway} from '../octop/gateway.mjs';
import {createApplicationSession} from '../app-host/session.mjs';
import {fromEnvironment} from '../host-sdk/index.cjs';

// Both real Host layers participate; the box fixture sends a frame immediately.
test('browser stream uses header auth through both gateways and revokes on box switch', {timeout:5000}, async t=>{
  let request;
  const box=http.createServer((req,res)=>res.end('{}'));
  const wss=new WebSocketServer({server:box});
  wss.on('connection',(ws,req)=>{request=req;ws.send(JSON.stringify({type:'frame',data:'first'}));});
  box.listen(0,'127.0.0.1');await once(box,'listening');
  const gateway=await createDashboardGateway({targetURL:`http://127.0.0.1:${box.address().port}`,session:{getToken:()=> 'box-secret',close(){}}});
  let invalidated, live=true;
  const session=await createApplicationSession({hostApplicationId:'wanx',applicationId:'centaurai.wanx.ai-browser',installPath:'/synthetic',createConnection:async()=>({context:()=>{if(!live)throw Object.assign(new Error('NETWORK_CHANGED'),{code:'NETWORK_CHANGED'});return {boxId:'fixture',user:{id:1},connection:'ready'};},request:i=>gateway.request(i),openStream:i=>gateway.openWebSocket(i),subscribe:f=>(invalidated=f,()=>{})})});
  const client=fromEnvironment(session.environment);
  t.after(async()=>{client.close();await session.close();await gateway.close();for(const ws of wss.clients)ws.terminate();wss.close();box.closeAllConnections();await new Promise(r=>box.close(r));});
  await client.context();
  const ws=await client.openStream('/api/browser-stream/ws');
  const [first]=await once(ws,'message');
  assert.equal(JSON.parse(first.toString()).data,'first');
  assert.equal(request.url,'/api/browser-stream/ws');
  assert.equal(request.headers.authorization,'Bearer box-secret');
  const closed=once(ws,'close');
  live=false;invalidated();await closed;
  await assert.rejects(client.request('/api/browser/control-capabilities'));
});
