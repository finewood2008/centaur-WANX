import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const methods=['list','detail','save','toggle','delete','test','start','poll','cancel'];
async function preload(file) {
  const exposed={},calls=[];
  vm.runInNewContext(await readFile(new URL(file,import.meta.url),'utf8'),{
    process:{platform:'darwin'},
    require:name=>{assert.equal(name,'electron');return {
      contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}},
      ipcRenderer:{on(){},removeListener(){},invoke:async(...args)=>{calls.push(args);return {ok:true};}},
    };},
  });
  return {exposed,calls};
}

test('full assistant exposes fixed channel operations without an arbitrary route or deferred voice API',async()=>{
  const {exposed,calls}=await preload('../local-ui/remote-preload.cjs');
  for(const method of methods) {
    const input={scope:'synthetic-owner-box',id:'synthetic-channel'};
    const result=await exposed.wanxClient.action('dialogue.channels-'+method,input);
    assert.equal(result.ok,true);
    assert.deepEqual(calls.findLast(([name])=>name==='wanx-client:ai-dialogue-channels-'+method),['wanx-client:ai-dialogue-channels-'+method,input]);
  }
  const before=calls.filter(([name])=>name!=='wanx-client:get-state').length;
  for(const action of ['dialogue.channels-arbitrary-route','dialogue.voice-start']) {
    assert.equal((await exposed.wanxClient.action(action,{path:'/api/users'})).code,'UNKNOWN_CLIENT_ACTION');
  }
  assert.equal(calls.filter(([name])=>name!=='wanx-client:get-state').length,before);
});

test('mini assistant cannot invoke channel management through its preload',async()=>{
  const {exposed,calls}=await preload('../local-ui/panel-preload.cjs');
  for(const method of methods) {
    const result=await exposed.wanxPanelAssistant.request('dialogue.channels-'+method,{});
    assert.equal(result.ok,false);assert.equal(result.code,'PANEL_ACTION_NOT_ALLOWED');
  }
  assert.equal(calls.length,0);
});
