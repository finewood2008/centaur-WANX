import {createHash,randomUUID} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
export function teamServerOrigin(value){
  let u;try{u=new URL(value)}catch{throw fail('TEAM_SERVER_URL_INVALID')}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/'||value.length>2048)throw fail('TEAM_SERVER_URL_INVALID');
  const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
  if(u.protocol==='http:'&&!local)throw fail('TEAM_SERVER_HTTPS_REQUIRED');
  return u.origin;
}
export function createTeamConnection({base,createTransport,store,fetcher=fetch}){
  let active=null,transport=null,generation=0,masked=false,closed=false;
  const listeners=new Set(),clientId=randomUUID();
  const emit=()=>{for(const listener of listeners)listener(snapshot());};
  const stopBase=base.subscribe(emit);
  async function json(origin,route,{token,body,method=body?'POST':'GET'}={}){
    const r=await fetcher(origin+route,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(!r.ok)throw fail([401,403].includes(r.status)?'TEAM_LOGIN_DENIED':'TEAM_SERVER_UNAVAILABLE');
    const text=await r.text();if(text.length>262144)throw fail('TEAM_IDENTITY_INVALID');
    return text?JSON.parse(text):null;
  }
  function snapshot(){
    if(!active){const s=base.snapshot();return masked?{...s,phase:'disconnected',connection:null,devices:[],account:{phase:'signed_out',provider:'team-server'}}:s;}
    const s=transport.snapshot(),id='team-'+createHash('sha256').update(active.origin).digest('hex').slice(0,24);
    return {...base.snapshot(),phase:s.phase,reason:s.reason,network:{enabled:false,phase:'disabled'},platform:{phase:'ready'},
      account:{phase:'authenticated',provider:'team-server',accountId:active.accountId,clientId,profile:{displayName:active.user.display_name||active.user.username}},
      connection:s.connection?{...s.connection,mode:'local',teamDirect:true}:null,
      devices:[{deviceId:id,displayName:active.name,local:true,accessState:s.phase==='ready'?'ready':'offline',networkReady:s.phase==='ready',canOpen:s.phase==='ready'}]};
  }
  function assertLive(epoch){if(closed||generation!==epoch||!active||transport.snapshot().phase!=='ready')throw fail('TEAM_SESSION_CHANGED');}
  async function activate(saved){
    const epoch=++generation;masked=true;active=null;emit();
    const origin=teamServerOrigin(saved.origin);
    if(typeof saved.token!=='string'||!saved.token||!Number.isFinite(saved.expiresAt)||saved.expiresAt<=Date.now())throw fail('TEAM_LOGIN_EXPIRED');
    const user=await json(origin,'/api/auth/me',{token:saved.token});
    if(!Number.isSafeInteger(user?.id)||user.id<=0||typeof user.role!=='string'||user.application_id!=='wanx')throw fail('TEAM_IDENTITY_INVALID');
    if(generation!==epoch||closed)throw fail('TEAM_SESSION_CHANGED');
    await transport?.close();
    transport=createTransport();transport.subscribe(emit);
    const id='team-'+createHash('sha256').update(origin).digest('hex').slice(0,24);
    const name=saved.name||'团队服务器';
    await transport.connect({deviceId:id,name,url:origin,mode:'direct'},{createSession:async()=>({getToken:()=>{if(saved.expiresAt<=Date.now())throw fail('TEAM_LOGIN_EXPIRED');return saved.token},close(){},subscribe(){return()=>{}}})});
    if(generation!==epoch||closed){await transport.close();throw fail('TEAM_SESSION_CHANGED');}
    active={...saved,origin,name,user,accountId:'team:'+createHash('sha256').update(JSON.stringify([origin,user.id])).digest('hex')};
    masked=false;emit();return snapshot();
  }
  const own={snapshot,isTeamDirect:()=>!!active,
    async teamLogin(input){
      if(!input||Object.keys(input).some(k=>!['serverURL','username','password','name'].includes(k))||typeof input.username!=='string'||!input.username.trim()||typeof input.password!=='string'||!input.password||input.password.length>200)throw fail('TEAM_LOGIN_INPUT_INVALID');
      const origin=teamServerOrigin(input.serverURL),name=typeof input.name==='string'?input.name.slice(0,100):'团队服务器';
      const result=await json(origin,'/api/auth/login',{body:{username:input.username.trim(),password:input.password}});
      if(typeof result?.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw fail('TEAM_LOGIN_DENIED');
      const saved={origin,name,token:result.access_token,expiresAt:Date.now()+result.expires_in*1000};
      await base.disconnect();await activate(saved);await store.save(saved);return {authenticated:true};
    },
    async teamJoin(input){
      const origin=teamServerOrigin(input?.serverURL);
      if(!input||typeof input.code!=='string'||!input.code.trim()||typeof input.username!=='string'||!input.username.trim()||typeof input.password!=='string'||!input.password||input.password.length>200)throw fail('TEAM_LOGIN_INPUT_INVALID');
      const result=await json(origin,'/api/auth/invite/redeem',{body:{code:input.code.trim(),username:input.username.trim(),password:input.password,display_name:String(input.displayName||input.username).slice(0,128)}});
      if(typeof result?.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw fail('TEAM_LOGIN_DENIED');
      const saved={origin,name:'团队服务器',token:result.access_token,expiresAt:Date.now()+result.expires_in*1000};
      await base.disconnect();await activate(saved);await store.save(saved);return {authenticated:true};
    },
    async initialize(){
      let saved;try{saved=await store.load()}catch(error){masked=true;emit();throw error}
      if(saved){try{return await activate(saved)}catch(error){if(['TEAM_LOGIN_EXPIRED','TEAM_LOGIN_DENIED'].includes(error.code))await store.clear();masked=true;emit();return snapshot();}}
      await base.initialize();return snapshot();
    },
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener)},
    async applicationConnection(applicationId,options){
      if(!active){if(masked)throw fail('ACCOUNT_LOGIN_REQUIRED');return base.applicationConnection(applicationId,options)}
      const epoch=generation;assertLive(epoch);
      const link=transport.applicationConnection(applicationId,options);
      const r=await link.request({path:'/api/auth/me'});assertLive(epoch);
      if(r.status!==200)throw fail('TEAM_LOGIN_EXPIRED');
      const user=JSON.parse(r.body.toString('utf8'));
      if(user.id!==active.user.id||user.application_id!=='wanx')throw fail('TEAM_IDENTITY_INVALID');
      active.user=user;
      const context={protocolVersion:1,accountId:active.accountId,clientId,boxId:snapshot().connection.deviceId,user,connection:'ready'};
      return {...link,context(){assertLive(epoch);return structuredClone(context)},request:async input=>{assertLive(epoch);const r=await link.request(input);assertLive(epoch);return r},subscribe:listener=>{const fn=()=>{try{assertLive(epoch)}catch{listener({type:'invalidated',code:'TEAM_SESSION_CHANGED'})}};listeners.add(fn);return()=>listeners.delete(fn)}};
    },
    async applicationRequest(input){if(!active){if(masked)throw fail('ACCOUNT_LOGIN_REQUIRED');return base.applicationRequest(input)}return transport.request(input)},
    async applicationStream(input){if(!active){if(masked)throw fail('ACCOUNT_LOGIN_REQUIRED');return base.applicationStream(input)}return transport.openWebSocket(input)},
    async refreshDevices(){if(active)return snapshot();if(masked)return snapshot();return base.refreshDevices()},
    async listOwnershipTransfers(){return active||masked?[]:base.listOwnershipTransfers()},
    async disconnect(){if(active){generation++;await transport.close();transport=null;active=null;masked=true;emit();return snapshot()}return base.disconnect()},
    async logout(){if(active||masked){const saved=active;generation++;active=null;masked=true;await transport?.close();transport=null;await store.clear();if(saved)await json(saved.origin,'/api/auth/logout',{method:'POST',token:saved.token}).catch(()=>{});emit();return snapshot()}return base.logout()},
    async loginPassword(...args){if(masked){masked=false;if(base.snapshot().account?.phase==='authenticated')await base.logout()}return base.loginPassword(...args)},
    async close(){closed=true;generation++;stopBase();listeners.clear();await transport?.close();await base.close()}
  };
  return new Proxy(base,{get(target,key){return key in own?own[key]:typeof target[key]==='function'?target[key].bind(target):target[key]}});
}
