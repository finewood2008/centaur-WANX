import {readFile} from 'node:fs/promises';
import path from 'node:path';

export async function patchStudioPortal({patch,addFile,root}) {
  for(const name of ['studio-home.js','studio-intake.js','studio-input.js','studio-home.css']) await addFile('local-ui/renderer/'+name,await readFile(path.join(root,'integration',name),'utf8'));
  await patch('local-ui/renderer/index.html',s=>s.replace('<link rel="stylesheet" href="./styles.css" />','<link rel="stylesheet" href="./styles.css" />\n    <link rel="stylesheet" href="./studio-home.css" />').replace('<script src="./renderer.js"></script>','<script src="./studio-input.js"></script>\n    <script src="./studio-intake.js"></script>\n    <script src="./studio-home.js"></script>\n    <script src="./renderer.js"></script>'));
  await patch('local-ui/remote-preload.cjs',s=>s.replace('  "applications.list":',`  "studio.launch.suggest": input => ipcRenderer.invoke("wanx-client:studio-launch-suggest", input),
  "studio.launch.sources": input => ipcRenderer.invoke("wanx-client:studio-launch-sources", input),
  "studio.launch.configure": input => ipcRenderer.invoke("wanx-client:studio-launch-configure", input),
  "studio.launch.start": input => ipcRenderer.invoke("wanx-client:studio-launch-start", input),
  "studio.intake.open": input => ipcRenderer.invoke("wanx-client:studio-intake-open", input),
  "studio.intake.send": input => ipcRenderer.invoke("wanx-client:studio-intake-send", input),
  "studio.intake.state": input => ipcRenderer.invoke("wanx-client:studio-intake-state", input),
  "studio.intake.events": input => ipcRenderer.invoke("wanx-client:studio-intake-events", input),
  "studio.intake.handoff": input => ipcRenderer.invoke("wanx-client:studio-intake-handoff", input),
  "studio.context.sources": input => ipcRenderer.invoke("wanx-client:studio-context-sources", input),
  "studio.context.select": input => ipcRenderer.invoke("wanx-client:studio-context-select", input),
  "studio.capabilities.list": input => ipcRenderer.invoke("wanx-client:studio-capabilities-list", input),
  "studio.capabilities.decide": input => ipcRenderer.invoke("wanx-client:studio-capabilities-decide", input),
  "studio.capabilities.check": input => ipcRenderer.invoke("wanx-client:studio-capabilities-check", input),
  "studio.capabilities.state": input => ipcRenderer.invoke("wanx-client:studio-capabilities-state", input),
  "studio.workspace": input => ipcRenderer.invoke("wanx-client:studio-workspace", {protocolVersion:input?.protocolVersion}),
  "studio.metadata": input => ipcRenderer.invoke("wanx-client:studio-metadata", input),
  "studio.export": input => ipcRenderer.invoke("wanx-client:studio-export", input),
  "studio.overview": () => ipcRenderer.invoke("wanx-client:studio-overview"),
  "studio.create": input => ipcRenderer.invoke("wanx-client:studio-create", { goal: input?.goal, operationId: input?.operationId }),
  "studio.open": input => ipcRenderer.invoke("wanx-client:studio-open", { projectId: input?.projectId, protocolVersion: input?.protocolVersion }),
  "applications.list":`).replace('page === "space" || page === "applications"', 'page === "studio-projects" || page === "space" || page === "applications"'));
  await patch('shell/control.mjs',s=>s.replace('"applications-list", "market-list"','"applications-list", "studio-overview", "market-list"').replace('  register("applications-list",',`  for (const operation of ["overview", "create", "open", "workspace", "metadata", "export"]) {
    register("studio-" + operation, input => {
      requireConnectedBox(client.snapshot());
      if (!applications?.studio) throw new Error("STUDIO_UNAVAILABLE");
      return applications.studio[operation](input);
    });
  }
  for(const [action,method] of Object.entries({"launch-suggest":"launchSuggest","launch-sources":"launchSources","launch-configure":"launchConfigure","launch-start":"launchStart","intake-open": "intakeOpen", "intake-send": "intakeSend", "intake-state": "intakeState", "intake-events": "intakeEvents", "intake-handoff": "intakeHandoff", "context-sources": "contextSources", "context-select": "contextSelect", "capabilities-list": "capabilitiesList", "capabilities-decide": "capabilitiesDecide", "capabilities-check": "capabilitiesCheck", "capabilities-state": "capabilitiesState"})) {
    register("studio-"+action,input=>{requireConnectedBox(client.snapshot());if(!applications?.studio)throw new Error("STUDIO_UNAVAILABLE");return applications.studio[method](input)});
  }
  register("applications-list",`));
  await patch('applications/manager.mjs',s=>s.replace('placement: input=>studioEntry.placement(input),','launchSuggest:input=>studioEntry.launchSuggest(input), launchSources:input=>studioEntry.launchSources(input), launchConfigure:input=>studioEntry.launchConfigure(input), launchStart:input=>studioEntry.launchStart(input), placement: input=>studioEntry.placement(input),'));
  await patch('package.json',s=>{
    const pkg=JSON.parse(s);if(pkg.build?.files&&!pkg.build.files.includes('studio/**'))pkg.build.files.push('studio/**');
    pkg.wanxStudioVersion='0.5.0';return JSON.stringify(pkg,null,2)+'\n';
  });
  await patch('local-ui/renderer/renderer.js',s=>{
    const replace=(from,to)=>{if(!s.includes(from))throw new Error('STUDIO_PORTAL_ANCHOR_MISSING: '+from.slice(0,60));s=s.replace(from,to)};
    replace('const app = document.querySelector("#app");','const app = document.querySelector("#app");\nconst studioInput = window.createStudioInputRetention(app, () => { if(currentState) render(currentState); });');
    replace('  if (markup === renderedMarkup)', '  if (studioInput.defer(markup)) return;\n  if (markup === renderedMarkup)');
    replace('  app.innerHTML = markup;', '  const restoreStudioInput = studioInput.capture();\n  app.innerHTML = markup;\n  restoreStudioInput();');
    replace('let page = "applications";','let page = "applications";\nlet applicationsTab = "mine";\nconst studioHome = window.createStudioHome({\n  request: async (name, input) => {\n    const response = await window.wanxClient.action(name, input);\n    if (response.state) acceptRemoteState(response.state);\n    if (!response.ok) throw new Error(response.code);\n    return response.value;\n  }, changed: () => { if (currentState) render(currentState); },\n});');
    const nativeTabs=s.includes('applicationTab === \"projects\" ? builderProjectsView.render()');
    const entry='<button class="button primary" data-action="studio-workspace">＋ 创建应用</button>';
    if(s.includes('<button class="button primary" data-action="show-builder">＋ 创建应用</button>'))replace('<button class="button primary" data-action="show-builder">＋ 创建应用</button>',entry);
    else replace('<div class="store-toolbar">','<div class="store-toolbar">'+entry);
    replace('function applicationsView() {\n  const applications = currentState.applications || [];','function applicationsView() {\n  const applications = (currentState.applications || []).filter(item => item.applicationId !== "ai.wanx.studio");');
    if(nativeTabs){
      replace('${applicationTab === "projects" ? builderProjectsView.render() : ""}','${applicationTab === "projects" ? studioHome.render(currentState) : ""}');
      s=s.replace('  builderProjectsView.sync(state, page === "applications" && applicationTab === "projects");','');
      s=s.replaceAll('builderProjectsView.refresh()','studioHome.refresh()');
    }else{
    replace('    ${storeFeatures()}\n    <section class="content-section store-installed"',`    <div class="applications-tabs" role="tablist" aria-label="应用分类">\${[["mine","我的应用"],["development","我的项目"],["discover","发现应用"]].map(([key,label]) => \`<button id="applications-tab-\${key}" class="applications-tab" role="tab" aria-selected="\${applicationsTab === key}" aria-controls="applications-panel-\${key}" data-action="applications-tab" data-tab="\${key}">\${label}</button>\`).join("")}</div>
    <div id="applications-panel-\${applicationsTab}" role="tabpanel" aria-labelledby="applications-tab-\${applicationsTab}">
    \${applicationsTab === "development" ? studioHome.render(currentState) : applicationsTab === "mine" ? \`
    <section class="content-section store-installed"`);
    replace('从下方选择应用，安装后即可在菜单栏打开。','前往“发现应用”安装工具，或在“我的项目”制作自己的应用。');
    replace('    <section class="content-section market-section"', '    ` : `${storeFeatures()}<section class="content-section market-section"');
    replace('下载无需连接盒子，部分应用需连接盒子完成安装</span></div>','下载无需连接盒子，部分应用需连接盒子完成安装</span></div>`}</div>');
    }
    replace('  supportView.visible(!auth && page === "boxes");','  supportView.visible(!auth && page === "boxes");\n  studioHome.sync(state, !auth && page === "applications" && applicationsTab === "development", !auth && page === "applications");');
    replace('  const retainedForm = wifiForm || authForm || transferForm || passwordForm || profileForm;', '  const studioForm = !auth && page === "applications" && applicationsTab === "development" ? app.querySelector?.(\'[data-form="studio-create"]\') : null;\n  const retainedForm = wifiForm || authForm || transferForm || passwordForm || profileForm || studioForm;');
    replace('profileForm ? "profile" : "auth";', 'profileForm ? "profile" : studioForm ? "studio-create" : "auth";');
    replace('function syncFormState() {','function syncFormState() {\n  studioHome.mounted(app);');
    replace('  if (action === "store-details") {',`  if (action === "applications-tab") {
    if (!["mine", "discover", "development"].includes(target.dataset.tab)) return;
    applicationsTab = target.dataset.tab; page = "applications"; notice = null;
    render(currentState); return;
  }
  if (action === "studio-workspace") {
    if (!currentState.canLaunchApplications) { page = "boxes"; notice = {type:"info",text:"请先连接万象，再创建应用。"}; render(currentState); return; }
    applicationsTab = "development"; page = "applications"; render(currentState);
  }
  if (action.startsWith("studio-")) { await studioHome.action(action, target.dataset); return; }
  if (action === "store-details") {`);
    replace('app.addEventListener("submit", async (event) => {','app.addEventListener("submit", async (event) => {\n  if (event.target.dataset.form === "studio-create") {\n    event.preventDefault(); await studioHome.create(String(new FormData(event.target).get("goal") || "")); return;\n  }');
    replace('app.addEventListener("submit", async (event) => {','app.addEventListener("input", event => {\n  if (event.target.matches?.("[data-studio-name]")) studioHome.input(event.target.value);\n  if(event.target.dataset.intakeField)studioHome.field(event.target.dataset.intakeField,event.target.value);\n  if (event.target.name === "goal" && event.target.closest?.(\'[data-form="studio-create"]\')) studioHome.input(event.target.value);\n});\napp.addEventListener("submit", async (event) => {');
    replace('  page = destination;','  if (destination === "studio-projects") { page = "applications"; applicationsTab = "development"; void studioHome.refresh(); render(currentState); return; }\n  page = destination;');
    replace('["applications", "space", "boxes", "settings", "credits", "profile"].includes(destination)', '["applications", "space", "boxes", "settings", "credits", "profile", "studio-projects"].includes(destination)');
    replace('function acceptRemoteState(state) {','function acceptRemoteState(state) {\n  if (state.studioChanged && state.studioChanged !== window.__studioChanged) { window.__studioChanged = state.studioChanged; void studioHome.refresh(); }');
    replace('    selectedApplicationId = null;\n    posterPreview = null;\n    profileMenuOpen = false;','    applicationsTab = "mine";\n    selectedApplicationId = null;\n    posterPreview = null;\n    profileMenuOpen = false;');
    replace('${opening ? activityLabel(status || "正在打开…") : operationBusy(item.applicationId) ? status || "处理中…" : operation?.phase === "running" ? "已打开" : "打开"}</button>` : ""}</div>`;', '${opening ? activityLabel(status || "正在打开…") : operationBusy(item.applicationId) ? status || "处理中…" : operation?.phase === "running" ? "已打开" : "打开"}</button>${studioHome.continueButton(item.applicationId)}` : ""}</div>`;');
    s=s.replace('function applicationsView() {','function applicationsView() {\n  if(studioHome.preparing())return `<div class=\"app-layout store-layout\">${shellHeader(\"任务准备\")}<div class=\"page-content intake-host-page\">${studioHome.render(currentState)}</div></div>`;');
    if(nativeTabs){s=s.replaceAll('applicationsTab === \"development\"','applicationTab === \"projects\"');s=s.replaceAll('applicationsTab = \"development\"','applicationTab = \"projects\"')}
    return s;
  });
}
