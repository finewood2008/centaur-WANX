import readline from 'node:readline';
import {randomUUID} from 'node:crypto';

// One private process per owner/project/role. Replies are consumed even while a
// turn is running; only the Python owner may submit the next turn.
export async function serveWorker(create){
  const pending=new Map();let busy=false,closing=false,idleTimer,handler,lines;
  const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
  const rejectPending=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('TASK_CHANNEL_DENIED'))}pending.clear()};
  const request=(type,value={})=>new Promise((resolve,reject)=>{
    const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('TASK_AUTHORIZATION_EXPIRED'))},10000);
    pending.set(id,{resolve,reject,timer});emit({type,...value,id});
  });
  const close=async()=>{if(closing)return;closing=true;clearTimeout(idleTimer);rejectPending();await handler?.close();lines?.close();process.stdin.destroy()};
  handler=await create({emit,request});
  lines=readline.createInterface({input:process.stdin});
  lines.on('line',line=>{
    let value;try{value=JSON.parse(line)}catch{void close();return}
    if(value.id){const p=pending.get(value.id);if(p){pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(new Error(value.error)):p.resolve(value.result)}return}
    if(busy||closing){void close();return}
    busy=true;clearTimeout(idleTimer);
    void (async()=>{
      try{await handler.run(value)}
      catch(error){emit({type:'failed',code:/^[A-Z_]+$/.test(error.message)?error.message:'CODEX_EXECUTION_FAILED'})}
      finally{rejectPending();busy=false;if(!closing){emit({type:'idle'});idleTimer=setTimeout(()=>void close(),300000);idleTimer.unref()}}
    })();
  });
  lines.once('close',()=>void close());
  process.once('SIGTERM',()=>close().finally(()=>process.exit(0)));
  process.once('SIGINT',()=>close().finally(()=>process.exit(0)));
}
