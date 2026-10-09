import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdminSession } from "./session.mjs";
import { isTrustedMainFrame } from "./ipc-auth.mjs";
import { createDraftStore } from "./drafts.mjs";
import { generateWanxApplicationProject } from "../../output/codeup-centaurai-wanx-sdk/sdks/centaurai-wanx/dist/project-generator.js";

if (process.env.WANX_ADMIN_USER_DATA)
  app.setPath("userData", path.resolve(process.env.WANX_ADMIN_USER_DATA));
let window, service, heartbeat;
const ready = async () => {
  const stateFile = path.join(app.getPath("userData"), "boxes.json");
  const drafts = createDraftStore(
    path.join(app.getPath("userData"), "product-drafts.json"),
  );
  let initialBoxes = [];
  try {
    initialBoxes = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("盒子目录不可读取，使用空目录");
  }
  service = createAdminSession({
    initialBoxes,
    saveBoxes: async (boxes) => {
      await mkdir(app.getPath("userData"), { recursive: true });
      await writeFile(stateFile, JSON.stringify(boxes, null, 2), {
        mode: 0o600,
      });
    },
    emitState: (state) => window?.webContents.send("wanx-admin:state", state),
    emitDesktop: (frame) =>
      window?.webContents.send("wanx-admin:desktop", frame),
  });
  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: "万象管理员",
    backgroundColor: "#f5f7fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const rendererFile = path.join(__dirname, "../dist/index.html");
  const allowedURL = pathToFileURL(rendererFile).href;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  ipcMain.handle("wanx-admin:request", async (event, input) => {
    if (!isTrustedMainFrame(event, window?.webContents, allowedURL))
      throw new Error("未允许的调用来源");
    if (
      !input ||
      typeof input.action !== "string" ||
      !input.payload ||
      typeof input.payload !== "object"
    )
      throw new Error("管理请求无效");
    const { action, payload, sessionId } = input;
    if (action === "draft.get" || action === "draft.put") {
      await service.request("products.list", {}, sessionId);
      const state = service.current();
      const scope = {
        boxId: state.box.id,
        userId: state.user.id,
        applicationId: payload.applicationId,
      };
      const result = await (action === "draft.get"
        ? drafts.get(scope)
        : drafts.put(scope, payload.body));
      await service.request("products.list", {}, sessionId);
      return result;
    }
    if (action === "manifest.import") {
      // Verify the session before opening a file dialog and again at every server write.
      await service.request("refresh", {}, sessionId);
      const selected = await dialog.showOpenDialog(window, {
        title: "导入产品清单",
        filters: [{ name: "WANX 产品清单", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (selected.canceled) return null;
      const text = await readFile(selected.filePaths[0], "utf8");
      if (text.length > 1048576) throw new Error("产品清单超过 1 MiB");
      const manifest = JSON.parse(text);
      if (
        manifest.schema_version !== 1 ||
        !manifest.product?.application_id ||
        !manifest.deployment
      )
        throw new Error("产品清单格式无效");
      const {
        application_id,
        name,
        description,
        capabilities,
        agent_template,
        resource_requirements,
      } = manifest.product;
      const product = {
        application_id,
        name,
        description: description || "",
        capabilities: capabilities || [],
        agent_template: agent_template || {},
        resource_requirements: resource_requirements || {},
      };
      const existing = await service.request("products.list", {}, sessionId);
      const alreadyRegistered = existing.some(
        (item) => item.application_id === application_id,
      );
      const { application_id: ignoredId, ...patch } = product;
      await service.request(
        alreadyRegistered ? "products.update" : "products.create",
        {
          applicationId: application_id,
          body: alreadyRegistered ? patch : product,
        },
        sessionId,
      );
      try {
        const { enabled, resource_bindings, configuration } =
          manifest.deployment;
        await service.request(
          "deployment.put",
          {
            applicationId: application_id,
            body: { enabled, resource_bindings, configuration },
          },
          sessionId,
        );
      } catch (error) {
        throw new Error(`产品定义已保存，部署配置尚未导入：${error.message}`);
      }
      return { application_id };
    }
    if (action === "manifest.export" || action === "project.generate") {
      const manifest = await service.request(
        "manifest.get",
        { applicationId: payload.applicationId },
        sessionId,
      );
      if (action === "manifest.export") {
        const selected = await dialog.showSaveDialog(window, {
          title: "导出产品清单",
          defaultPath: `${manifest.product.application_id}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (selected.canceled) return null;
        await service.request("refresh", {}, sessionId);
        await writeFile(selected.filePath, JSON.stringify(manifest, null, 2), {
          mode: 0o600,
        });
        return { file: selected.filePath };
      }
      const selected = await dialog.showOpenDialog(window, {
        title: "选择工程的父目录",
        properties: ["openDirectory", "createDirectory"],
      });
      if (selected.canceled) return null;
      const sdk = await dialog.showOpenDialog(window, {
        title: "选择 centaurai-wanx SDK 的 npm tarball",
        filters: [{ name: "SDK npm package", extensions: ["tgz"] }],
        properties: ["openFile"],
      });
      if (sdk.canceled) return null;
      await service.request("refresh", {}, sessionId);
      return generateWanxApplicationProject({
        directory: path.join(
          selected.filePaths[0],
          manifest.product.application_id,
        ),
        manifest,
        sdkTarball: sdk.filePaths[0],
      });
    }
    return service.request(action, payload, sessionId);
  });
  await window.loadFile(rendererFile);
  heartbeat = setInterval(() => {
    const state = service.current();
    if (state.status === "connected")
      void service
        .request("refresh", {}, state.sessionId)
        .catch(() => service.disconnect("连接或授权已失效，请重新登录"));
  }, 15000);
  window.on("closed", () => {
    window = null;
    clearInterval(heartbeat);
    void service.disconnect();
  });
};
app.whenReady().then(ready);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  clearInterval(heartbeat);
  void service?.disconnect();
});
