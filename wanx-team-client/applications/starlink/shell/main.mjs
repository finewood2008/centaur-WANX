import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  dialog,
} from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fromEnvironment } from "@centaurai/wanx-host-sdk";
import { attachElectronHost } from "@centaurai/wanx-host-sdk/electron";
import {createStarlinkTarget} from "./team-target.mjs";
import { SemanticaService } from "./service.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(path.join(root, "ui/index.html")).href;
if (process.env.WANX_HOST_USER_DATA_DIR) attachElectronHost();
const host = fromEnvironment();
app.setName("星图 STARLINK");
nativeTheme.themeSource = "light";
if (!host)
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "wanx-semantica-standalone"),
  );
let window, service;
app
  .whenReady()
  .then(async () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "星图",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
        {
          label: "编辑",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
        {
          label: "窗口",
          submenu: [{ role: "minimize" }, { role: "togglefullscreen" }],
        },
      ]),
    );
    window = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 760,
      minHeight: 620,
      title: "星图 STARLINK · 本地知识数据仓",
      icon: path.join(root, "resources/icon.png"),
      backgroundColor: "#faf7f2",
      webPreferences: {
        preload: path.join(root, "shell/preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    if (process.platform === "darwin")
      app.dock.setIcon(path.join(root, "resources/icon.png"));
    app.setAboutPanelOptions({
      applicationName: "星图 STARLINK",
      applicationVersion: app.getVersion(),
      copyright: "半人马AI",
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== page) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    service = new SemanticaService({
      host,
      emit: (value) => {
        if (!window.isDestroyed())
          window.webContents.send("semantica:event", value);
      },
      selectFiles: async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "导入知识材料",
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "知识材料",
              extensions: [
                "txt",
                "md",
                "markdown",
                "pdf",
                "docx",
                "png",
                "jpg",
                "jpeg",
                "webp",
                "wav",
                "mp3",
                "m4a",
                "flac",
                "pptx",
                "xlsx",
                "xls",
                "xlsm",
              ],
            },
          ],
        });
        return result.canceled ? [] : result.filePaths;
      },
      selectSave: async (filename) => {
        const result = await dialog.showSaveDialog(window, {
          title: filename.endsWith(".xingtu")
            ? "导出星图数据仓"
            : filename.endsWith(".zip") ? "下载 Skill ZIP" : "保存材料原件",
          defaultPath: filename,
        });
        return result.canceled ? null : result.filePath;
      },
      selectSkill: async () => {
        const result = await dialog.showOpenDialog(window, {title:"导入 Skill ZIP",properties:["openFile"],filters:[{name:"Skill ZIP",extensions:["zip"]}]});
        return result.canceled ? [] : result.filePaths;
      },
      selectArchive: async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "迁入星图数据仓",
          properties: ["openFile"],
          filters: [{ name: "星图迁移包", extensions: ["xingtu", "zip"] }],
        });
        return result.canceled ? [] : result.filePaths;
      },
    });
    const teamTarget=createStarlinkTarget({host,service,emit:value=>window.webContents.send("semantica:event",value)});
    process.on("message",message=>void teamTarget.receive(message));
    process.send?.({type:"wanx:starlink-capabilities",version:1,launchId:process.env.WANX_HOST_LAUNCH_ID},()=>{});
    ipcMain.handle(
      "semantica:action",
      async (event, { action, input } = {}) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== page
        )
          return { ok: false, code: "UNTRUSTED_FRAME" };
        try {
          if (["launch-target","launch-target-applied","team-applications","grant-team-application"].includes(action))return {ok:true,value:await teamTarget.call(action,input||{})};
          if (action === "open-model-management") {
            service.assertLive();
            const requestId = randomUUID();
            const opened = await new Promise(resolve => {
              const finish = value => { clearTimeout(timer); process.removeListener("message", receive); resolve(value); };
              const receive = message => { if(message?.type === "wanx:open-models-result" && message.requestId === requestId && message.launchId === process.env.WANX_HOST_LAUNCH_ID) finish(message.ok === true); };
              const timer = setTimeout(()=>finish(false), 4000);
              process.on("message",receive);
              process.send?.({type:"wanx:open-models",requestId,launchId:process.env.WANX_HOST_LAUNCH_ID},()=>{});
            });
            return {ok:true,value:{opened}};
          }
          return { ok: true, value: await service.call(action, input) };
        } catch (error) {
          return {
            ok: false,
            code: /^[A-Z][A-Z_]+$/.test(error.code || "")
              ? error.code
              : "SEMANTICA_REQUEST_FAILED",
            message: error.publicMessage,
          };
        }
      },
    );
    await window.loadURL(page);
  })
  .catch(() => app.quit());
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => service?.close());
