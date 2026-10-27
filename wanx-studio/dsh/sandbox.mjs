import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const q=JSON.stringify;
export async function sandboxCommand({taskRoot,port,extraEnv={},probe=false}){
  if(process.platform!=='darwin')throw new Error('ISOLATION_PLATFORM_UNSUPPORTED');
  taskRoot=await fs.realpath(taskRoot);
  const node=await fs.realpath(process.execPath),project=await fs.realpath(root);
  const libraries=new Set([path.resolve(path.dirname(node),'../lib')]),queue=[node],visited=new Set();
  while(queue.length){
    const file=queue.pop();if(visited.has(file))continue;visited.add(file);
    if(visited.size>128)throw new Error('RUNTIME_DEPENDENCY_LIMIT');
    for(const match of execFileSync('/usr/bin/otool',['-L',file],{encoding:'utf8'}).matchAll(/\n\s+(\S+)\s+\(compatibility/g)){
      let dependency=match[1];
      if(dependency.startsWith('@rpath/')){const name=dependency.slice(7);try{dependency=await fs.realpath(path.join(path.dirname(file),name))}catch{dependency=path.join(path.dirname(node),'../lib',name)}}
      if(dependency.startsWith('@loader_path/'))dependency=path.join(path.dirname(file),dependency.slice(13));
      if(!dependency.startsWith('/opt/homebrew/'))continue;
      const actual=await fs.realpath(dependency);libraries.add(path.dirname(actual));libraries.add(path.dirname(dependency));queue.push(actual);
    }
  }
  const sessionRoot=path.join(taskRoot,'sessions');await fs.mkdir(sessionRoot,{recursive:true,mode:0o700});
  const policy=`(version 1)(deny default)
    (allow file-read-metadata)
    (allow process-exec (literal ${q(node)}))
    (deny process-fork)
    (allow sysctl-read)
    (allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center"))
    (allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (subpath "/Library/Apple")
      (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
      ${[...libraries].map(p=>`(subpath ${q(p)})`).join(' ')}
      (subpath ${q(path.dirname(node))}) (subpath ${q(path.join(project,'node_modules'))}) (subpath ${q(path.join(project,'dsh'))})
      (literal ${q(project)}) (literal ${q(taskRoot)}) (subpath ${q(sessionRoot)}))
    (allow file-write* (subpath ${q(sessionRoot)}) (literal "/dev/null"))
    (allow network-outbound (remote ip ${q('localhost:'+port)}))`;
  return {command:'/usr/bin/sandbox-exec',args:['-p',policy,node,'--max-old-space-size=512',path.join(project,'dsh/engine.mjs'),...(probe?['--probe']:[])],env:{PATH:'/usr/bin:/bin',HOME:taskRoot,TMPDIR:sessionRoot,LANG:'en_US.UTF-8',OPENSSL_CONF:'/dev/null',WANX_TASK_SESSIONS:sessionRoot,DSH_TELEMETRY_DISABLED:'1',...extraEnv}};
}
export function spawnSandbox(spec){return spawn(spec.command,spec.args,{env:spec.env,stdio:['pipe','pipe','pipe'],detached:true})}
export async function stopGroup(child){
  if(!child?.pid)return;
  const alive=()=>{
    try{process.kill(-child.pid,0);return true}
    catch(error){
      if(error.code==='ESRCH')return false;
      // Darwin can briefly return EPERM while an exited member is reaped.
      // That is not evidence of closure: keep waiting, then enforce KILL.
      if(error.code==='EPERM')return true;
      throw error;
    }
  };
  try{process.kill(-child.pid,'SIGTERM')}catch(e){if(e.code==='ESRCH')return;throw e}
  // A wrapper may exit before its native descendants. Its exit event does not
  // prove that the process group has drained.
  const deadline=performance.now()+1500;
  while(alive()&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  if(alive()){try{process.kill(-child.pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}
}
