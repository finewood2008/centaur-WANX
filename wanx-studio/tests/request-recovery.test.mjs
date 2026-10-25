import{test}from'node:test';import assert from'node:assert/strict';
import{requestErrorCode,transientRequestError,receivedOperation}from'../core/request-errors.mjs';
import{build}from'esbuild';

test('IPC abort details map to a stable code without hiding identity or business failures',()=>{
 assert.equal(requestErrorCode(new Error("Error invoking remote method 'studio-embedded:request': AbortError: The operation was aborted")),'HOST_REQUEST_TIMEOUT');
 assert.equal(requestErrorCode(new DOMException('The operation was aborted','AbortError')),'HOST_REQUEST_TIMEOUT');
 assert.equal(requestErrorCode(new Error('Error invoking remote method: Error: HOST_SESSION_EXPIRED')),'HOST_SESSION_EXPIRED');
 assert.equal(transientRequestError(new Error('CAPABILITY_CHECK_REQUIRED')),false);
 assert.equal(transientRequestError(new Error('STUDIO_ADMIN_REQUIRED')),false);
 assert.equal(receivedOperation({messages:[{operationId:'saved'}]},'saved'),true);
 assert.equal(receivedOperation({preparation:{interview:{turns:[{operationId:'queued',state:'paused'}]}}},'queued'),true);
 assert.equal(receivedOperation({messages:[]},'unknown'),false);
});
test('actual renderer API retries a failed read once and never blindly replays writes',async()=>{
 const bundled=await build({entryPoints:['ui/api.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const api=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
 const previous=globalThis.window;let calls=0;
 globalThis.window={wanxStudio:{request:async()=>{if(++calls===1)throw new Error("Error invoking remote method 'studio-embedded:request': AbortError: The operation was aborted");return{stage:'building'}}}};
 try{
  assert.deepEqual(await api.api('/projects/synthetic'),{stage:'building'});assert.equal(calls,2);
  calls=0;globalThis.window.wanxStudio.request=async()=>{calls++;throw new DOMException('The operation was aborted','AbortError')};
  await assert.rejects(api.api('/projects/synthetic/build','POST',{operationId:'same-on-manual-retry'}));assert.equal(calls,1);
  assert.doesNotMatch(api.errorText(new DOMException('The operation was aborted','AbortError')),/remote method|AbortError|operation was aborted/);
  calls=0;globalThis.window.wanxStudio.request=async()=>{calls++;throw Error('HOST_SESSION_EXPIRED')};
  await assert.rejects(api.api('/context'),/HOST_SESSION_EXPIRED/);assert.equal(calls,1);
 }finally{globalThis.window=previous}
});
