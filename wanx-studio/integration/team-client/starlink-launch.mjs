import {randomUUID} from 'node:crypto';
export async function sendStarlinkTarget(entry,target,{timeout=15000}={}){
  entry.session.assertLive?.();
  const requestId=randomUUID();
  return new Promise((resolve,reject)=>{
    const finish=(error,value)=>{clearTimeout(timer);entry.child.removeListener('message',receive);entry.child.removeListener('exit',closed);error?reject(Object.assign(new Error(error),{code:error})):resolve(value)};
    const closed=()=>finish('APPLICATION_START_FAILED');
    const receive=m=>{
      if(m?.launchId!==entry.session.launchId)return;
      if(m.type==='wanx:starlink-capabilities'&&m.version===1)entry.starlinkProtocol=1;
      if(m.type!=='wanx:starlink-target-result'||m.requestId!==requestId)return;
      try{entry.session.assertLive?.()}catch{return finish('TEAM_SESSION_CHANGED')}
      finish(m.ok===true?null:String(m.code||'TEAM_STARLINK_OPEN_FAILED'),{opened:true});
    };
    const timer=setTimeout(()=>finish(entry.starlinkProtocol===1?'TEAM_STARLINK_OPEN_TIMEOUT':'TEAM_STARLINK_UPGRADE_REQUIRED'),timeout);
    entry.child.on('message',receive);entry.child.once('exit',closed);
    entry.child.send({type:'wanx:starlink-target',launchId:entry.session.launchId,requestId,target},error=>{if(error)finish('APPLICATION_START_FAILED')});
  });
}
