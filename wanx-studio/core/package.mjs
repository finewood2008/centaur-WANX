import{mkdir,writeFile,copyFile,readFile,readdir}from'node:fs/promises';
import path from'node:path';
import{fileURLToPath}from'node:url';
import{frameDocument}from'./frame.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
export function validatePortable(payload){
  if(!/^ai\.wanx\.selfmade\.[a-f0-9]{32}$/.test(payload.applicationId)||!/^[a-f0-9]{64}$/.test(payload.artifactHash)||!/^\d+\.\d+\.\d+$/.test(payload.version))throw new Error('SELFMADE_PACKAGE_INVALID');
  const generated=JSON.stringify({manifest:payload.manifest,bundle:payload.bundle,css:payload.css});
  if(/(?:\bsk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.|\/Users\/|\/Volumes\/|\/home\/|192\.168\.\d+\.\d+|127\.0\.0\.1:\d+)/.test(generated))throw new Error('PACKAGE_CONTAINS_PRIVATE_LOCATOR');
  if(Buffer.byteLength(generated)>4*1024*1024)throw new Error('PACKAGE_TOO_LARGE');
}
export async function writeMiniappPackage(payload,directory,{assets=path.join(root,'dist/runtime')}={}){
  validatePortable(payload);await mkdir(directory,{recursive:true,mode:0o700});
  const manifest={applicationId:payload.applicationId,name:payload.name,version:payload.version,protocolVersion:1,runtime:'electron',launchMode:'shared',entrypoint:'runtime-main.cjs',description:'本人自造的万象小应用',installationSource:'selfmade'};
  await writeFile(path.join(directory,'application.manifest.json'),JSON.stringify(manifest,null,2));
  // No source project/task/owner/box identity, credentials, selected materials or data.
  const portable={applicationId:payload.applicationId,name:payload.name,version:payload.version,artifactHash:payload.artifactHash,manifest:payload.manifest,bundle:payload.bundle,css:payload.css};
  await writeFile(path.join(directory,'miniapp.runtime.json'),JSON.stringify(portable,null,2));
  // A packaged document gets its own CSP; srcdoc would inherit the trusted
  // parent's script-src and block the generated app's inline bootstrap.
  await writeFile(path.join(directory,'miniapp-frame.html'),frameDocument(payload.bundle,payload.css));
  for(const file of ['runtime-main.cjs','runtime-preload.cjs','runtime-renderer.js','runtime.html'])await copyFile(path.join(assets,file),path.join(directory,file));
  return manifest;
}
