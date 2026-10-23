#!/usr/bin/env node
// Adapt ACP's stdio app-server transport to this task's single private server.
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const trace=(direction,line)=>{if(process.env.WANX_PROXY_TRACE){const x=JSON.parse(line);appendFileSync(process.env.WANX_PROXY_TRACE,JSON.stringify({direction,id:x.id,method:x.method,error:x.error})+'\n',{mode:0o600})}};
import WebSocket from 'ws';
import {socketURL} from './shared-server.mjs';

if(process.argv[2]!=='app-server'||!process.env.WANX_CODEX_SOCKET)process.exit(1);
const ws=new WebSocket(socketURL(process.env.WANX_CODEX_SOCKET));
const ready=new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
ws.on('message',data=>{trace('in',data.toString());process.stdout.write(data.toString()+'\n')});
ws.on('close',()=>process.exit(0));
ws.on('error',()=>process.exit(1));
const lines=readline.createInterface({input:process.stdin});
const iterator=lines[Symbol.asyncIterator]();
try{await ready;for await(const line of iterator){JSON.parse(line);trace('out',line);ws.send(line)}}finally{ws.close();lines.close()}
