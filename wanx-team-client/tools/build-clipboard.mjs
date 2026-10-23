import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
if(process.platform==='darwin'){
  const root=fileURLToPath(new URL('../',import.meta.url)),source=path.join(root,'native/clipboard.swift');
  mkdirSync(path.join(root,'native/bin'),{recursive:true});
  for(const arch of (process.argv.slice(2).length?process.argv.slice(2):[process.arch])){
    if(!['arm64','x64'].includes(arch))throw Error('Unsupported clipboard architecture');
    const target=arch==='x64'?'x86_64':'arm64',file=path.join(root,`native/bin/wanx-clipboard-darwin-${arch}`);
    const digest=createHash('sha256').update(readFileSync(source)).update(target).digest('hex');
    if(!existsSync(file)||!existsSync(file+'.sha256')||readFileSync(file+'.sha256','utf8')!==digest){
      execFileSync('xcrun',['swiftc','-O','-target',`${target}-apple-macos12.0`,source,'-o',file],{stdio:'inherit'});
      writeFileSync(file+'.sha256',digest);
    }
  }
}
