import {copyFile,mkdir,readFile,rename,rm,writeFile,realpath,access} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
const candidates=['resources/icon.png','resources/icon.icns','frontend/spark-logo.png','public/icon.png','renderer/icon.png','icon.png'];
export async function applicationIcon(directory,applicationId){
 const root=await realpath(directory);
 for(const name of candidates){try{const file=await realpath(path.join(root,name));if(file.startsWith(root+path.sep)){await access(file);return file;}}catch{}}
 const catalog={'centaurai.wanx.ai-browser':'browser','centaurai.wanx.huohua-publisher':'publisher','centaurai.wanx.huohua-self-media':'publisher','centaurai.media-express':'publisher','centaurai.wanx.semantica':'xingtu','centaurai.wanx.superadvisors':'council','centaurai.wanx.zhijun':'zhijun'};
 if(catalog[applicationId])return fileURLToPath(new URL(`../local-ui/renderer/assets/app-icons/${catalog[applicationId]}-v1.png`,import.meta.url));
 return null;
}
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
// Sharing Electron does not require sharing the host's macOS application identity.
// Clone the complete component layout: Electron's helpers cannot run reliably
// through a symlinked Frameworks directory. APFS shares unchanged file blocks.
export async function applicationExecutable({record,applicationRoot,electronPath=process.execPath,platform=process.platform}){
 if(platform!=='darwin'||record.launchMode==='bundled'||!electronPath.includes('.app/Contents/MacOS/'))return electronPath;
 const contents=path.dirname(path.dirname(electronPath)),hostPlist=await readFile(path.join(contents,'Info.plist'));
 const image=await applicationIcon(record.installPath,record.applicationId);
 const executableName=path.basename(electronPath);
 const stamp=createHash('sha256').update('desktop-identity-v3').update(hostPlist).update(electronPath).update(record.applicationId).update(record.version).update(image?await readFile(image):'').digest('hex').slice(0,20);
 const base=path.join(applicationRoot,'.launchers',record.applicationId,stamp),bundle=path.join(base,'Application.app'),executable=path.join(bundle,'Contents/MacOS',executableName);
 try{await access(path.join(base,'ready'));return executable;}catch{}
 const temporary=base+'-'+randomUUID(),out=path.join(temporary,'Application.app/Contents');
 await mkdir(temporary,{recursive:true,mode:0o700});
 try{
  try{await run('/bin/cp',['-cR',path.dirname(contents),path.dirname(out)]);}
  catch{await rm(path.dirname(out),{recursive:true,force:true});await run('/bin/cp',['-R',path.dirname(contents),path.dirname(out)]);}
  const original=JSON.parse((await run('/usr/bin/plutil',['-convert','json','-o','-',path.join(contents,'Info.plist')])).stdout);
  const id='ai.wanx.application.'+createHash('sha256').update(applicationRoot+record.applicationId).digest('hex').slice(0,24);
  // Electron locates the shared Helper apps using the original executable/name.
  // Desktop identity uses its own bundle ID, display name and icon instead.
  Object.assign(original,{CFBundleIdentifier:id,CFBundleDisplayName:record.name});
  delete original.CFBundleURLTypes;delete original.LSUIElement;
  if(image?.endsWith('.icns')){await copyFile(image,path.join(out,'Resources/application.icns'));original.CFBundleIconFile='application.icns';}
  else if(image){
   const input=path.join(temporary,'icon.png');await writeFile(input,await readFile(image));
   const icons=path.join(temporary,'app.iconset');await mkdir(icons);
   for(const size of [16,32,128,256,512])for(const scale of [1,2])await run('/usr/bin/sips',['-s','format','png','-z',String(size*scale),String(size*scale),input,'--out',path.join(icons,`icon_${size}x${size}${scale===2?'@2x':''}.png`)]);
   await run('/usr/bin/iconutil',['-c','icns',icons,'-o',path.join(out,'Resources/application.icns')]);original.CFBundleIconFile='application.icns';await rm(icons,{recursive:true});await rm(input);
  }
  const plist=path.join(out,'Info.plist');await writeFile(plist,JSON.stringify(original));await run('/usr/bin/plutil',['-convert','xml1',plist]);
  await run('/usr/bin/codesign',['--force','--sign','-','--preserve-metadata=entitlements,flags,runtime',path.dirname(out)]);
  await run('/usr/bin/codesign',['--verify',path.dirname(out)]);
  await writeFile(path.join(temporary,'ready'),xml(record.applicationId));await mkdir(path.dirname(base),{recursive:true});await rename(temporary,base);
  return executable;
 }catch(error){await rm(temporary,{recursive:true,force:true});throw Object.assign(Error('APPLICATION_DESKTOP_IDENTITY_FAILED'),{code:'APPLICATION_DESKTOP_IDENTITY_FAILED',cause:error});}
}
