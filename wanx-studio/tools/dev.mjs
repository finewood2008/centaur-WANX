import {spawn} from 'node:child_process';
const root=new URL('..',import.meta.url);
const backend=spawn('uv',['run','--project','backend','python','-m','wanx_studio.local'],{cwd:root,stdio:'inherit'});
const frontend=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1'],{cwd:root,stdio:'inherit'});
const stop=()=>{backend.kill('SIGTERM');frontend.kill('SIGTERM')};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
backend.once('exit',code=>{if(code)stop()});frontend.once('exit',stop);
