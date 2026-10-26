const { contextBridge, ipcRenderer, webUtils } = require("electron");
// Narrow quick-panel actions only; disk paths are extracted here from dropped Files.
const actions = new Set([
  "applications-request-open", "applications-confirm-open", "applications-cancel-open",
  "desktop-open", "desktop-hide", "desktop-resize", "desktop-about",
]);
contextBridge.exposeInMainWorld("wanxPanel", {
  getState: () => ipcRenderer.invoke("wanx-client:get-state"),
  getSpace: () => ipcRenderer.invoke("wanx-client:panel-space-snapshot"),
  refreshSpace: () => ipcRenderer.invoke("wanx-client:panel-space-refresh"),
  async uploadDroppedFiles(files, scope) {
    try {
      if (!Array.isArray(files) || !files.length) throw new Error("SPACE_INVALID_DROP");
      const paths = files.map(file => webUtils.getPathForFile(file));
      if (paths.some(path => !path)) throw new Error("SPACE_INVALID_DROP");
      const value = await ipcRenderer.invoke("wanx-client:panel-space-upload", { paths, names: files.map(file => file.name), scope });
      if (value?.uploadRejection) return { ok: false, ...value.uploadRejection };
      return { ok: true };
    } catch (error) {
      const code = String(error?.message || "").match(/\b(?:SPACE_[A-Z_]+|BOX_CONNECTION_REQUIRED|ACCOUNT_LOGIN_REQUIRED|NETWORK_NOT_READY|SECURE_STORAGE_[A-Z_]+)\b/)?.[0] || "SPACE_REQUEST_FAILED";
      return { ok: false, code };
    }
  },
  transfer: (action, id, scope) => ipcRenderer.invoke("wanx-client:panel-space-transfer", { action, id, scope }),
  onSpace(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("wanx-client:panel-space-state", handler);
    return () => ipcRenderer.removeListener("wanx-client:panel-space-state", handler);
  },
  getApplicationNames: () => ipcRenderer.invoke("wanx-client:panel-application-names"),
  getBalance: () => ipcRenderer.invoke("wanx-client:panel-balance"),
  action(name, input) {
    if (!actions.has(name)) return Promise.reject(new Error("PANEL_ACTION_NOT_ALLOWED"));
    return ipcRenderer.invoke(`wanx-client:${name}`, input);
  },
  onState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("wanx-client:state", handler);
    return () => ipcRenderer.removeListener("wanx-client:state", handler);
  },
});

const noteMethods=new Set(['snapshot','note-refresh','note-save','note-paste','capture','preview','choose','transfer','note-command']);
async function noteAction(name,input={}){
  const method=name.replace(/^clipboard\./,'');
  if(!name.startsWith('clipboard.')||!noteMethods.has(method))return {ok:false,code:'PANEL_ACTION_NOT_ALLOWED'};
  try{return {ok:true,value:await ipcRenderer.invoke('wanx-client:panel-note',{...input,method})};}
  catch(error){return {ok:false,code:String(error.message).match(/(?:CLIPBOARD|SPACE|BOX|ACCOUNT|SECURE_STORAGE|PANEL)_[A-Z_]+/)?.[0]||'CLIPBOARD_OPERATION_FAILED'};}
}
contextBridge.exposeInMainWorld('wanxClient',{
  action:noteAction,
  async clipboardFiles(files,input={}){
    try{
      if(!Array.isArray(files)||!files.length||files.length>20||files.some(f=>f.size>20*1024*1024))throw Error('CLIPBOARD_LIMIT');
      const paths=files.map(f=>webUtils.getPathForFile(f));let payload;
      if(paths.every(Boolean))payload={paths};
      else if(files.length===1&&['image/png','image/jpeg','image/gif','image/webp'].includes(files[0].type))payload={image:Buffer.from(await files[0].arrayBuffer()).toString('base64'),name:files[0].name,mime:files[0].type};
      else throw Error('CLIPBOARD_VIRTUAL_FILE');
      return noteAction('clipboard.capture',{...payload,scope:input.scope});
    }catch(error){return {ok:false,code:error.message};}
  },
  onClipboardState(listener){
    const handler=(_event,state)=>listener(state);ipcRenderer.on('wanx-client:panel-note-state',handler);
    return ()=>ipcRenderer.removeListener('wanx-client:panel-note-state',handler);
  },
});

const assistantMethods=new Set(["load","open","send","stop","watch","unwatch","model","legacy-open","upload","release","resume","artifact","history-update","history-export","space-list","space-grant","release-context","knowledge-list","knowledge-grant","knowledge-evidence","usage","polish","version","version-select","handoff","history-list"]);
contextBridge.exposeInMainWorld('wanxPanelAssistant',{
 async request(action,input={}){
  const method=action.replace(/^dialogue\./,'');
  if(!action.startsWith('dialogue.')||!assistantMethods.has(method))return {ok:false,code:'PANEL_ACTION_NOT_ALLOWED'};
  try{return {ok:true,value:await ipcRenderer.invoke('wanx-client:panel-ai-dialogue-'+method,input)};}
  catch(error){return {ok:false,code:String(error.message).match(/(?:ASSISTANT|DIALOGUE|MODEL|SPACE|BOX|ACCOUNT)_[A-Z_]+/)?.[0]||'ASSISTANT_REQUEST_FAILED'};}
 },
 expand:input=>ipcRenderer.invoke('wanx-client:panel-assistant-open',input),
 onEvent(listener){const handler=(_event,value)=>listener(value);ipcRenderer.on('wanx-client:panel-ai-dialogue',handler);return()=>ipcRenderer.removeListener('wanx-client:panel-ai-dialogue',handler);}
});
