import { randomUUID } from "node:crypto";
import { operationRegistry } from "../../output/codeup-centaurai-wanx-sdk/sdks/centaurai-wanx/dist/registry.js";

const managementPermissions = new Set([
  "applications_manage",
  "applications_develop",
  "providers",
  "storage_backends",
  "users",
  "plugins",
  "security",
  "admin_console",
  "desktop",
  "desktop_manage",
]);
const secretKey =
  /^(access_token|refresh_token|token|authorization|cookie|set-cookie|password|password_hash|api[_-]key|x[_-]api[_-]key|secret[_-]key|access[_-]key|private[_-]key|client[_-]secret)$/i;
export function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !secretKey.test(key))
        .map(([key, item]) => [key, publicData(item)]),
    );
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
    try {
      return JSON.stringify(publicData(JSON.parse(value)));
    } catch {
      /* Non-JSON text remains text. */
    }
  }
  return value;
}
export function retainSavedSecrets(original, edited) {
  if (!edited || typeof edited !== "object" || Array.isArray(edited))
    return edited;
  const result = { ...edited };
  if (!original || typeof original !== "object" || Array.isArray(original))
    return result;
  for (const [key, value] of Object.entries(original)) {
    if (secretKey.test(key) && !(key in result)) result[key] = value;
    else if (key in result && value && typeof value === "object")
      result[key] = retainSavedSecrets(value, result[key]);
  }
  return result;
}
export function validateBox(input) {
  if (!input || typeof input !== "object") throw new Error("盒子信息无效");
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 100)
    throw new Error("请输入不超过 100 字的盒子名称");
  if (input.connection === "p2p") {
    if (!/^[\w.-]{1,128}$/.test(String(input.deviceId ?? "")))
      throw new Error("设备 ID 无效");
    return {
      id: input.id || randomUUID(),
      name,
      connection: "p2p",
      deviceId: String(input.deviceId),
    };
  }
  const url = new URL(String(input.baseURL ?? ""));
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "连接地址必须是可信 HTTPS 服务根地址，或本机 HTTP 开发地址",
    );
  return {
    id: input.id || randomUUID(),
    name,
    connection: "https",
    baseURL: url.origin,
    deviceId: String(input.deviceId ?? "").slice(0, 128),
  };
}
const resources = {
  providers: {
    permission: "providers",
    list: "adminListProviders",
    create: "adminCreateProvider",
    update: "adminPatchProvider",
    delete: "adminDeleteProvider",
    test: "adminTestProvider",
    key: "provider_id",
  },
  storage: {
    permission: "storage_backends",
    list: "listStorageBackends",
    create: "createStorageBackend",
    update: "patchStorageBackend",
    delete: "deleteStorageBackend",
    test: "testStorageBackend",
    key: "backend_id",
  },
  connectors: {
    permission: "connectors",
    list: "getCustomMcp",
    update: "putCustomMcp",
  },
  skills: {
    permission: "skill_packages",
    list: "listSkillPackages",
    create: "createSkillPackage",
    update: "updateSkillPackage",
    delete: "deleteSkillPackage",
    key: "package_id",
  },
  plugins: {
    permission: "plugins",
    list: "listPlugins",
    create: "installPlugin",
    update: "patchPlugin",
    delete: "uninstallPlugin",
    key: "plugin_id",
  },
  security: {
    permission: "security",
    list: "getSecurityPolicy",
    update: "putSecurityPolicy",
  },
};
const standaloneAliases = [
  "login",
  "logout",
  "me",
  "getCapabilities",
  "getTimezoneSettings",
  "overview",
  "listUsers",
  "createUser",
  "patchUser",
  "listUserRoles",
  "createUserRole",
  "listPermissionCatalog",
  "auditLog",
  "getDesktopStatus",
  "installDesktop",
  "uninstallDesktop",
  "setDesktopGeometry",
];
const aliases = new Set([
  ...standaloneAliases,
  ...Object.values(resources).flatMap((x) => Object.values(x)),
]);
const operations = operationRegistry.filter(
  (o) =>
    aliases.has(o.alias) ||
    o.path.startsWith("/api/admin/applications") ||
    /\/api\/applications\/[^/]+\/release/.test(o.path),
);
// A narrow SDK policy is additional client hardening. The WANX server remains authoritative.
export function createAdminSession({
  emitState = () => {},
  emitDesktop = () => {},
  clientFactory,
  initialBoxes = [],
  saveBoxes = async () => {},
} = {}) {
  let boxes = initialBoxes.map(validateBox),
    context = null,
    generation = 0,
    desktop = null,
    state = {
      status: "disconnected",
      sessionId: null,
      boxes,
      box: null,
      user: null,
      capabilities: null,
      error: null,
      timezone: "Asia/Shanghai",
    };
  const publish = (next) => {
    state = { ...state, ...next, boxes: [...boxes] };
    emitState(publicData(state));
    return publicData(state);
  };
  const current = () => publicData(state);
  const assertSession = (sessionId) => {
    if (!context || state.status !== "connected" || sessionId !== context.id)
      throw new Error("连接已失效，请重新登录当前盒子");
    return context;
  };
  const assertCurrent = (ctx) => {
    if (context !== ctx || ctx.generation !== generation)
      throw new Error("盒子已切换，已丢弃旧连接的结果");
  };
  const can = (ctx, permission) =>
    ctx.user?.role === "admin" || ctx.user?.permissions?.includes(permission);
  const requirePermission = (ctx, permission) => {
    if (!can(ctx, permission))
      throw new Error(`当前账号没有 ${permission} 权限`);
  };
  function check(response) {
    if (response.status < 200 || response.status >= 300) {
      const detail = response.body?.detail;
      const message =
        response.body?.message ||
        (Array.isArray(detail)
          ? detail
              .map(
                (item) =>
                  `${item.loc?.join(".") || "请求"}: ${item.msg || "参数无效"}`,
              )
              .join("；")
          : typeof detail === "string"
          ? detail
          : null);
      const error = new Error(message || `WANX 请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.body;
  }
  async function native(ctx, alias, request = {}) {
    const op = operations.find((o) => o.alias === alias);
    if (!op) throw new Error("当前 SDK 尚未登记此接口");
    const result = await ctx.client.native.invoke(op.operationId, request, {
      signal: AbortSignal.timeout(15000),
    });
    assertCurrent(ctx);
    return check(result);
  }
  async function revalidate(ctx) {
    const user = await native(ctx, "me");
    ctx.user = user;
    const capabilities = await native(ctx, "getCapabilities");
    ctx.capabilities = capabilities;
    publish({ user, capabilities });
  }
  async function closeDesktop() {
    const socket = desktop;
    desktop = null;
    if (socket)
      await socket.close(1000, "administrator stopped").catch(() => {});
    emitDesktop({ type: "status", status: "stopped" });
  }
  async function disconnect(error = null) {
    generation++;
    const previous = context;
    context = null;
    publish({
      status: "disconnected",
      sessionId: null,
      user: null,
      capabilities: null,
      error,
    });
    await closeDesktop();
    await previous?.client.close().catch(() => {});
    return current();
  }
  async function connect(payload) {
    await disconnect();
    const box = boxes.find((x) => x.id === payload.boxId);
    if (!box) throw new Error("请先登记盒子");
    publish({ box, status: "connecting", error: null });
    if (box.connection === "p2p") {
      publish({
        status: "disconnected",
        error: "万象管理员的正式远程连接身份尚未登记；P2P 入口保持关闭。",
      });
      throw new Error(state.error);
    }
    const marker = generation,
      id = randomUUID();
    let token = null;
    const sdk = clientFactory
      ? null
      : {
          ...(await import(
            "../../output/codeup-centaurai-wanx-sdk/sdks/centaurai-wanx/dist/client.js"
          )),
          ...(await import(
            "../../output/codeup-centaurai-wanx-sdk/sdks/centaurai-wanx/dist/http-transport.js"
          )),
        };
    if (marker !== generation) throw new Error("盒子已切换");
    const client = clientFactory
      ? clientFactory(box)
      : sdk.createCentaurAIWanxClient({
          transport: sdk.createHTTPTransport({
            baseURL: box.baseURL,
            token: async () => token,
          }),
          policy: {
            applicationId: "wanx-admin-desktop",
            operations: operations.map((x) => x.operationId),
            sockets: ["desktop-stream"],
          },
        });
    const ctx = {
      id,
      generation: marker,
      client,
      user: null,
      capabilities: null,
    };
    context = ctx;
    try {
      const result = await native(ctx, "login", {
        body: {
          username: payload.username,
          password: payload.password,
          application_id: "wanx",
          ...(payload.captchaToken
            ? { captcha_token: payload.captchaToken }
            : {}),
        },
      });
      token = result.access_token;
      if (!token) throw new Error("WANX 登录未返回有效凭据");
      ctx.user = await native(ctx, "me");
      if (ctx.user.application_id && ctx.user.application_id !== "wanx")
        throw new Error("此登录没有系统管理作用域");
      if (
        ctx.user.role !== "admin" &&
        !ctx.user.permissions?.some((p) => managementPermissions.has(p))
      )
        throw new Error("此账号没有盒子管理权限");
      ctx.capabilities = await native(ctx, "getCapabilities");
      const timezone = await native(ctx, "getTimezoneSettings");
      assertCurrent(ctx);
      publish({
        status: "connected",
        sessionId: id,
        user: ctx.user,
        capabilities: ctx.capabilities,
        timezone: timezone.timezone || "Asia/Shanghai",
        error: null,
      });
      return current();
    } catch (error) {
      await client.close().catch(() => {});
      if (context === ctx) {
        context = null;
        publish({
          status: "disconnected",
          sessionId: null,
          user: null,
          capabilities: null,
          error: error.message,
        });
      }
      throw error;
    }
  }
  async function apps(ctx, method, ...args) {
    if (!can(ctx, "applications_manage") && !can(ctx, "applications_develop"))
      throw new Error("当前账号没有产品管理或开发权限");
    if (!ctx.capabilities?.sdk_management?.applications)
      throw new Error("当前 WANX 未提供产品管理协议，请先升级服务端");
    if (!ctx.client.applications?.[method])
      throw new Error("当前 SDK 未提供产品管理接口");
    const response = await ctx.client.applications[method](...args, {
      signal: AbortSignal.timeout(15000),
    });
    assertCurrent(ctx);
    return check(response);
  }
  async function request(action, payload = {}, sessionId) {
    if (action === "state") return current();
    if (action === "boxes.save") {
      const box = validateBox(payload);
      if (
        boxes.some((x) => x.id === box.id) &&
        context &&
        state.box?.id === box.id
      )
        await disconnect();
      boxes = [...boxes.filter((x) => x.id !== box.id), box];
      await saveBoxes(boxes);
      return publish({});
    }
    if (action === "boxes.remove") {
      if (state.box?.id === payload.id) await disconnect();
      boxes = boxes.filter((x) => x.id !== payload.id);
      await saveBoxes(boxes);
      return publish({ box: state.box?.id === payload.id ? null : state.box });
    }
    if (action === "connect") return connect(payload);
    if (action === "disconnect") return disconnect();
    const ctx = assertSession(sessionId);
    try {
      // Every operation refreshes authoritative permissions; a restored TCP path is not a restored login.
      await revalidate(ctx);
      assertCurrent(ctx);
      let result;
      switch (action) {
        case "refresh":
          return current();
        case "overview":
          requirePermission(ctx, "admin_console");
          result = await native(ctx, "overview");
          break;
        case "resource.list":
        case "resource.create":
        case "resource.update":
        case "resource.delete":
        case "resource.test": {
          const resource = resources[payload.section];
          if (!resource) throw new Error("配置模块无效");
          requirePermission(ctx, resource.permission);
          const operation = resource[action.split(".")[1]];
          if (!operation) throw new Error("此配置模块不支持该操作");
          let body = payload.body;
          if (
            payload.section === "connectors" &&
            action === "resource.update"
          ) {
            if (
              !body ||
              typeof body.servers !== "object" ||
              Array.isArray(body.servers) ||
              Object.keys(body).some((key) => key !== "servers")
            )
              throw new Error(
                "MCP 配置必须为 { servers: { … } }，请保留要继续使用的服务",
              );
            const saved = await native(ctx, resource.list);
            body = retainSavedSecrets(saved, body);
          }
          const request = {
            ...(resource.key && payload.id != null
              ? { path: { [resource.key]: payload.id } }
              : {}),
            ...(body !== undefined ? { body } : {}),
          };
          result = await native(ctx, operation, request);
          break;
        }
        case "products.list":
          result = await apps(ctx, "list");
          break;
        case "products.create":
          result = await apps(ctx, "create", payload.body);
          break;
        case "products.update": {
          const { application_id: ignoredId, ...patch } = payload.body;
          result = await apps(ctx, "update", payload.applicationId, patch);
          break;
        }
        case "deployment.get":
          result = await apps(ctx, "getDeployment", payload.applicationId);
          break;
        case "deployment.put":
          result = await apps(
            ctx,
            "putDeployment",
            payload.applicationId,
            payload.body,
          );
          break;
        case "releases.list":
          result = await apps(ctx, "listReleases", payload.applicationId);
          break;
        case "releases.create":
          result = await apps(
            ctx,
            "createRelease",
            payload.applicationId,
            payload.body,
          );
          break;
        case "releases.recommend":
          result = await apps(
            ctx,
            "recommendRelease",
            payload.applicationId,
            payload.version,
            payload.body,
          );
          break;
        case "access.list":
          result = await apps(ctx, "listAccess", payload.applicationId);
          break;
        case "access.put":
          result = await apps(ctx, "putAccess", payload.applicationId, {
            user_id: payload.userId,
            ...payload.body,
          });
          break;
        case "manifest.get":
          result = await apps(ctx, "getManifest", payload.applicationId);
          break;
        case "users.list":
          requirePermission(ctx, "users");
          result = await native(ctx, "listUsers");
          break;
        case "users.create":
          requirePermission(ctx, "users");
          result = await native(ctx, "createUser", { body: payload.body });
          break;
        case "users.update":
          requirePermission(ctx, "users");
          result = await native(ctx, "patchUser", {
            path: { user_id: payload.userId },
            body: payload.body,
          });
          break;
        case "roles.list":
          requirePermission(ctx, "users");
          result = await native(ctx, "listUserRoles");
          break;
        case "permissions.list":
          requirePermission(ctx, "users");
          result = await native(ctx, "listPermissionCatalog");
          break;
        case "roles.create":
          requirePermission(ctx, "users");
          result = await native(ctx, "createUserRole", { body: payload.body });
          break;
        case "audit":
          requirePermission(ctx, "admin_console");
          result = await native(ctx, "auditLog", { query: { limit: 100 } });
          break;
        case "desktop.status":
          requirePermission(ctx, "desktop");
          result = await native(ctx, "getDesktopStatus");
          break;
        case "desktop.geometry":
          requirePermission(ctx, "desktop_manage");
          result = await native(ctx, "setDesktopGeometry", {
            body: { geometry: payload.geometry },
          });
          break;
        case "desktop.maintain": {
          requirePermission(ctx, "desktop_manage");
          const alias =
            payload.operation === "install"
              ? "installDesktop"
              : payload.operation === "uninstall"
              ? "uninstallDesktop"
              : null;
          if (!alias) throw new Error("维护操作无效");
          const op = operations.find((x) => x.alias === alias);
          const stream = await ctx.client.native.stream(op.operationId, {
            body: {},
          });
          assertCurrent(ctx);
          if (stream.status < 200 || stream.status >= 300) {
            await stream.close();
            throw new Error(`桌面维护失败 (${stream.status})`);
          }
          let log = "";
          try {
            for await (const chunk of stream.chunks) {
              assertCurrent(ctx);
              log += new TextDecoder().decode(chunk);
              if (log.length > 262144) log = log.slice(-262144);
            }
          } finally {
            await stream.close();
          }
          result = { log };
          break;
        }
        case "desktop.open": {
          requirePermission(ctx, "desktop");
          const mode = payload.mode === "control" ? "control" : "view";
          if (mode === "control") requirePermission(ctx, "desktop_control");
          await closeDesktop();
          assertCurrent(ctx);
          const socket = await ctx.client.openSocket({
            endpoint: "desktop-stream",
          });
          assertCurrent(ctx);
          desktop = socket;
          await socket.send({
            kind: "text",
            text: JSON.stringify({
              type: "start",
              mode,
              quality: 75,
              max_fps: 10,
            }),
          });
          ctx.desktopMode = mode;
          void (async () => {
            try {
              for await (const frame of socket.frames) {
                assertCurrent(ctx);
                if (desktop !== socket) return;
                if (frame.kind === "text") {
                  const data = JSON.parse(frame.text);
                  if (
                    [
                      "frame",
                      "display",
                      "status",
                      "error",
                      "action_result",
                    ].includes(data.type)
                  )
                    emitDesktop(publicData(data));
                }
              }
            } catch {
              if (desktop === socket)
                emitDesktop({
                  type: "error",
                  message: "桌面连接已中断，请重新连接",
                });
            } finally {
              if (desktop === socket) {
                desktop = null;
                emitDesktop({ type: "status", status: "stopped" });
              }
              await socket.close().catch(() => {});
            }
          })();
          result = { mode };
          break;
        }
        case "desktop.close":
          await closeDesktop();
          result = {};
          break;
        case "desktop.input": {
          requirePermission(ctx, "desktop_control");
          if (!desktop || ctx.desktopMode !== "control")
            throw new Error("请先显式进入控制模式");
          const allowed = new Set([
            "click",
            "dblclick",
            "mousedown",
            "mouseup",
            "mousemove",
            "scroll",
            "type",
            "keydown",
            "keyup",
          ]);
          if (
            !allowed.has(payload.type) ||
            Object.keys(payload).some(
              (k) =>
                ![
                  "type",
                  "x",
                  "y",
                  "canvas_width",
                  "canvas_height",
                  "screen_width",
                  "screen_height",
                  "button",
                  "delta_x",
                  "delta_y",
                  "text",
                  "key",
                ].includes(k),
            )
          )
            throw new Error("桌面输入事件无效");
          await desktop.send({ kind: "text", text: JSON.stringify(payload) });
          result = {};
          break;
        }
        default:
          throw new Error("未允许的管理操作");
      }
      assertCurrent(ctx);
      return publicData(result);
    } catch (error) {
      if (
        context === ctx &&
        (error.status === 401 ||
          error.status === 403 ||
          error.code === "SESSION_CLOSED" ||
          error instanceof TypeError ||
          ["TimeoutError", "AbortError"].includes(error.name))
      )
        await disconnect("连接或授权已失效，请重新登录并验证权限");
      throw error;
    }
  }
  return { request, disconnect, current };
}
