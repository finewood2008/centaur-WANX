// Opt-in local smoke check. Persist only allowlisted state; never account credentials or response bodies.
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
export async function verifyTeamRuntime({client,control,desktop,initialization,directory}) {
 await mkdir(directory,{recursive:true});
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 void initialization.catch(()=>{});
 let attempted=false;
 for(let i=0;i<25;i++){
  const s=client.snapshot();
  const summary={phase:s.phase,accountPhase:s.account?.phase,connection:s.connection?{mode:s.connection.mode,name:s.connection.name,local:s.connection.mode==='local'}:null,devices:(s.devices||[]).map(d=>({name:d.displayName,local:d.local,accessState:d.accessState})),time:new Date().toISOString()};
  await writeFile(path.join(directory,'runtime.json'),JSON.stringify(summary,null,2));
  if(s.phase==='ready'&&s.account?.phase==='authenticated')break;
  const local=(s.devices||[]).find(d=>d.local&&d.accessState==='ready');
  if(!attempted&&local&&s.account?.phase==='authenticated'){attempted=true;await client.connectBox(local.deviceId).catch(()=>{});}
  await sleep(2000);
 }
 desktop.showManagement('applications');
 control.setSize(1360,900);
 await sleep(1500);
 const view=await control.webContents.executeJavaScript(`({title:document.title,brand:document.querySelector('.brand-copy')?.innerText,nav:[...document.querySelectorAll('.main-nav .nav-item')].map(x=>x.textContent.trim()),role:document.querySelector('[data-team-role]')?.value,connection:document.querySelector('.connection-line')?.innerText,appCards:document.querySelectorAll('.application-card').length})`);
 await writeFile(path.join(directory,'ui.json'),JSON.stringify(view,null,2));
 await writeFile(path.join(directory,'admin-applications.png'),(await control.webContents.capturePage()).toPNG());
 if(view.role){
  await control.webContents.executeJavaScript(`(()=>{const x=document.querySelector('[data-team-role]');x.value='user';x.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const user=await control.webContents.executeJavaScript(`({nav:[...document.querySelectorAll('.main-nav .nav-item')].map(x=>x.textContent.trim()),create:!!document.querySelector('[data-action="studio-workspace"]')})`);
  await writeFile(path.join(directory,'user-ui.json'),JSON.stringify(user,null,2));
  await writeFile(path.join(directory,'user-applications.png'),(await control.webContents.capturePage()).toPNG());
  await control.webContents.executeJavaScript(`(()=>{const x=document.querySelector('[data-team-role]');x.value='admin';x.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-action="show-boxes"]').click();})()`);
  await sleep(1000);
  await writeFile(path.join(directory,'boxes.png'),(await control.webContents.capturePage()).toPNG());
  const files=await control.webContents.executeJavaScript(`(async()=>{const r=await window.wanxClient.action('space.list',{parent:''});return {ok:r.ok,code:r.code,itemCount:Array.isArray(r.value?.items)?r.value.items.length:null};})()`);
  await writeFile(path.join(directory,'space-read.json'),JSON.stringify(files,null,2));
  await control.webContents.executeJavaScript(`document.querySelector('[data-action="show-applications"]').click()`);
 }
}
