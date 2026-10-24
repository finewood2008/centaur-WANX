// Wrap the Host-bound workbench in its own macOS application identity. The
// backend, account and data directory continue to come from the WANX Host.
import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

if(process.platform!=='darwin')throw Error('MACOS_BUILD_REQUIRED');
const root=fileURLToPath(new URL('..',import.meta.url));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const source=path.join(root,'release','wanx-studio-'+version);
const manifest=JSON.parse(await readFile(path.join(source,'application.manifest.json'),'utf8'));
if(manifest.applicationId!=='ai.wanx.studio')throw Error('BUILDER_IDENTITY_INVALID');
const destination=path.join(root,'release',`wanx-builder-macos-${process.arch}-${version}`);
const appName='万象·开物',bundle=path.join(destination,appName+'.app');
const electron=process.argv[2]||path.resolve(root,'../wanx-team-client/node_modules/electron/dist/Electron.app');
await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true});
await cp(electron,bundle,{recursive:true,verbatimSymlinks:true});
const resources=path.join(bundle,'Contents/Resources');
await rm(path.join(resources,'default_app.asar'),{force:true});
await cp(source,path.join(resources,'app'),{recursive:true});
await writeFile(path.join(resources,'app/package.json'),JSON.stringify({name:'wanx-builder',productName:appName,version,private:true,main:'shell/main.cjs'},null,2));
await cp(path.resolve(root,'../wanx-team-client/resources/icon.icns'),path.join(resources,'icon.icns'));
const plist=path.join(bundle,'Contents/Info.plist');
const info=JSON.parse(execFileSync('plutil',['-convert','json','-o','-',plist],{encoding:'utf8'}));
Object.assign(info,{CFBundleIdentifier:manifest.applicationId,CFBundleName:appName,CFBundleDisplayName:appName,CFBundleShortVersionString:version,CFBundleVersion:version,CFBundleIconFile:'icon.icns'});
delete info.ElectronAsarIntegrity;
const temporary=path.join(destination,'Info.json');await writeFile(temporary,JSON.stringify(info));
execFileSync('plutil',['-convert','xml1','-o',plist,temporary]);await rm(temporary);
execFileSync('codesign',['--force','--deep','--sign','-',bundle],{stdio:'pipe'});
execFileSync('codesign',['--verify','--deep','--strict',bundle],{stdio:'pipe'});
await writeFile(path.join(destination,'application.manifest.json'),JSON.stringify({...manifest,launchMode:'bundled',entrypoint:appName+'.app/Contents/MacOS/'+info.CFBundleExecutable,platform:'darwin',arch:process.arch},null,2));
console.log(JSON.stringify({applicationId:manifest.applicationId,name:appName,version,bundle,destination,signatureVerified:true}));
