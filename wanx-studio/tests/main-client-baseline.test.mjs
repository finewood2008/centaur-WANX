import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requireCurrentBaseline,mayRefreshBuilderFile} from '../integration/main-client-baseline.mjs';
test('concurrent WANX update invalidates a captured Builder overlay, even with the same version/build label',()=>{
 const b={identity:'ai.centuarai.wanx.client',archiveHash:'a'.repeat(64)};
 requireCurrentBaseline(b,b.archiveHash);
 assert.throws(()=>requireCurrentBaseline(b,'b'.repeat(64)),/REBASE_REQUIRED/);
 assert.throws(()=>requireCurrentBaseline({...b,preview:true},b.archiveHash),/IDENTITY_MISMATCH/);
 assert.throws(()=>requireCurrentBaseline({...b,identity:'isolated-client'},b.archiveHash),/IDENTITY_MISMATCH/);
});
test('Builder overlay cannot replace WANX shell, identity, upload/reconnect/space code or account files',()=>{
 for(const f of ['shell/main.mjs','applications/manager.mjs','local-ui/remote-preload.cjs','local-ui/renderer/renderer.js','shell/personal-space.mjs','network/index.mjs','package.json','account.enc','studio/workbench-other/file','../studio/workbench/ui/index.html','studio/workbench/../shell/main.mjs'])assert.equal(mayRefreshBuilderFile(f),false,f);
 for(const f of ['studio/workbench/ui/index.html','studio/embedded-workspace.mjs','applications/studio-runtime/runtime-main.cjs','local-ui/renderer/studio-home.js'])assert.equal(mayRefreshBuilderFile(f),true,f);
});
