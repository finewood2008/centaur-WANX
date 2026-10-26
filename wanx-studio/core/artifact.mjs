import path from 'node:path';
import foundation from '../backend/wanx_studio/wanx-foundation.json' with {type:'json'};
import {build,transform} from 'esbuild';

export const LIMITS = Object.freeze({files:64,fileBytes:512*1024,totalBytes:2*1024*1024});
export function sourcePath(name) {
  if (typeof name!=='string' || !/^(miniapp\.manifest\.json|src\/[a-zA-Z0-9_/-]+\.(js|css|json))$/.test(name) || name.split('/').some(p=>p==='..'||p==='.'||!p) || name.length>180) throw new Error('SOURCE_PATH_DENIED');
  return name;
}
export function validateSources(files) {
  if (!files || typeof files!=='object' || Array.isArray(files) || Object.keys(files).length>LIMITS.files) throw new Error('SOURCE_LIMIT');
  let total=0;
  for (const [name,value] of Object.entries(files)) {
    sourcePath(name);
    if(typeof value!=='string'||Buffer.byteLength(value)>LIMITS.fileBytes) throw new Error('SOURCE_LIMIT');
    total+=Buffer.byteLength(value);
  }
  if(total>LIMITS.totalBytes)throw new Error('SOURCE_LIMIT');
  return files;
}
export async function compileArtifact(files) {
  validateSources(files);
  const manifest=JSON.parse(files['miniapp.manifest.json']||'null');
  const allowed=['schemaVersion','name','entry','capabilities','collections'];
  if(!manifest||Object.keys(manifest).some(k=>!allowed.includes(k))||manifest.schemaVersion!==1||manifest.entry!=='src/app.js'||!files[manifest.entry]||typeof manifest.name!=='string'||!manifest.name.trim()||manifest.name.length>80)throw new Error('MANIFEST_INVALID');
  if(!Array.isArray(manifest.capabilities)||manifest.capabilities.some(c=>!['data','model','files','knowledge','reports'].includes(c)))throw new Error('CAPABILITY_UNSUPPORTED');
  if(!manifest.collections||typeof manifest.collections!=='object'||Array.isArray(manifest.collections)||Object.keys(manifest.collections).length>20)throw new Error('SCHEMA_INVALID');
  for(const [name,fields]of Object.entries(manifest.collections)){if(!/^[a-z][a-z0-9_-]{0,49}$/.test(name)||!fields||typeof fields!=='object'||Array.isArray(fields)||!Object.keys(fields).length||Object.keys(fields).length>50||Object.entries(fields).some(([key,type])=>!/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(key)||!['string','number','boolean'].includes(type)))throw new Error('SCHEMA_INVALID')}
  const forbidden=new Set(foundation.forbiddenCredentialFields);
  if(Object.values(manifest.collections).some(fields=>Object.keys(fields).some(key=>forbidden.has(key.replace(/[_-]/g,'').toLowerCase()))))throw new Error('WANX_AUTH_REQUIRED');
  const styles=Object.keys(files).filter(name=>name.endsWith('.css')).sort();
  const styleEntry='.wanx-styles.css';
  const result=await build({entryPoints:['src/app.js',...(styles.length?[styleEntry]:[])],bundle:true,write:false,platform:'browser',format:'esm',metafile:true,target:'es2022',outdir:'out',logLevel:'silent',plugins:[{
    name:'wanx-virtual-files',setup(b){
      b.onResolve({filter:/.*/},args=>{
        if(args.kind==='entry-point'&&args.path===styleEntry)return {path:styleEntry,namespace:'wanx-styles'};
        if(args.namespace==='wanx-styles'){sourcePath(args.path);return {path:args.path,namespace:'wanx'}}
        const name=args.kind==='entry-point'?args.path:path.posix.normalize(path.posix.join(path.posix.dirname(args.importer),args.path));
        if(args.kind!=='entry-point'&&!args.path.startsWith('.'))throw new Error('DEPENDENCY_NOT_ALLOWED');
        sourcePath(name);
        if(!Object.hasOwn(files,name))throw new Error('IMPORT_NOT_FOUND');
        return {path:name,namespace:'wanx'};
      });
      b.onLoad({filter:/.*/,namespace:'wanx-styles'},()=>({contents:styles.map(name=>'@import '+JSON.stringify(name)+';').join('\n'),loader:'css'}));
      b.onLoad({filter:/.*/,namespace:'wanx'},args=>({contents:files[args.path],loader:args.path.endsWith('.css')?'css':args.path.endsWith('.json')?'json':'js'}));
    }
  }]});
  const source=result.outputFiles.find(f=>f.path.endsWith('.js'))?.text;
  const entry=Object.entries(result.metafile.outputs).find(([name])=>name.endsWith('.js'))?.[1];
  if(!source||!entry?.exports.includes('mount'))throw new Error('MOUNT_EXPORT_REQUIRED');
  const bundle=(await transform(source,{format:'iife',globalName:'WanxMiniapp',target:'es2022'})).code;
  return {manifest,bundle,css:result.outputFiles.find(f=>path.basename(f.path)===styleEntry)?.text||''};
}

export {frameDocument} from "./frame.mjs";
