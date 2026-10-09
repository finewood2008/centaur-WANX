import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createUniDeviceManagementClient, loadOrCreateClientIdentity, loadConsumerSession, clearConsumerSession } from './vendor/device-management-sdk.ts';

export const actions = ['state', 'account.sendSMS', 'account.login', 'account.logout', 'devices.list', 'ota.status', 'ota.request', 'transfers.list', 'transfers.create', 'transfers.accept', 'support.list', 'support.create', 'support.revoke', 'clients.list', 'clients.revoke', 'factory.reset'];
const fields = {
  device: ['deviceId','deviceName','role','scopes','ownershipEpoch','status','online','lastHeartbeat','currentVersion','currentSecurityVersion','updateAvailable','updateBlockReason'],
  client: ['clientId','platform','deviceModel','displayName','status','current','createdAt','lastSeenAt','revokedAt'],
  transfer: ['transferId','deviceId','state','direction','retainData','ownershipEpoch','createdAt','expiresAt','completedAt'],
  support: ['sessionId','deviceId','scopes','reason','status','createdAt','expiresAt','revokedAt'],
  update: ['updateId','deviceId','releaseId','status','securityVersion','currentVersion','targetVersion','progressPercent','errorCode','updatedAt'],
  release: ['releaseId','version','securityVersion','target','targetArch','hardwareProfile','publishedAt'],
  otaDevice: ['deviceId','component','currentVersion','currentSecurityVersion','availableVersion','availableSecurityVersion','updateAvailable','blockReason'],
  reset: ['commandId','deviceId','status','ownershipEpoch','expiresAt'],
};
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key,value[key]]));
const list = (value, keys) => {
  if (!Array.isArray(value)) throw new Error('INVALID_PLATFORM_RESPONSE');
  return value.map(item => pick(item, keys));
};
const text = (input, key, max=200) => {
  if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) throw new Error('INVALID_INPUT');
  return input[key].trim();
};
const phone = (input,key) => {const value=text(input,key,11); if(!/^1\d{10}$/.test(value)) throw new Error('INVALID_INPUT'); return value;};
const code = input => {const value=text(input,'verificationCode',6); if(!/^\d{6}$/.test(value)) throw new Error('INVALID_INPUT'); return value;};
const confirmed = input => {if(input.confirmed !== true) throw new Error('CONFIRMATION_REQUIRED');};

