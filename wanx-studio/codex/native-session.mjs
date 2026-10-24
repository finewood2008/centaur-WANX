import WebSocket from 'ws';
import {startSharedServer,socketURL} from './shared-server.mjs';

export class NativeSession{
  constructor({binary,config,env,onEvent=()=>{},startServer=startSharedServer}){Object.assign(this,{binary,config,env,onEvent,startServer});this.pending=new Map();this.sequence=0;this.closed=false;this.controller=new AbortController()}
  async connect(cwd){
    if(this.ws?.readyState===WebSocket.OPEN)return;
    if(this.closed)throw new Error('TASK_CHANNEL_DENIED');
    if(this.ws){
      this.ws.removeAllListeners();this.ws.on('error',()=>{});this.ws.terminate();
      await this.server?.close();this.threadId=null;this.scope=null;
    }
    this.starting=this.startServer({binary:this.binary,config:this.config,env:this.env,cwd,signal:this.controller.signal});
    this.server=await this.starting;
    if(this.closed){await this.server.close();throw new Error('TASK_CHANNEL_DENIED')}
    const ws=this.ws=new WebSocket(socketURL(this.server.socket));
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
    ws.on('message',raw=>this.receive(JSON.parse(raw)));
    ws.on('close',()=>this.fail(new Error('CODEX_CONNECTION_CLOSED')));
    ws.on('error',()=>this.fail(new Error('CODEX_CONNECTION_FAILED')));
    await this.request('initialize',{clientInfo:{name:'wanx_builder_native',title:'WANX Builder',version:'1.0.0'},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:'initialized',params:{}}));
  }
  request(method,params){
    return new Promise((resolve,reject)=>{
      if(this.ws?.readyState!==WebSocket.OPEN){reject(new Error('CODEX_CONNECTION_CLOSED'));return}
      const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CODEX_REQUEST_TIMEOUT'))},40000);
      this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  receive(message){
    if(message.method&&message.id!==undefined){
      // Never delegate an approval or interactive question to the terminal.
      const result=message.method==='item/commandExecution/requestApproval'||message.method==='item/fileChange/requestApproval'?{decision:'decline'}:
        message.method==='item/tool/requestUserInput'?{answers:{}}:null;
      this.ws.send(JSON.stringify(result?{id:message.id,result}:{id:message.id,error:{code:-32601,message:'WANX_OPERATION_DENIED'}}));
      this.onEvent({type:'policy',text:'受控策略已拒绝越界操作',method:message.method});return;
    }
    if(message.id!==undefined){
      const p=this.pending.get(message.id);if(!p)return;
      clearTimeout(p.timer);this.pending.delete(message.id);
      if(message.error){const error=new Error('CODEX_REQUEST_FAILED');error.rpc=message.error;p.reject(error)}else p.resolve(message.result);
      return;
    }
    const p=message.params||{},turn=this.turn;
    if(!turn||p.threadId!==this.threadId||(turn.id&&p.turnId&&p.turnId!==turn.id))return;
    if(message.method==='item/agentMessage/delta')this.onEvent({type:'message',text:p.delta});
    if(['item/started','item/completed'].includes(message.method)&&p.item?.type==='mcpToolCall'){
      this.onEvent({type:'activity',text:p.item.tool||'工具执行进展',toolCallId:p.item.id,status:p.item.status,rawInput:p.item.arguments,rawOutput:p.item.result});
    }
    if(message.method==='turn/plan/updated')this.onEvent({type:'plan',text:'Codex 更新了开发计划',entries:p.plan});
    if(message.method==='turn/completed'){
      this.turn=null;p.turn?.status==='completed'?turn.resolve(p.turn):turn.reject(new Error(p.turn?.status==='interrupted'?'CODEX_INTERRUPTED':'CODEX_TURN_FAILED'));
    }
  }
  async open({cwd,sessionId,scope,mcpServers}){
    if(this.scope===scope)sessionId??=this.threadId;
    await this.connect(cwd);
    if(this.threadId&&this.scope===scope&&(!sessionId||sessionId===this.threadId))return {sessionId:this.threadId,reused:true};
    const config={...this.config,mcp_servers:{...this.config.mcp_servers,...mcpServers}};
    const params={cwd,approvalPolicy:'never',sandbox:'read-only',config};let result;
    if(sessionId){
      try{result=await this.request('thread/resume',{...params,threadId:sessionId,excludeTurns:true})}
      catch(error){if(!/no rollout found|not found|does not exist/i.test(error.rpc?.message||''))throw error}
    }
    result??=await this.request('thread/start',params);
    if(result.approvalPolicy!=='never'||result.sandbox?.type!=='readOnly')throw new Error('CODEX_POLICY_INVALID');
    this.threadId=result.thread.id;this.scope=scope;this.cwd=result.cwd||cwd;
    return {sessionId:this.threadId,reused:false};
  }
  async prompt(input,{effort,onStarted=()=>{}}={}){
    if(this.turn)throw new Error('CODEX_TURN_ACTIVE');
    let resolve,reject;const done=new Promise((a,b)=>{resolve=a;reject=b});done.catch(()=>{});
    const turn=this.turn={resolve,reject,id:null};
    try{
      const result=await this.request('turn/start',{threadId:this.threadId,input:input.map(part=>part.type==='image'?{type:'image',url:`data:${part.mimeType};base64,${part.data}`}:{type:'text',text:part.text}),...(effort?{effort}:{})});
      turn.id=result.turn.id;onStarted();return await done;
    }catch(error){if(this.turn===turn)this.turn=null;throw error}
  }
  async interrupt(){if(this.turn?.id)await this.request('turn/interrupt',{threadId:this.threadId,turnId:this.turn.id})}
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error)}this.pending.clear();this.turn?.reject(error);this.turn=null}
  async close(){if(this.closed)return;this.closed=true;this.controller.abort();this.fail(new Error('TASK_CHANNEL_DENIED'));this.ws?.terminate();const server=await this.starting?.catch(()=>null);await server?.close()}
}
