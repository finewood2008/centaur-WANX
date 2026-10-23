import http from 'node:http';
import {chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import WebSocket,{WebSocketServer} from 'ws';
import {socketURL} from './shared-server.mjs';

const reads=new Set(['initialize','initialized','config/read','configRequirements/read','model/list',
  'account/read','account/rateLimits/read','skills/list','app/list','experimentalFeature/list',
  'mcpServerStatus/list','permissionProfile/list','hooks/list','collaborationMode/list','thread/read','thread/turns/list','thread/items/list',
  'thread/loaded/list','thread/list','thread/goal/get']);

export function observeRequest(message,sessionId){
  const {method,params}=message;
  if(method==='thread/resume'){
    if(params?.threadId!==sessionId)return null;
    return {...message,params:{threadId:sessionId,excludeTurns:true}};
  }
  if(!reads.has(method))return null;
  if(method.startsWith('thread/')&&!['thread/list','thread/loaded/list'].includes(method)&&params?.threadId!==sessionId)return null;
  return message;
}

export async function createObserver({socket,sessionId,onReady,onPolicy=()=>{}}){
  const address=path.join(path.dirname(socket),'observer.sock');
  const httpServer=http.createServer((_,res)=>{res.writeHead(403);res.end()});
  const server=new WebSocketServer({noServer:true,maxPayload:8*1024*1024});
  const clients=new Set();
  httpServer.on('upgrade',(request,connection,head)=>{
    if(request.headers.origin){connection.destroy();return}
    server.handleUpgrade(request,connection,head,client=>server.emit('connection',client));
  });
  server.on('connection',client=>{
    const upstream=new WebSocket(socketURL(socket)),pending=new Map(),queue=[];
    clients.add(client);clients.add(upstream);
    let closed=false;
    const close=()=>{if(closed)return;closed=true;client.close();upstream.close();clients.delete(client);clients.delete(upstream)};
    upstream.on('open',()=>{for(const line of queue)upstream.send(line);queue.length=0});
    client.on('message',data=>{
      try{
        const input=JSON.parse(data),allowed=observeRequest(input,sessionId);
        onPolicy({method:input.method,allowed:Boolean(allowed),sessionId});
        if(!allowed){if(input.id!==undefined)client.send(JSON.stringify({id:input.id,error:{code:-32601,message:'WANX_TERMINAL_READ_ONLY'}}));return}
        if(input.id!==undefined)pending.set(input.id,input.method);
        const line=JSON.stringify(allowed);
        if(upstream.readyState===WebSocket.OPEN)upstream.send(line);else if(queue.length<128)queue.push(line);else close();
      }catch{close()}
    });
    upstream.on('message',data=>{
      const message=JSON.parse(data),method=pending.get(message.id);
      if(method==='thread/resume'&&message.result?.thread?.id===sessionId)onReady();
      if(method==='thread/list'&&message.result?.data)message.result.data=message.result.data.filter(thread=>thread.id===sessionId);
      if(method==='thread/loaded/list'&&message.result?.data)message.result.data=message.result.data.filter(id=>id===sessionId);
      if(message.id!==undefined)pending.delete(message.id);
      if(client.readyState===WebSocket.OPEN)client.send(JSON.stringify(message));
    });
    for(const peer of [client,upstream]){peer.on('error',close);peer.on('close',close)}
  });
  await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(address,resolve)});
  await chmod(address,0o600);
  return {socket:address,async close(){for(const peer of clients)peer.terminate();server.close();httpServer.close();await rm(address,{force:true})}};
}
