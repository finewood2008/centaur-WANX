import{readFile}from'node:fs/promises';
import path from'node:path';
export async function patchContinuousWorkspace({patch,addFile,root}){
 await patch('package.json',s=>{const p=JSON.parse(s);p.wanxStudioPreview=true;p.productName='万象构建开发版';p.build={...p.build,appId:'ai.centaurai.wanx.continuous-dev',productName:'万象构建开发版'};return JSON.stringify(p,null,2)+'\n'});
 await patch('shell/entry.mjs',s=>s.replace('  await import("./main.mjs");','  try { await import("./main.mjs"); } catch (error) { console.error("[wanx-client] STARTUP_FAILED", error.code || error.name, error.message); app.exit(1); }'));
 for(const name of ['construction.js','construction.css'])await addFile('local-ui/renderer/'+name,await readFile(path.join(root,'integration',name)));
 await patch('local-ui/renderer/index.html',s=>s.replace('<script src="./renderer.js"></script>','<script src="./construction.js"></script>\n<script src="./renderer.js"></script>').replace('<link rel="stylesheet" href="./studio-home.css" />','<link rel="stylesheet" href="./studio-home.css" />\n<link rel="stylesheet" href="./construction.css" />'));
 await patch('local-ui/remote-preload.cjs',s=>s.replace('page === "studio-projects"','page === "workspace" || page === "environment" || page === "construction" || page === "studio-projects"').replace('  "studio.overview":',`  "builder.acp": () => ipcRenderer.invoke("wanx-client:builder-acp"),
  "studio.placement": input => ipcRenderer.invoke("wanx-client:studio-placement", input),
  "studio.engines.list": () => ipcRenderer.invoke("wanx-client:studio-engines-list"),
  "studio.engines.check": input => ipcRenderer.invoke("wanx-client:studio-engines-check", input),
  "studio.engines.default": input => ipcRenderer.invoke("wanx-client:studio-engines-default", input),
  "studio.overview":`));
 await patch('octop/dashboard-routes.mjs',s=>s.replace('  models:','  acp: "/acp",\n  models:'));
 await patch('shell/control.mjs',s=>s.replace('  register("builder-models",','  register("builder-acp",()=>openConnectedDashboard(client,dashboards,"acp",client.snapshot().connection?.deviceId));\n  register("builder-models",').replace('"overview", "create", "open", "workspace", "metadata", "export"','"overview", "create", "open", "workspace", "metadata", "export", "placement"').replace('"intake-open": "intakeOpen"','"engines-list":"enginesList", "engines-check":"enginesCheck", "engines-default":"enginesDefault", "intake-open": "intakeOpen"'));
 await patch('local-ui/renderer/renderer.js',s=>{
  s=s.replace('const studioHome = window.createStudioHome','const studioHome = window.createStudioHome');
  const anchor='function profileAvatar(';s=s.replace(anchor,`const construction = window.createConstruction({request:async(name,input)=>{const r=await window.wanxClient.action(name,input);if(!r.ok)throw Error(r.code);return r.value},changed:()=>{if(currentState)render(currentState)}});
function constructionView(){return \`<div class="app-layout construction-layout">\${shellHeader("构建")}\${construction.opened()?'<div class="construction-workspace-placeholder" aria-label="项目工作区"></div>':\`<div class="page-content construction-page"><div class="store-heading"><div><p class="store-eyebrow">让熟悉的工作，成为好用的产品</p><h2>构建</h2></div><div class="store-toolbar"><span class="connection-line">\${escapeHTML(activeDeviceName())}</span>\${construction.engineButton()}<button class="button primary" data-action="studio-workspace">＋ 创建新产品</button></div></div>\${construction.settings()}\${studioHome.render(currentState)}</div>\`} </div>\`}
${anchor}`);
  s=s.replace('[["applications", "应用"], ["space", "空间"], ["boxes", "盒子"], ["credits", "积分"]]','[["applications", "应用"], ["construction", "构建"], ["space", "空间"], ["boxes", "盒子"]]');
  s=s.replace('>${label}${destination === "credits"', '>${label}${["construction","data"].includes(destination)?\'<span class="feature-beta">Beta</span>\':""}${destination === "credits"');
  s=s.replace('<button data-action="show-profile">个人资料<span>›</span></button>','<button data-action="show-profile">个人中心<span>›</span></button><button data-action="show-credits">我的积分 <small>${creditsView.label()}</small><span>›</span></button>');
  s=s.replace('shellHeader("个人资料")','shellHeader("个人中心")').replace('<h2>个人资料</h2>','<h2>个人中心</h2>');
  s=s.replace('<section class="profile-card profile-account">','<section class="profile-card"><div class="section-heading"><div><h3>我的积分</h3><p class="muted">账号余额与使用明细</p></div><strong>${creditsView.label()}</strong></div><button class="text-button" data-action="show-credits">查看积分明细 →</button></section><section class="profile-card profile-account">');
  s=s.replace('const activePage = page === "provisioning"', 'const activePage = page === "credits" ? "profile" : page === "builder" ? "construction" : page === "provisioning"');
  s=s.replace('<button class="button primary" data-action="studio-workspace">＋ 创建应用</button>','');
  s=s.replace('[["installed","我的应用"],["projects","我的项目"],["discover","发现应用"]]','[["installed","我的应用"],["discover","发现应用"]]');
  s=s.replace('${applicationTab === "projects" ? studioHome.render(currentState) : ""}','');
  s=s.replace('page === "builder" ? builderView()', 'page === "construction" ? constructionView() : page === "builder" ? constructionView()');
  s=s.replace('studioHome.sync(state, !auth && page === "applications" && applicationTab === "projects", !auth && page === "applications");','studioHome.sync(state, !auth && page === "construction" && !construction.opened());\n  construction.sync(state,!auth&&page === "construction");');
  s=s.replace('  if (action === "profile-menu"',`  if(action === "show-construction" || action === "show-builder"){page="construction";profileMenuOpen=false;construction.list();render(currentState);return}
  if(action === "show-credits"){page="credits";profileMenuOpen=false;void creditsView.refresh();render(currentState);return}
  if(action === "builder-acp"){await run("builder.acp");return}
  if(action.startsWith("construction-")){await construction.action(action,target.dataset);return}
  if (action === "profile-menu"`);
  s=s.replace('    applicationsTab = "development"; page = "applications"; render(currentState);','    page = "construction"; render(currentState);');
  s=s.replace('    applicationTab = "projects"; page = "applications"; render(currentState);','    page = "construction"; render(currentState);');
  s=s.replace('if (action.startsWith("studio-")) { await studioHome.action(action, target.dataset); return; }','if (action.startsWith("studio-")) { if(action==="studio-open"||action==="studio-workspace"){page="construction";await studioHome.action(action,target.dataset);return} await studioHome.action(action, target.dataset); return; }');
  s=s.replace('page="applications"; applicationTab="projects";', 'page="construction"; construction.list();');
  s=s.replace('if (destination === "studio-projects") { page = "applications"; applicationTab = "projects"; void studioHome.refresh(); render(currentState); return; }','if (["studio-projects","workspace","environment"].includes(destination)) { page="construction"; if(destination==="workspace")construction.workspace();else construction.list(destination==="environment");void studioHome.refresh();render(currentState);return; }');
  s=s.replace('["applications", "space", "boxes", "settings", "credits", "profile", "studio-projects"].includes(destination)','["applications", "space", "boxes", "settings", "credits", "profile", "studio-projects","workspace","environment"].includes(destination)');
  // Each navigation hides only the view, never its session or background work.
  s=s.replace('  const auth = state.route === "auth";', '  const auth = state.route === "auth";');
  s=s.replace('  studioHome.sync(state, !auth && page === "construction" && !construction.opened());\n  construction.sync(state,!auth&&page === "construction");','  construction.sync(state,!auth&&page === "construction");\n  construction.visibility(auth?"auth":page);\n  studioHome.sync(state,!auth&&page==="construction"&&!construction.opened());');
  s=s.replace('app.addEventListener("input", event => {\n  if (event.target.matches?.("[data-studio-name]"))','app.addEventListener("input", event => {\n  if(event.target.matches?.("[data-construction-search]"))studioHome.search(event.target.value);\n  if (event.target.matches?.("[data-studio-name]"))');
  return s;
 });
 await patch('local-ui/renderer/credits.js',s=>s.replace('data-action="show-applications">‹ 返回应用','data-action="show-profile">‹ 返回个人中心'));
 await patch('shell/main.mjs',s=>s.replace('  BrowserWindow,','  BrowserWindow, WebContentsView,').replace('let control;','let workspace;\nlet control;').replace('import { app,','import { app,').replace('let workspace;',`import {createEmbeddedWorkspace} from "../studio/embedded-workspace.mjs";
let workspace;`).replace('        onStudioInstalled:', '        openStudioWorkspace: input=>workspace.open(input),\n        placeStudioWorkspace: input=>workspace.placement(input),\n        onStudioInstalled:').replace('      broadcast = createUIBroadcast({',`      workspace=createEmbeddedWorkspace({BrowserWindow,WebContentsView,ipcMain,control,createConnection:id=>client.applicationConnection(id),assets:path.join(app.getAppPath(),"studio"),onChanged:()=>{studioChanged++;void broadcast?.publish()},onNavigate:destination=>{control.webContents.send("wanx-client:navigate",destination==="projects"?"studio-projects":destination==="workspace"?"workspace":destination==="environment"?"environment":"settings")}});
      broadcast = createUIBroadcast({`));
 // Keep the copied client's regression harness aligned with its actual scripts
 // and the explicitly changed navigation. No source checkout is modified.
 await patch('tests/renderer-upgrade.test.mjs',s=>s.replace('"builder-projects.js", "renderer.js"','"builder-projects.js", "studio-input.js", "studio-intake.js", "studio-home.js", "construction.js", "renderer.js"'));
 await patch('tests/renderer-seam.test.mjs',s=>{
  s=s.replace('["applications", "space", "boxes", "credits"]','["applications", "construction", "space", "boxes"]');
  s=s.replace('  assert.match(h.app.innerHTML, /1,250 点/);\n  await h.click("show-credits");','  assert.doesNotMatch(h.app.innerHTML, /1,250 点/);\n  await h.click("profile-menu");\n  assert.match(h.app.innerHTML, /1,250 点/);\n  await h.click("show-credits");');
  s=s.replace('avatar menu owns profile and settings; credits is a primary tab','avatar menu owns personal center, settings and credits');
  s=s.replace('  assert.match(header, /data-action="show-credits"/);','  assert.doesNotMatch(header, /data-action="show-credits"/);');
  const start=s.indexOf('test("Applications offers Builder setup');
  const end=s.indexOf('\ntest("Builder model configuration',start);
  if(start<0||end<0)throw Error('CLIENT_BUILDER_TEST_ANCHOR_CHANGED');
  return s.slice(0,start)+`test("Construction opens without creating a project, connecting a box or calling a model", async () => {
  const h = await harness(state());
  assert.doesNotMatch(h.app.innerHTML, /data-action="show-builder"|data-action="studio-workspace"/);
  assert.match(h.app.innerHTML, /data-action="show-construction"/);
  await h.click("show-construction");
  assert.match(h.app.innerHTML, /创建新产品/);
  assert.match(h.app.innerHTML, /连接万象后，恢复项目并开始创建/);
  assert.deepEqual(h.launches, []);
  await h.click("studio-workspace");
  assert.deepEqual(h.launches, [], "opening the page must never pick a device silently");
  assert.equal(h.calls.filter(([name])=>name==="wanx-client:connect-box").length,0);
});
`+s.slice(end);
 });
}
