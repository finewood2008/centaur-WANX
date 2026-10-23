const{contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('miniappHost',Object.freeze({load:()=>ipcRenderer.invoke('miniapp:load'),invoke:(method,params)=>ipcRenderer.invoke('miniapp:invoke',method,params),list:parent=>ipcRenderer.invoke('miniapp:files-list',parent),select:ids=>ipcRenderer.invoke('miniapp:files-select',ids)}));
