const{contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('wanxStudio',Object.freeze({
  setTheme:theme=>ipcRenderer.invoke('studio:theme',theme),request:(path,method,body)=>ipcRenderer.invoke('studio:request',path,method,body),
  returnToClient:destination=>ipcRenderer.invoke('studio:return',destination),
  navigation:()=>ipcRenderer.invoke('studio:navigation'),
  install:(projectId,artifactHash)=>ipcRenderer.invoke('studio:install',projectId,artifactHash),
  openApp:applicationId=>ipcRenderer.invoke('studio:open',applicationId),
  onProjectChanged:listener=>{const fn=(_event,p)=>listener(p);ipcRenderer.on('studio:project',fn);return()=>ipcRenderer.removeListener('studio:project',fn)},
  onInvalidated:listener=>{const fn=()=>listener();ipcRenderer.on('studio:invalidated',fn);return()=>ipcRenderer.removeListener('studio:invalidated',fn)}
}));
