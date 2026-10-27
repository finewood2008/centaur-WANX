import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../integration/team-client/view.js',import.meta.url),'utf8');
function fixture(identitySecurityEnabled=false){
  const calls=[],dialogs=[],window={};let readIdentity=0;
  const document={querySelectorAll:()=>[],body:{append:d=>dialogs.push(d)},createElement:()=>{
    const form={},error={},button={};return {dataset:{},querySelector:selector=>selector==='form'?form:selector.includes('error')?error:button,addEventListener(){},showModal(){},close(){this.closed=true},remove(){}};
  }};
  vm.runInNewContext(source,{window,document,queueMicrotask,setInterval:()=>0,clearInterval(){},FormData:class{}});
  const view=window.createTeamView({changed(){},request:async(name,input)=>{calls.push([name,input]);
    if(name==='team.identity'){readIdentity++;return {membershipId:'1',displayName:'Owner',permissions:['applications.manage']}}
    if(name==='team.members')return [{membershipId:'1',subject:'Owner',roleId:'manager',status:'active'},{membershipId:'2',subject:'Member',roleId:'member',status:'active'}];
    if(name==='team.invites')return [{invitationId:'3',code:'NATIVE-INVITE',roleId:'member',status:'active'}];
    if(name==='team.invite.create')return {code:'NATIVE-INVITE'};
    if(['team.catalog','team.projects'].includes(name))return [];
    return {opened:true};
  }});
  const state=accountId=>({canLaunchApplications:true,account:{accountId,clientId:'client'},connection:{deviceId:'box'},team:{identitySecurityEnabled}});
  return {view,calls,dialogs,state,reads:()=>readIdentity};
}
test('disabled identity security team view uses native member and invitation actions',async()=>{
  const f=fixture();f.view.sync(f.state('one'));await new Promise(resolve=>setImmediate(resolve));await f.view.action('manage');
  assert.match(f.view.page(),/NATIVE-INVITE/);assert.doesNotMatch(f.view.page(),/双钥|独立安全窗口|已批准的管理设备/);
  await f.view.action('invite');assert.ok(f.calls.some(([name])=>name==='team.invite.create'));assert.match(f.dialogs.at(-1).innerHTML,/NATIVE-INVITE/);
  await f.view.action('member',{id:'2',disabled:'true'});await f.dialogs.at(-1).querySelector('form').onsubmit({preventDefault(){},currentTarget:{querySelector:()=>({})}});
  assert.equal(f.calls.find(([name])=>name==='team.member.update')[1].id,2);
  await f.view.action('invite-revoke',{id:'3'});assert.equal(f.calls.find(([name])=>name==='team.invite.revoke')[1].id,3);
  assert.equal(f.calls.some(([name])=>name==='team.security'),false);
  const reads=f.reads();f.view.sync(f.state('two'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.reads(),reads+1);
});
test('enabled identity security retains the dedicated security surface',async()=>{
  const f=fixture(true);f.view.sync(f.state('one'));await new Promise(resolve=>setImmediate(resolve));await f.view.action('manage');
  for(const action of ['invite','member','invite-revoke'])await f.view.action(action,{id:'2'});
  assert.equal(f.calls.filter(([name])=>name==='team.security').length,3);
  assert.equal(f.calls.some(([name])=>name==='team.member.update'),false);
});
