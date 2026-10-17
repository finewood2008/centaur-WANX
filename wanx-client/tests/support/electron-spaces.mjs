import assert from 'node:assert/strict';
import {app,BrowserWindow,ipcMain} from 'electron';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
let win;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const rootA='a'.repeat(32),spaceA='b'.repeat(32),folder='c'.repeat(32),child='d'.repeat(32),third='e'.repeat(32);
const entries=[{id:folder,parent:rootA,name:'项目',kind:'folder',space_id:spaceA,modified:1},{id:child,parent:folder,name:'资料',kind:'folder',space_id:spaceA,modified:1},{id:third,parent:child,name:'三级',kind:'folder',space_id:spaceA,modified:1}];
const spaces=[{id:'personal',name:'我的空间',root:'',connections:[],bytes:0,pending_bytes:0},{id:spaceA,name:'Agent · 研发',root:rootA,connections:[],bytes:0,pending_bytes:0}];
const state={phase:'ready',account:{phase:'authenticated',accountId:'test'},network:{enabled:false,phase:'disabled'},platform:{phase:'idle'},connection:{deviceId:'test-box',mode:'local'},devices:[{deviceId:'test-box',displayName:'测试盒子',accessState:'ready'}],applications:[]};
const status={phase:'ready',scope:'test-platform:account:box',accountId:'test',boxId:'test-box',tasks:[]};
const calls=[];
async function verify(){
try{
  console.log("SPACES: boot"); await app.whenReady(); console.log("SPACES: ready");
  ipcMain.handle('wanx-client:get-state',()=>state);
  ipcMain.handle('wanx-client:market-list',()=>({items:[]}));
  ipcMain.handle('wanx-client:ownership-list',()=>[]);
  ipcMain.handle('wanx:discovery:bluetooth-state',()=>({status:'available'}));
  ipcMain.handle('wanx-client:space-refresh',()=>status);
  ipcMain.handle('wanx-client:space-list',(_event,input)=>{calls.push(['list',input]);const crumbs=[];let id=input.parent;while(id&&id!==rootA){const item=entries.find(e=>e.id===id);if(!item)break;crumbs.unshift(item);id=item.parent;}return {items:entries.filter(e=>e.parent===(input.parent||'')),breadcrumbs:crumbs};});
  ipcMain.handle('wanx-client:space-mkdir',(_event,input)=>{calls.push(['mkdir',input]);return {};});
  ipcMain.handle('wanx-client:space-links-spaces',()=>spaces);
  ipcMain.handle('wanx-client:space-links-requests',()=>[]);
  ipcMain.handle("wanx-client:credits-balance",()=>({available:0}));ipcMain.handle("wanx-client:credits-transactions",()=>({items:[]}));
  win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{preload:fileURLToPath(new URL('../../local-ui/remote-preload.cjs',import.meta.url)),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await win.loadFile(fileURLToPath(new URL('../../local-ui/renderer/index.html',import.meta.url)));
  console.log("SPACES: loaded");
  const js=s=>win.webContents.executeJavaScript(s);
  await js(`window.until=async f=>{for(let i=0;i<150;i++){if(f())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout');};void 0;`);
  await js(`until(()=>!!document.querySelector('[data-action="show-space"]'))`);
  const click=async selector=>{const point=await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await pause(60);};
  const key=async code=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:code});win.webContents.sendInputEvent({type:'char',keyCode:code});win.webContents.sendInputEvent({type:'keyUp',keyCode:code});await pause(25);};
  await click('[data-action="show-space"]');
  await js(`until(()=>!!document.querySelector('[data-workspace-action="requests"]'))`);
  console.log('SPACES: create'); await click('[data-action="space-mkdir"]');
  await js(`window.originalInput=document.querySelector('#space-name');void 0;`);
  for(const [letterIndex,letter] of [...'new-folder'].entries()){
    await key(letter);
    win.webContents.send('wanx-client:space-state',{...status,tasks:[{id:'upload',name:'fixture.txt',phase:'running',size:100,offset:calls.length}]});
    win.webContents.send('wanx-client:state',state);
    win.webContents.send('wanx-client:space-content-changed');
    await pause(25);
    assert.deepEqual(await js(`({focused:document.activeElement===originalInput,same:document.querySelector('#space-name')===originalInput,value:originalInput?.value})`),{focused:true,same:true,value:"new-folder".slice(0,letterIndex+1)});
  }
  assert.equal(await js(`originalInput.value`),'new-folder');
  await js(`originalInput.setSelectionRange(0,3)`);await key('N');
  await js(`originalInput.setSelectionRange(2,2)`);await key('X');
  assert.equal(await js(`originalInput.value`),'N-Xfolder');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
  win.webContents.send('wanx-client:space-state',status);win.webContents.send('wanx-client:space-content-changed');await pause(50);
  await js(`originalInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));originalInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}));`);
  assert.equal(calls.filter(c=>c[0]==='mkdir').length,0);
  assert.equal(await js(`document.querySelector('#space-name')===originalInput`),true);
  await win.webContents.debugger.sendCommand('Input.insertText',{text:'中文'});
  win.webContents.debugger.detach();await pause(30);
  assert.match(await js(`originalInput.value`),/中文/);
  await click('[data-action="space-dialog-close"]');
  await click(`[data-action="space-folder"][data-space="${spaceA}"]`);
  for(const id of [folder,child,third]){await js(`until(()=>!!document.querySelector('[data-action="space-folder"][data-id="${id}"]'))`);await click(`[data-action="space-folder"][data-id="${id}"]`);}
  assert.equal(calls.filter(c=>c[0]==='list').at(-1)[1].space_id,spaceA);
  assert.equal(await js(`document.querySelector('.space-tree [aria-current="page"]').dataset.id`),third);
  await click('[data-workspace-action="back"]');
  assert.equal(await js(`document.querySelector('.space-tree [aria-current="page"]').dataset.id`),child);
  await click('[data-workspace-action="forward"]');
  assert.equal(await js(`document.querySelector('.space-tree [aria-current="page"]').dataset.id`),third);
  await click('[data-action="space-mkdir"]');await key('z');await key('\r');
  await pause(80);
  // Native Enter is separately sent; char carriage return differs across platforms.
  if(!calls.some(c=>c[0]==='mkdir')){win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});await pause(100);}
  assert.equal(calls.find(c=>c[0]==='mkdir')[1].parent,third);
  assert.equal(calls.find(c=>c[0]==='mkdir')[1].space_id,spaceA);
  if(process.env.WANX_SPACES_SCREENSHOT)await writeFile(process.env.WANX_SPACES_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
  console.log('SPACES_ELECTRON_PASS: native character input, selection, cursor insertion, Chromium IME with broadcasts, hierarchy and history, scoped create');
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}

}
void verify();
