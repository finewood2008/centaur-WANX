import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,verify} from 'node:crypto';
import {createBoxManagementHost} from '../host.bundle.mjs';

function fixture() {
  const publicKeys=new Map(),calls=[];
  const request=async options=>{
    const path=new URL(options.url).pathname.replace('/prod-api','');
    const body=typeof options.data==='string'?JSON.parse(options.data):options.data;
    calls.push({path,body,method:options.method});
    const reply=data=>({statusCode:200,data:{success:true,data}});
    if(path==='/app-api/auth/sms/send') return reply({expiresIn:300,debugCode:'654321'});
    if(path==='/app-api/auth/sms/login') {
      publicKeys.set(body.clientId,body.clientPublicKey);
      return reply({accessToken:'secret-'+body.phone,refreshToken:'refresh-secret',accountId:body.phone,clientId:body.clientId});
    }
    const headers=options.headers;
    assert.ok(headers.Authorization.startsWith('Bearer secret-'));
    const hash=createHash('sha256').update(typeof options.data==='string'?options.data:'').digest('hex');
    assert.equal(headers['X-Nexus-Body-SHA256'],hash);
    const account=headers.Authorization.replace('Bearer secret-','');
    const canonical=['NEXUSAOS-CONSUMER-V1',account,headers['X-Nexus-Client-Id'],options.method,path,headers['X-Nexus-Timestamp'],headers['X-Nexus-Nonce'],hash].join('\n');
    assert.equal(verify('sha256',Buffer.from(canonical),publicKeys.get(headers['X-Nexus-Client-Id']),Buffer.from(headers['X-Nexus-Signature'],'base64')),true);
    const id='device-'+account;
    if(path==='/app-api/auth/logout') return reply({});
    if(path==='/app-api/devices') return reply([{deviceId:id,deviceName:'Synthetic box',role:'owner',scopes:['remote.p2p'],online:true,currentVersion:'1.0',accessToken:'must-not-leak'}]);
    if(path.endsWith('/ota')) return reply(options.method==='POST'?{updateId:'update-1',status:'pending',releaseId:body.releaseId,accessToken:'must-not-leak'}:{updates:[],availableRelease:{releaseId:'release-2',version:'2.0'},device:{deviceId:id}});
    if(path==='/app-api/ownership/transfers') return reply([{transferId:'incoming-1',deviceId:id,direction:'incoming',state:'pending'}]);
    if(path.endsWith('/ownership/transfer')||path.endsWith('/accept')) return reply({transferId:'transfer-1',deviceId:id,state:'pending',privateKey:'must-not-leak'});
    if(path.endsWith('/support-sessions')) return reply(options.method==='POST'?{sessionId:'support-1',deviceId:id,status:'active',scopes:body.scopes}:[]);
    if(path.includes('/support-sessions/')||path.startsWith('/app-api/auth/clients/')) return reply({});
    if(path==='/app-api/auth/clients') return reply([{clientId:'other',status:'active',platform:'macos',refreshToken:'must-not-leak'}]);
    if(path.endsWith('/factory-reset')) return reply({commandId:'reset-1',deviceId:id,status:'pending'});
    throw new Error('Unexpected request '+path);
  };
  const host=createBoxManagementHost({request});
  const login=(actor=1,phone='13800000001')=>host.action(actor,'account.login',{phone,verificationCode:'123456'});
  return {host,calls,login};
}

test('SDK signs protected requests; credentials and SMS debug codes never reach the UI',async()=>{
  const {host,login}=fixture();
  assert.deepEqual(await host.action(1,'account.sendSMS',{phone:'13800000001'}),{expiresIn:300});
  const state=await login();assert.equal(state.identity.accountId,'13800000001');
  const devices=await host.action(1,'devices.list');assert.equal(devices[0].deviceId,'device-13800000001');
  const clients=await host.action(1,'clients.list');assert.equal(clients[0].clientId,'other');
  assert.doesNotMatch(JSON.stringify({state,devices,clients}),/secret|accessToken|refreshToken|privateKey|654321/);
});
test('WANX users have distinct platform sessions and verified device ownership',async()=>{
  const {host,login}=fixture();await login(1);await login(2,'13800000002');
  assert.equal((await host.action(2,'devices.list'))[0].deviceId,'device-13800000002');
  await assert.rejects(host.action(1,'ota.status',{deviceId:'device-13800000002'}),/DEVICE_NOT_AUTHORIZED/);
  await host.action(1,'account.logout');assert.equal((await host.action(1,'state')).identity,null);
  assert.equal((await host.action(2,'state')).identity.accountId,'13800000002');
});
test('writes require confirmation and OTA uses the platform release instead of supplied metadata',async()=>{
  const {host,login,calls}=fixture();await login();const deviceId='device-13800000001';
  for(const action of ['ota.request','support.create','factory.reset','transfers.create','transfers.accept','clients.revoke']) await assert.rejects(host.action(1,action,{deviceId}),/CONFIRMATION_REQUIRED/);
  const update=await host.action(1,'ota.request',{deviceId,confirmed:true,releaseId:'forged'});assert.equal(update.releaseId,'release-2');
  assert.equal(calls.filter(c=>c.path.endsWith('/ota')&&c.method==='POST')[0].body.releaseId,'release-2');
  await assert.rejects(host.action(1,'factory.reset',{deviceId,confirmed:true,ownerPhone:'13800000001',verificationCode:'123456',confirmation:'YES'}),/CONFIRMATION_REQUIRED/);
  await assert.rejects(host.action(1,'support.create',{deviceId,confirmed:true,scopes:['root'],reason:'test',durationMinutes:30}),/INVALID_INPUT/);
});
test('all SDK management operations return sanitized business data',async()=>{
  const {host,login}=fixture();await login();const deviceId='device-13800000001';
  await host.action(1,'ota.status',{deviceId});await host.action(1,'transfers.list');
  await host.action(1,'transfers.create',{deviceId,confirmed:true,ownerPhone:'13800000001',targetPhone:'13800000002',verificationCode:'123456',retainData:false});
  await host.action(1,'transfers.accept',{transferId:'incoming-1',confirmed:true});
  await host.action(1,'support.list',{deviceId});
  await host.action(1,'support.create',{deviceId,confirmed:true,scopes:['support.logs'],reason:'test',durationMinutes:30});
  await host.action(1,'support.revoke',{deviceId,confirmed:true,sessionId:'support-1'});
  await host.action(1,'clients.revoke',{clientId:'other',confirmed:true});
  await host.action(1,'factory.reset',{deviceId,confirmed:true,ownerPhone:'13800000001',verificationCode:'123456',confirmation:'ERASE'});
  await assert.rejects(host.action(1,'arbitrary.fetch',{url:'http://localhost'}),/UNKNOWN_ACTION/);
});
