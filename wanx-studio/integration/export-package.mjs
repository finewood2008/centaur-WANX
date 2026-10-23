import {mkdtemp,rm,rename,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {writeMiniappPackage} from '../core/package.mjs';
const exec=promisify(execFile);
const fail=code=>Object.assign(new Error(code),{code});
export async function exportStudioPackage({input,request,assertLive,assets,chooseExport}) {
  if(!input||input.protocolVersion!==2||Object.keys(input).some(k=>!['protocolVersion','projectId','taskId','artifactHash','version'].includes(k))||!/^[a-f0-9]{32}$/.test(input.projectId)||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(input.taskId)||!/^[a-f0-9]{64}$/.test(input.artifactHash)||!/^\d+\.\d+\.\d+$/.test(input.version))throw fail('STUDIO_EXPORT_INVALID');
  const read=async()=>{
    assertLive();const payload=await request(`/projects/${input.projectId}/install/${input.artifactHash}`);assertLive();
    if(payload.artifactHash!==input.artifactHash||payload.taskId!==input.taskId||payload.version!==input.version)throw fail('ACCEPTANCE_STALE');
    return payload;
  };
  const payload=await read();
  const destination=await chooseExport(`${payload.applicationId}-${payload.version}.zip`);assertLive();
  if(!destination)return{state:'cancelled'};
  // The destination comes from a native save dialog, never the renderer.
  const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-package-'));
  const temporary=await mkdtemp(path.join(path.dirname(destination),'.wanx-export-'));
  try {
    await writeMiniappPackage(payload,directory,{assets});
    const archive=path.join(temporary,'application.zip');
    await exec('/usr/bin/zip',['-q','-r',archive,'.'],{cwd:directory});
    const fresh=await read();
    if(JSON.stringify(fresh)!==JSON.stringify(payload))throw fail('ACCEPTANCE_STALE');
    assertLive();await rename(archive,destination);
    const sha256=createHash('sha256').update(await readFile(destination)).digest('hex');
    return{state:'exported',path:destination,sha256,version:payload.version,artifactHash:payload.artifactHash};
  } finally {await rm(directory,{recursive:true,force:true});await rm(temporary,{recursive:true,force:true})}
}
