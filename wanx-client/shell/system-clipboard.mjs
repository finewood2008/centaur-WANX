import {execFile} from 'node:child_process';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import path from 'node:path';

export function createSystemClipboard({clipboard,nativeImage,app,directory,platform=process.platform,arch=process.arch}){
  const installed=app.isPackaged||['app','app.asar'].some(n=>path.resolve(app.getAppPath())===path.resolve(process.resourcesPath,n));
  const helper=installed?path.join(process.resourcesPath,'network',`wanx-clipboard-darwin-${arch}`):fileURLToPath(new URL(`../native/bin/wanx-clipboard-darwin-${arch}`,import.meta.url));
  async function files(action,paths){
    let binary=helper,args=[action];
    if(platform==='win32'){
      const source=await readFile(new URL('./clipboard-windows.ps1',import.meta.url));
      const digest=createHash('sha256').update(source).digest('hex');await mkdir(directory,{recursive:true,mode:0o700});
      const script=path.join(directory,`clipboard-${digest}.ps1`);await writeFile(script,source,{mode:0o600});
      binary=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      args=['-NoLogo','-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',script,'-Action',action];
    }
    if(!['darwin','win32'].includes(platform))throw Object.assign(Error('CLIPBOARD_PLATFORM_UNSUPPORTED'),{code:'CLIPBOARD_PLATFORM_UNSUPPORTED'});
    return new Promise((resolve,reject)=>{const child=execFile(binary,args,{windowsHide:true,timeout:15000,maxBuffer:1024*1024},(error,stdout)=>{
      if(error)return reject(Object.assign(Error('CLIPBOARD_NATIVE_FAILED'),{code:'CLIPBOARD_NATIVE_FAILED'}));
      try{resolve(JSON.parse(stdout.replace(/^\uFEFF/,'')));}catch{reject(Object.assign(Error('CLIPBOARD_NATIVE_FAILED'),{code:'CLIPBOARD_NATIVE_FAILED'}));}
    });child.stdin.end(paths?JSON.stringify(paths):'');});
  }
  return {
    async read(){const f=await files('read');if(f.paths?.length)return {paths:f.paths};if(f.virtual)return {virtual:true};
      const image=clipboard.readImage();if(!image.isEmpty())return {image:image.toPNG().toString('base64')};
      return {text:clipboard.readText()};},
    writeText:text=>clipboard.writeText(text),
    writeImage:bytes=>{const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw Object.assign(Error('CLIPBOARD_INVALID_IMAGE'),{code:'CLIPBOARD_INVALID_IMAGE'});clipboard.writeImage(image);},
    writeFiles:paths=>files('write',paths),
  };
}
