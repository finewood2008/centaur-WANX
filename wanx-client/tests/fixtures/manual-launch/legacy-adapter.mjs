export async function createRealSourceDevelopment(client, manager) {
 const manifest={applicationId:"centaurai.wanx.zhijun"};
 const report={};
 const writes=Promise.resolve();
 const save=async()=>{};
 let opening=false,opened=false,closed=false;
 const maybeOpen=()=>{
   const snapshot=client.snapshot();report.phase=snapshot.phase;report.accountAuthenticated=snapshot.account?.phase==='authenticated';report.boxConnected=Boolean(snapshot.connection?.deviceId);void save();
   if(closed||opening||opened||snapshot.phase!=='ready'||!report.accountAuthenticated||!report.boxConnected)return;
   opening=true;void manager.listInstalled().then(items=>items.some(item=>item.applicationId===manifest.applicationId)?manager.launch(manifest.applicationId):null).then(()=>{opened=true;report.ready=true;void save();},error=>{report.launchError=error.code||'SOURCE_START_FAILED';void save();}).finally(()=>{opening=false;});
 };
 const unsubscribe=client.subscribe(maybeOpen);
 maybeOpen();
 return {applicationId:manifest.applicationId,manager,listInstalled:manager.listInstalled,async open(){const value=await manager.launch(manifest.applicationId);opened=true;report.ready=true;await save();return value;},async close(){closed=true;unsubscribe();await manager.close();await writes;}};
}
