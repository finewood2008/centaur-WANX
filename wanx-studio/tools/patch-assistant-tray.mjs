// Deliberately patch the latest installed shell so notes and other tray work survive.
export const assistantMethods = ["load","open","send","stop","watch","unwatch","model","legacy-open","upload","release","resume","artifact","history-update","history-export","space-list","space-grant","release-context","knowledge-list","knowledge-grant","knowledge-evidence","usage","polish","version","version-select","handoff"];
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('ASSISTANT_PATCH_ANCHOR_CHANGED:' + before.slice(0,70));
  return source.replace(before,after);
};
export function patchAssistantFile(file, source) {
  const methods = JSON.stringify(assistantMethods);
  if (file === 'shell/main.mjs') {
    source = replace(source,'let aiDialogue;','let aiDialogue, panelDialogue;');
    source = replace(source,'      aiDialogue = createAIDialogue({ client,','      const assistantUploads = new Map();\n      aiDialogue = createAIDialogue({ client, sharedUploads: assistantUploads,');
    const start = source.indexOf('      aiDialogue = createAIDialogue('), end = source.indexOf('      registerControlActions({',start);
    if(start<0||end<0)throw Error('ASSISTANT_CREATE_ANCHOR');
    const mini = source.slice(start,end)
      .replace('aiDialogue =','panelDialogue =')
      .replace('dialog.showOpenDialog(control,','dialog.showOpenDialog(panel || control,')
      .replace('dialog.showSaveDialog(control,','dialog.showSaveDialog(panel || control,')
      .replace('if (!control.isDestroyed()) control.webContents.send("wanx-client:ai-dialogue", event);','if (panel && !panel.isDestroyed()) panel.webContents.send("wanx-client:panel-ai-dialogue", event);');
    source = source.slice(0,end)+mini+source.slice(end);
    source = replace(source,'      registerControlActions({\n        aiDialogue,','      registerControlActions({\n        aiDialogue, panelDialogue,');
    source = replace(source,'          aiDialogue?.close();','          aiDialogue?.close();\n          panelDialogue?.close();');
  }
  if (file === 'shell/control.mjs') {
    source = replace(source,'  aiDialogue,','  aiDialogue, panelDialogue,');
    source = source.replace(/\["load",\s*"open",\s*"send",\s*"stop",\s*"watch",\s*"unwatch",\s*"model",\s*"legacy-open",\s*"upload",\s*"release",\s*"resume",\s*"artifact"(?:,\s*"[a-z-]+")*\]/,methods);
    source = replace(source,'name.startsWith("ai-dialogue-")','(name.startsWith("ai-dialogue-") || name.startsWith("panel-ai-dialogue-"))');
    const anchor='  const creditsRead = async action => {';
    source = replace(source,anchor,`  for(const method of ${methods}) {
    const name = "panel-ai-dialogue-" + method; panelActions.add(name);
    register(name, input => { if(!panelDialogue) throw Error("DIALOGUE_UNAVAILABLE");return panelDialogue.action(method,input); });
  }
  panelActions.add("panel-assistant-open");
  register("panel-assistant-open", async input => {
    const payload=await panelDialogue.action("handoff",input);
    desktop?.showManagement("ai-dialogue");
    control.webContents.send("wanx-client:ai-dialogue",{type:"handoff",...payload});
    return {ok:true};
  });
`+anchor);
  }
  if (file === 'local-ui/remote-preload.cjs') {
    const pattern=/\["load",\s*"open",\s*"send",\s*"stop",\s*"watch",\s*"unwatch",\s*"model",\s*"legacy-open",\s*"upload",\s*"release",\s*"resume",\s*"artifact"(?:,\s*"[a-z-]+")*\]/;
    if(!pattern.test(source))throw Error('ASSISTANT_PRELOAD_ANCHOR');
    source=source.replace(pattern,methods);
  }
  if(file==='local-ui/panel-preload.cjs') {
    source += `
const assistantMethods=new Set(${methods});
contextBridge.exposeInMainWorld('wanxPanelAssistant',{
 async request(action,input={}){
  const method=action.replace(/^dialogue\\./,'');
  if(!action.startsWith('dialogue.')||!assistantMethods.has(method))return {ok:false,code:'PANEL_ACTION_NOT_ALLOWED'};
  try{return {ok:true,value:await ipcRenderer.invoke('wanx-client:panel-ai-dialogue-'+method,input)};}
  catch(error){return {ok:false,code:String(error.message).match(/(?:ASSISTANT|DIALOGUE|MODEL|SPACE|BOX|ACCOUNT)_[A-Z_]+/)?.[0]||'ASSISTANT_REQUEST_FAILED'};}
 },
 expand:input=>ipcRenderer.invoke('wanx-client:panel-assistant-open',input),
 onEvent(listener){const handler=(_event,value)=>listener(value);ipcRenderer.on('wanx-client:panel-ai-dialogue',handler);return()=>ipcRenderer.removeListener('wanx-client:panel-ai-dialogue',handler);}
});
`;
  }
  if(file==='local-ui/panel/index.html') {
    source=replace(source,'  <script src="panel.js" defer></script>','  <link rel="stylesheet" href="../renderer/ai-dialogue.css">\n  <link rel="stylesheet" href="panel-assistant.css">\n  <script src="../renderer/ai-dialogue.js" defer></script>\n  <script src="panel.js" defer></script>\n  <script src="panel-assistant.js" defer></script>');
  }
  if(file==='local-ui/panel/panel.js') {
    const pattern=/<button class="space-entry" data-page="space"[\s\S]*?<\/button>/;
    if(!pattern.test(source))throw Error('ASSISTANT_TRAY_ENTRY_ANCHOR');
    source=source.replace(pattern,'<button class="space-entry" data-assistant-open aria-label="打开迷你助理"><span class="destination-icon assistant-destination-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="m13 6 1.3 3.2 3.2 1.3-3.2 1.3L13 15l-1.3-3.2-3.2-1.3 3.2-1.3Z"/></svg></span><span class="destination-copy"><strong>助理</strong><small>随时问，接着做</small></span><span class="destination-arrow" aria-hidden="true">›</span></button>');
    source=source.replace('aria-label="空间与便签"','aria-label="助理与便签"');
    source=replace(source,'const height = noteView ? 560 :','const height = document.body.classList.contains("assistant-view") ? 560 : noteView ? 560 :');
    source=replace(source,'if (event.key === "Escape") { event.preventDefault(); clearDrag();','if (event.key === "Escape") { if(document.body.classList.contains("assistant-view"))return; event.preventDefault(); clearDrag();');
  }
  return source;
}
