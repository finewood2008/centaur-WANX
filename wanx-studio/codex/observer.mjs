import http from 'node:http';
import {chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';

const reads=new Set(['initialize','initialized','config/read','configRequirements/read','model/list',
  'account/read','account/rateLimits/read','skills/list','app/list','experimentalFeature/list',
  'mcpServerStatus/list','permissionProfile/list','hooks/list','collaborationMode/list','thread/read','thread/turns/list','thread/items/list',
  'thread/loaded/list','thread/list','thread/goal/get']);

export function observeRequest(message,sessionId){
  const {method,params}=message;
  if(method==='thread/resume'){
    if(params?.threadId!==sessionId)return null;
    // Preserve the CLI's history fallback for JSONL threads. Forcing paginated
    // history also forces its retry back into the unsupported list_turns path.
    return {...message,params:{threadId:sessionId,excludeTurns:params.excludeTurns===true}};
  }
  if(!reads.has(method))return null;
  if(method.startsWith('thread/')&&!['thread/list','thread/loaded/list'].includes(method)&&params?.threadId!==sessionId)return null;
  return message;
}

export async function createObserver({socket,sessionId,view,onReady,onPolicy=()=>{}}){
  if(!view)throw new Error('CODEX_OBSERVER_VIEW_REQUIRED');
  const address=path.join(path.dirname(socket),'observer.sock');
  const httpServer=http.createServer((_,res)=>{res.writeHead(403);res.end()});
  const server=new WebSocketServer({noServer:true,maxPayload:8*1024*1024}),clients=new Set();
  httpServer.on('upgrade',(request,connection,head)=>{
    if(request.headers.origin){connection.destroy();return}
    server.handleUpgrade(request,connection,head,client=>server.emit('connection',client));
  });
  server.on('connection',client=>{
    clients.add(client);let attached=false;
    const off=view.subscribe(message=>{if(attached&&client.readyState===WebSocket.OPEN)client.send(JSON.stringify(message))});
    client.on('message',async data=>{
      let input;
      try{
        input=JSON.parse(data);const allowed=observeRequest(input,sessionId);
        onPolicy({method:input.method,allowed:Boolean(allowed),sessionId});
        if(!allowed){if(input.id!==undefined)client.send(JSON.stringify({id:input.id,error:{code:-32601,message:'WANX_TERMINAL_READ_ONLY'}}));return}
        let result=await view.request(allowed.method,allowed.params);
        if(allowed.method==='thread/list'&&result?.data)result={...result,data:result.data.filter(t=>t.id===sessionId)};
        if(allowed.method==='thread/loaded/list'&&result?.data)result={...result,data:result.data.filter(id=>id===sessionId)};
        if(client.readyState!==WebSocket.OPEN)return;
        if(input.id!==undefined)client.send(JSON.stringify({id:input.id,result}));
        if(allowed.method==='thread/resume'&&result?.thread?.id===sessionId){attached=true;onReady()}
      }catch(error){
        if(input?.id!==undefined&&client.readyState===WebSocket.OPEN)client.send(JSON.stringify({id:input.id,error:error.rpc||{code:-32603,message:'WANX_TERMINAL_READ_FAILED'}}));
      }
    });
    client.once('close',()=>{off();clients.delete(client)});client.on('error',()=>client.terminate());
  });
  await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(address,resolve)});
  await chmod(address,0o600);
  return {socket:address,async close(){
    for(const client of clients)client.terminate();
    await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>httpServer.close(resolve))]);
    await rm(address,{force:true});
  }};
}
