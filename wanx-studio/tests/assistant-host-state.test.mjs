import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../integration/team-client/ai-dialogue.js',import.meta.url),'utf8');
const account={phase:'authenticated',accountId:'synthetic-owner',clientId:'synthetic-client'};
const connection={deviceId:'synthetic-box',gatewayURL:'http://127.0.0.1:18101',name:'Synthetic box'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const window={},calls=[];
  vm.runInNewContext(source,{window,URL,setTimeout,clearTimeout,clearInterval,AbortController});
  const view=window.createAIDialogueView({request:async(action,input)=>{
    calls.push({action,input});
    return {ok:true,value:action==='dialogue.load'?{scope:'scope-'+calls.filter(c=>c.action==='dialogue.load').length,models:[{id:'synthetic/one'}],defaultModel:'synthetic/one',sessions:[],legacySessions:[]}:{}};
  }});
  view.visible(true);return {view,calls};
}
for(const compact of [false,true]) test(`projected connected state starts the ${compact?'mini':'full'} assistant`,async()=>{
  const window={},calls=[];vm.runInNewContext(source,{window,URL,setTimeout,clearTimeout,clearInterval,AbortController});
  const view=window.createAIDialogueView({compact,request:async action=>{
    calls.push(action);return {ok:true,value:action==='dialogue.load'?{scope:'synthetic-scope',models:[],sessions:[],legacySessions:[]}:{}};
  }});
  view.visible(true);
  view.hostState({phase:'connected',connectionPhase:'ready',canLaunchApplications:true,account,connection,activeDeviceId:connection.deviceId});
  await tick();assert(calls.includes('dialogue.load'));assert.equal(view.snapshot().scope,'synthetic-scope');
});
test('raw ready and projected recovery retain the same assistant scope',async()=>{
  const {view,calls}=fixture();
  view.hostState({phase:'ready',account,connection});await tick();const scope=view.snapshot().scope;
  assert(scope);
  view.hostState({phase:'connected',connectionPhase:'ready',canLaunchApplications:true,account,connection,activeDeviceId:connection.deviceId});await tick();
  view.hostState({phase:'idle',connectionPhase:'recovering',canLaunchApplications:false,account,connection,selectedDeviceId:connection.deviceId});await tick();
  assert.equal(view.snapshot().scope,scope);assert.equal(calls.filter(c=>c.action==='dialogue.load').length,1);
});
test('a selected but disconnected or unavailable box does not start the assistant',async()=>{
  for(const state of [
    {phase:'idle',connectionPhase:'disconnected',canLaunchApplications:false},
    {phase:'idle',connectionPhase:'ready',canLaunchApplications:false},
    {phase:'disconnected'},
  ]){
    const {view,calls}=fixture();view.hostState({...state,account,connection,selectedDeviceId:connection.deviceId});await tick();
    assert.equal(view.snapshot().scope,null);assert(!calls.some(c=>c.action==='dialogue.load'));
  }
});
test('disconnect clears the old scope and reconnect or box switch loads the current box',async()=>{
  const {view,calls}=fixture(),ready={phase:'connected',connectionPhase:'ready',canLaunchApplications:true,account,connection,activeDeviceId:connection.deviceId};
  view.hostState(ready);await tick();assert(view.snapshot().scope);
  view.hostState({...ready,phase:'idle',connectionPhase:'disconnected',canLaunchApplications:false,activeDeviceId:null});await tick();assert.equal(view.snapshot().scope,null);
  view.hostState(ready);await tick();assert(view.snapshot().scope);
  view.hostState({...ready,connection:{...connection,deviceId:'second-synthetic-box'},activeDeviceId:'second-synthetic-box'});await tick();
  assert.equal(calls.filter(c=>c.action==='dialogue.load').length,3);
  view.hostState({...ready,account:{...account,phase:'signed_out'}});await tick();assert.equal(view.snapshot().scope,null);
});
