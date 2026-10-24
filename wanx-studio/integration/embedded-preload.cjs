const{contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('wanxStudio',Object.freeze({
 embedded:true,
 capturePreview:rect=>ipcRenderer.invoke('studio-embedded:capture-preview',rect),
 request:(path,method,body)=>ipcRenderer.invoke('studio-embedded:request',path,method,body),
 navigation:()=>ipcRenderer.invoke('studio-embedded:navigation'),
 onNavigation:listener=>{const fn=()=>listener();ipcRenderer.on('studio:navigation',fn);return()=>ipcRenderer.removeListener('studio:navigation',fn)},
 returnToClient:destination=>ipcRenderer.invoke('studio-embedded:return',destination),
 placement:action=>ipcRenderer.invoke('studio-embedded:placement',{protocolVersion:1,action}),
 onPlacement:listener=>{const fn=(_e,p)=>listener(p);ipcRenderer.on('studio:placement',fn);return()=>ipcRenderer.removeListener('studio:placement',fn)},
 onProjectChanged:listener=>{const fn=(_e,p)=>listener(p);ipcRenderer.on('studio:project',fn);return()=>ipcRenderer.removeListener('studio:project',fn)},
 onInvalidated:listener=>{const fn=()=>listener();ipcRenderer.on('studio:invalidated',fn);return()=>ipcRenderer.removeListener('studio:invalidated',fn)}
}));
