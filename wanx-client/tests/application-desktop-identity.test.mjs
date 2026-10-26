import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm,realpath} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {applicationIcon,applicationExecutable} from '../applications/desktop-runtime.mjs';
test('application icon belongs to its installed package; external symlinks are not trusted',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'app-icon-'));
 try{await mkdir(path.join(root,'resources'));await writeFile(path.join(root,'resources/icon.png'),'own');assert.equal(await applicationIcon(root),await realpath(path.join(root,'resources/icon.png')));await rm(path.join(root,'resources/icon.png'));await symlink('/etc/hosts',path.join(root,'resources/icon.png'));assert.equal(await applicationIcon(root),null);}finally{await rm(root,{recursive:true,force:true});}
});
test('bundled apps and development/Windows runtimes retain their existing executable',async()=>{
 for(const options of [{platform:'win32'},{platform:'linux'},{platform:'darwin'},{platform:'darwin',record:{launchMode:'bundled'}}])assert.equal(await applicationExecutable({applicationRoot:'/unused',record:{},electronPath:'/dev/runtime',...options}),'/dev/runtime');
});
