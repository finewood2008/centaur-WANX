import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../local-ui/remote-preload.cjs', import.meta.url), 'utf8');
test('knowledge access management crosses only the fixed native data IPC actions', async () => {
  const exposed = {}, calls = [];
  vm.runInNewContext(source, {
    process: {platform:'darwin'},
    require: () => ({contextBridge:{exposeInMainWorld:(name,value)=>{exposed[name]=value;}},
      ipcRenderer:{on(){},invoke:async(name,input)=>{
        calls.push([name,input]);
        return name==='wanx-client:data'?{ok:true,value:{revision:1}}:{phase:'ready',account:{phase:'authenticated'}};
      }}}),
  });
  for(const action of ['assistant-access','assistant-access-update']) {
    const input={warehouseId:'11111111-1111-4111-8111-111111111111'};
    assert.equal((await exposed.wanxClient.action('data.'+action,input)).ok,true);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.findLast(([name])=>name==='wanx-client:data'))),['wanx-client:data',{action,input}]);
  }
  const before=calls.filter(([name])=>name==='wanx-client:data').length;
  assert.equal((await exposed.wanxClient.action('data.arbitrary-admin-route',{})).code,'UNKNOWN_CLIENT_ACTION');
  assert.equal(calls.filter(([name])=>name==='wanx-client:data').length,before);
});