export function createBoxManagementHost({baseURL, request, allowLoopback=false}={}) {
  const base = new URL(baseURL || 'https://boss.nexusaos.qitus.cn/prod-api');
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(allowLoopback && base.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname)))) throw new Error('INVALID_PLATFORM_URL');
  const users = new Map();
  async function network(options) {
    if (request) return request(options);
    const url = new URL(options.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/,'')+'/app-api/')) throw new Error('INVALID_PLATFORM_URL');
    const response = await fetch(url,{method:options.method,headers:{'Content-Type':'application/json',...options.headers},...(options.data===undefined?{}:{body:typeof options.data==='string'?options.data:JSON.stringify(options.data)}),redirect:'error',signal:AbortSignal.timeout(15000)});
    const chunks=[]; let size=0;
    for await (const chunk of response.body || []) {size+=chunk.length; if(size>2*1024*1024) throw new Error('RESPONSE_TOO_LARGE'); chunks.push(chunk);}
    const body=Buffer.concat(chunks).toString('utf8');
    return {statusCode:response.status,data:body?JSON.parse(body):{}};
  }
  function context(actor) {
    if (!Number.isSafeInteger(actor) || actor<1) throw new Error('INVALID_ACTOR');
    if (users.has(actor)) return users.get(actor);
    const values=new Map(), keys=new Map();
    const storage={get:key=>values.get(key),set:(key,value)=>values.set(key,value),remove:key=>values.delete(key)};
    const keyAdapter={
      async generate(alias) {const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});keys.set(alias,pair);return {publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString()};},
      async getPublicKey(alias) {return keys.get(alias)?.publicKey.export({type:'spki',format:'pem'}).toString();},
      async sign(alias,payload) {if(!keys.has(alias)) throw new Error('KEY_UNAVAILABLE');return sign('sha256',payload,keys.get(alias).privateKey).toString('base64');},
    };
    const sdk=createUniDeviceManagementClient({baseUrl:base.href,request:network,storage,keyAdapter});
    const ctx={sdk,storage,keyAdapter,tail:Promise.resolve(),lastUsed:Date.now()};users.set(actor,ctx);return ctx;
  }
  async function run(ctx,action,input) {
    const sdk=ctx.sdk;
    if(action==='state') {const session=loadConsumerSession(ctx.storage);return {configured:true,sdkVersion:'1.0.1',identity:session?{accountId:session.accountId,clientId:session.clientId}:null};}
    if(action==='account.sendSMS') {const result=await sdk.sendSmsCode(phone(input,'phone'));return {expiresIn:result.expiresIn};}
    if(action==='account.login') {
      const identity=await loadOrCreateClientIdentity({storage:ctx.storage,keyAdapter:ctx.keyAdapter});
      // Replace only after a complete login response; no credential is returned to the UI.
      const session=await sdk.loginWithSms(phone(input,'phone'),code(input),{clientId:identity.clientId,clientPublicKey:identity.publicKey,platform:'unknown',deviceModel:'WANX Server',displayName:'WANX Box Management'});
      if(session.clientId!==identity.clientId) {clearConsumerSession(ctx.storage);throw new Error('INVALID_PLATFORM_RESPONSE');}
      return run(ctx,'state',{});
    }
    if(action==='account.logout') {await sdk.logout();return {identity:null};}
    if(!loadConsumerSession(ctx.storage)) throw new Error('LOGIN_REQUIRED');
    if(action==='devices.list') return list(await sdk.getDevices(),fields.device);
    if(action==='clients.list') return list(await sdk.getClients(),fields.client);
    if(action==='clients.revoke') {confirmed(input);await sdk.revokeClient(text(input,'clientId'));return {};}
    if(action==='transfers.list') return list(await sdk.getOwnershipTransfers(),fields.transfer);
    if(action==='transfers.accept') {confirmed(input);const transferId=text(input,'transferId');const rows=await sdk.getOwnershipTransfers();if(!rows.some(row=>row.transferId===transferId&&row.direction==='incoming'&&!row.completedAt))throw new Error('DEVICE_NOT_AUTHORIZED');return pick(await sdk.acceptOwnershipTransfer(transferId),fields.transfer);}
    if(action==='transfers.create') confirmed(input);
    const deviceId=text(input,'deviceId');
    // Management uses the authenticated SDK directory's verified device UUIDs.
    const devices=await sdk.getDevices();
    const device=devices.find(item=>item.deviceId===deviceId && item.role==='owner');
    if(!device) throw new Error('DEVICE_NOT_AUTHORIZED');
    if(action==='transfers.create') {confirmed(input);return pick(await sdk.createOwnershipTransfer(text(input,'deviceId'),{ownerPhone:phone(input,'ownerPhone'),verificationCode:code(input),targetPhone:phone(input,'targetPhone'),retainData:input.retainData===true}),fields.transfer);}
    if(action==='ota.status') {const result=await sdk.getOtaStatus(deviceId);return {updates:list(result.updates,fields.update),...(result.availableRelease?{availableRelease:pick(result.availableRelease,fields.release)}:{}),...(result.device?{device:pick(result.device,fields.otaDevice)}:{})};}
    if(action==='ota.request') {confirmed(input);const status=await sdk.getOtaStatus(deviceId);if(!device.online || !status.availableRelease || status.device?.blockReason) throw new Error('UPDATE_UNAVAILABLE');return pick(await sdk.requestOta(deviceId,{releaseId:status.availableRelease.releaseId,currentVersion:device.currentVersion,currentSecurityVersion:device.currentSecurityVersion,idempotencyKey:randomUUID()}),fields.update);}
    if(action==='support.list') return list(await sdk.getSupportSessions(deviceId),fields.support);
    if(action==='support.create') {confirmed(input);const scopes=input.scopes;if(!Array.isArray(scopes)||!scopes.length||scopes.some(s=>!['support.logs','support.ssh','support.vnc'].includes(s))) throw new Error('INVALID_INPUT');if(!Number.isInteger(input.durationMinutes)||input.durationMinutes<1||input.durationMinutes>120) throw new Error('INVALID_INPUT');return pick(await sdk.createSupportSession(deviceId,{scopes,reason:text(input,'reason',500),durationMinutes:input.durationMinutes}),fields.support);}
    if(action==='support.revoke') {confirmed(input);await sdk.revokeSupportSession(deviceId,text(input,'sessionId'));return {};}
    if(action==='factory.reset') {confirmed(input);if(input.confirmation!=='ERASE') throw new Error('CONFIRMATION_REQUIRED');return pick(await sdk.requestFactoryReset(deviceId,{ownerPhone:phone(input,'ownerPhone'),verificationCode:code(input),confirmation:'ERASE'}),fields.reset);}
    throw new Error('UNKNOWN_ACTION');
  }
  return {
    async action(actor,action,input={}) {
      if(!actions.includes(action)) throw new Error('UNKNOWN_ACTION');
      const ctx=context(actor);
      const next=ctx.tail.then(()=>run(ctx,action,{...input,actor}));
      ctx.tail=next.catch(()=>{});ctx.lastUsed=Date.now();return next;
    },
    close(){users.clear();},
  };
}
