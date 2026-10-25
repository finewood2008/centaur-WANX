#!/usr/bin/env node
// Synthetic app-server; no inference, filesystem tools or user data.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {WebSocketServer} from 'ws';
const args=process.argv.slice(2);
if(args[0]!=='app-server'){setInterval(()=>{},10000)}else{
 const endpoint=args[args.indexOf('--listen')+1].slice('unix://'.length);
 const server=http.createServer(),wss=new WebSocketServer({server});const threads=new Map();
 wss.on('connection',ws=>ws.on('message',async raw=>{
  const m=JSON.parse(raw);if(m.id===undefined)return;
  const reply=result=>ws.send(JSON.stringify({id:m.id,result}));
  if(m.method==='initialize'){reply({});return}
  if(m.method==='thread/start'||m.method==='thread/resume'){
   const id=m.params.threadId||randomUUID();threads.set(id,m.params.config);reply({thread:{id},approvalPolicy:'never',sandbox:{type:'readOnly'}});return;
  }
  if(m.method==='turn/start'){
   const id=randomUUID(),threadId=m.params.threadId;reply({turn:{id,status:'inProgress'}});
   const notify=(method,extra)=>ws.send(JSON.stringify({method,params:{threadId,turnId:id,...extra}}));
   notify('item/agentMessage/delta',{delta:'synthetic turn started'});
   const env=threads.get(threadId).mcp_servers.wanx_task.env;
   const call=async operation=>{
    notify('item/started',{item:{id:randomUUID(),type:'mcpToolCall',tool:operation,status:'inProgress'}});
    const res=await fetch(env.WANX_TASK_PROXY+'/tool',{method:'POST',headers:{authorization:'Bearer '+env.WANX_TASK_TOKEN},body:JSON.stringify({operation})});
    if(!res.ok)throw new Error('synthetic tool denied');return res.json();
   };
   try{await call('material');await call('list');await call('validate');notify('turn/completed',{turn:{id,status:'completed'}})}
   catch{notify('turn/completed',{turn:{id,status:'failed'}})}
   return;
  }
  reply({});
 }));
 server.listen(endpoint);
}
