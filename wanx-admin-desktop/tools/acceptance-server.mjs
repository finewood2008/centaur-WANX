/** Loopback-only synthetic UI acceptance service. No real box, account or user content. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
const host = "127.0.0.1",
  port = Number(process.env.WANX_ADMIN_ACCEPTANCE_PORT || 8897);
const username = "synthetic-admin",
  password = "synthetic-pass",
  token = "synthetic-acceptance-main-only";
const now = () => Math.floor(Date.now() / 1000),
  audit = [],
  users = [
    {
      id: 1,
      username,
      role: "admin",
      display_name: "合成验收管理员",
      permissions: [],
      disabled: false,
      created_at: now(),
    },
  ];
const permissionKeys = [
  "applications_manage",
  "applications_develop",
  "providers",
  "storage_backends",
  "connectors",
  "skill_packages",
  "plugins",
  "security",
  "users",
  "admin_console",
  "desktop",
  "desktop_control",
  "desktop_manage",
];
const roles = [
  {
    user_role_id: "admin",
    user_role_name: "系统管理员",
    is_admin: true,
    permissions: [],
  },
  {
    user_role_id: "user",
    user_role_name: "普通使用者",
    is_admin: false,
    permissions: [],
  },
];
const products = [
  {
    application_id: "zhijun",
    name: "知君 · 合成验收",
    description: "仅用于管理流程验收，没有真实用户资料。",
    capabilities: ["chat", "memory", "knowledge", "upload", "voice"],
    agent_template: {},
    resource_requirements: {},
    created_by: 1,
    created_at: now(),
    updated_at: now(),
    connection_identity: {
      status: "pending",
      application_id: "zhijun",
      remote_enabled: false,
    },
  },
];
const deployments = new Map([
    [
      "zhijun",
      {
        application_id: "zhijun",
        enabled: false,
        resource_bindings: {},
        configuration: {},
        updated_at: now(),
      },
    ],
  ]),
  releases = new Map(),
  access = new Map();
const resources = {
  providers: [
    {
      id: "synthetic-provider",
      name: "合成模型服务",
      kind: "openai",
      base_url: "https://example.invalid/v1",
      api_key: "synthetic-key",
      models: [{ id: "synthetic-model" }],
      enabled: true,
    },
  ],
  "storage-backends": [],
  "custom-mcp": { servers: {} },
  "skill-packages": [],
  plugins: [],
  security: {},
};
const record = (action, target = "synthetic") =>
  audit.unshift({
    id: randomUUID(),
    created_at: now(),
    actor: username,
    action,
    target,
  });
const readBody = async (request) => {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1048576) throw new Error("body too large");
  }
  return text ? JSON.parse(text) : {};
};
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  const send = (value, status = 200) => {
    response.statusCode = status;
    response.end(JSON.stringify(value));
  };
  try {
    const url = new URL(request.url, `http://${host}:${port}`),
      route = decodeURIComponent(url.pathname),
      method = request.method,
      body = await readBody(request);
    if (route === "/api/auth/login") {
      if (
        body.username !== username ||
        body.password !== password ||
        body.application_id !== "wanx"
      )
        return send({ message: "合成账号凭据不匹配" }, 401);
      return send({ access_token: token, user: users[0] });
    }
    if (request.headers.authorization !== `Bearer ${token}`)
      return send({ message: "合成服务需要登录" }, 401);
    if (route === "/api/auth/me")
      return send({ ...users[0], application_id: "wanx" });
    if (route === "/api/settings/capabilities")
      return send({
        server_version: "1.0.2b4",
        sdk_management: {
          protocol_version: 1,
          applications: true,
          remote_identity_registration: false,
        },
        permissions: permissionKeys,
        synthetic: true,
      });
    if (route === "/api/settings/timezone")
      return send({ timezone: "Asia/Shanghai" });
    if (route === "/api/admin/overview")
      return send({
        mode: "synthetic-acceptance",
        users: users.length,
        products: products.length,
        box: "本机合成验收",
        note: "没有真实盒子或私人内容",
      });
    if (route === "/api/users/permissions")
      return send(permissionKeys.map((key) => ({ key, label_zh: key })));
    if (route === "/api/users/roles") {
      if (method === "POST") {
        const role = { user_role_id: randomUUID(), ...body, is_admin: false };
        roles.push(role);
        record("role.create", role.user_role_id);
        return send(role, 201);
      }
      return send(roles);
    }
    if (route === "/api/users") {
      if (method === "POST") {
        const { password: ignored, ...fields } = body;
        const user = {
          ...fields,
          id: users.length + 1,
          disabled: false,
          created_at: now(),
        };
        users.push(user);
        record("user.create", String(user.id));
        return send(user, 201);
      }
      return send(users);
    }
    const userMatch = route.match(/^\/api\/users\/(\d+)$/);
    if (userMatch && method === "PATCH") {
      const user = users.find((item) => item.id === Number(userMatch[1]));
      if (!user) return send({ message: "合成用户不存在" }, 404);
      Object.assign(user, body);
      record("user.update", userMatch[1]);
      return send(user);
    }
    if (route === "/api/admin/audit-log") return send(audit.slice(0, 100));
    if (route === "/api/admin/applications") {
      if (method === "POST") {
        if (
          products.some((item) => item.application_id === body.application_id)
        )
          return send({ message: "产品已登记" }, 409);
        const product = {
          ...body,
          created_by: 1,
          created_at: now(),
          updated_at: now(),
          connection_identity: {
            status: "pending",
            application_id: body.application_id,
            remote_enabled: false,
          },
        };
        products.push(product);
        deployments.set(body.application_id, {
          application_id: body.application_id,
          enabled: false,
          resource_bindings: {},
          configuration: {},
          updated_at: now(),
        });
        record("application.create", body.application_id);
        return send(product, 201);
      }
      return send(products);
    }
    const appRoute = route.match(/^\/api\/admin\/applications\/([^/]+)(.*)$/);
    if (appRoute) {
      const id = appRoute[1],
        suffix = appRoute[2],
        product = products.find((item) => item.application_id === id);
      if (!product) return send({ message: "产品未登记" }, 404);
      if (!suffix) {
        if (method === "PATCH") {
          if ("application_id" in body)
            return send(
              { message: "ProductPatch forbids application_id" },
              422,
            );
          Object.assign(product, body, { updated_at: now() });
          record("application.update", id);
        }
        return send(product);
      }
      if (suffix === "/deployment") {
        if (method === "PUT") {
          deployments.set(id, {
            application_id: id,
            ...body,
            updated_at: now(),
          });
          record(
            body.enabled ? "application.enable" : "application.disable",
            id,
          );
        }
        return send(deployments.get(id));
      }
      if (suffix === "/manifest")
        return send({
          schema_version: 1,
          product,
          deployment: deployments.get(id),
        });
      if (suffix === "/releases") {
        const items = releases.get(id) || [];
        if (method === "POST") {
          const release = { ...body, created_at: now(), recommended: false };
          items.push(release);
          releases.set(id, items);
          record("release.create", `${id}:${body.version}`);
          return send(release, 201);
        }
        return send(items);
      }
      const recommendation = suffix.match(/^\/releases\/([^/]+)\/recommend$/);
      if (recommendation) {
        const items = releases.get(id) || [];
        const release = items.find(
          (item) =>
            item.version === recommendation[1] &&
            item.platform === body.platform &&
            item.arch === body.arch,
        );
        if (!release) return send({ message: "版本未登记" }, 404);
        for (const item of items)
          if (item.platform === release.platform && item.arch === release.arch)
            item.recommended = item === release;
        record("release.recommend", `${id}:${release.version}`);
        return send(release);
      }
      if (suffix === "/access") {
        const items = access.get(id) || [];
        if (method === "PUT") {
          const item = {
            user_id: body.user_id,
            enabled: body.enabled,
            updated_at: now(),
          };
          access.set(id, [
            ...items.filter((entry) => entry.user_id !== item.user_id),
            item,
          ]);
          record(
            body.enabled ? "access.grant" : "access.revoke",
            `${id}:user-${item.user_id}`,
          );
          return send(item);
        }
        return send(items);
      }
    }
    if (route === "/api/desktop/status")
      return send({
        ok: true,
        setup_state: "ready",
        platform: "synthetic",
        permissions_needed: [],
        reason: "这是合成桌面流，不能代表真实盒子远程桌面验收。",
      });
    if (/^\/api\/desktop\/(install|uninstall)$/.test(route)) {
      record(`desktop.${route.split("/").pop()}`);
      return send({
        synthetic: true,
        result: "合成组件维护响应，没有系统操作",
      });
    }
    let section, id;
    if (route.startsWith("/api/admin/providers")) {
      section = "providers";
      id = route.split("/")[4];
    } else if (route.startsWith("/api/admin/storage-backends")) {
      section = "storage-backends";
      id = route.split("/")[4];
    } else if (route === "/api/connectors/custom-mcp") section = "custom-mcp";
    else if (route.startsWith("/api/skill-packages")) {
      section = "skill-packages";
      id = route.split("/")[3];
    } else if (route.startsWith("/api/plugins")) {
      section = "plugins";
      id = route.split("/")[3];
    } else if (route === "/api/admin/security") section = "security";
    if (section) {
      if (route.endsWith("/test")) return send({ ok: true, synthetic: true });
      if (!Array.isArray(resources[section])) {
        if (method === "PUT") {
          resources[section] = body;
          record("resource.update", section);
        }
        return send(resources[section]);
      }
      const list = resources[section];
      if (method === "POST") {
        const item = { ...body, id: randomUUID() };
        list.push(item);
        record("resource.create", section);
        return send(item, 201);
      }
      if (method === "PATCH") {
        const item = list.find((entry) => String(entry.id) === id);
        if (!item) return send({ message: "资源未找到" }, 404);
        Object.assign(item, body);
        record("resource.update", section);
        return send(item);
      }
      if (method === "DELETE") {
        resources[section] = list.filter((entry) => String(entry.id) !== id);
        record("resource.delete", section);
        return send({ ok: true });
      }
      return send(list);
    }
    send({ message: `合成服务未提供 ${method} ${route}` }, 404);
  } catch (error) {
    send({ message: error.message }, 400);
  }
});
const websocket = new WebSocketServer({
  server,
  path: "/api/desktop-stream/ws",
});
websocket.on("connection", (socket, request) => {
  if (
    new URL(request.url, `http://${host}`).searchParams.get("token") !== token
  ) {
    socket.close(4001);
    return;
  }
  let mode = "view";
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "start") {
      mode = message.mode === "control" ? "control" : "view";
      record("desktop.session.start", `synthetic:${mode}`);
      socket.send(
        JSON.stringify({
          type: "status",
          status: "streaming",
          synthetic: true,
        }),
      );
      socket.send(
        JSON.stringify({
          type: "frame",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          width: 1280,
          height: 720,
          synthetic: true,
        }),
      );
    } else if (mode === "control")
      record("desktop.synthetic.input", message.type);
  });
  socket.on("close", () => record("desktop.session.end", `synthetic:${mode}`));
});
server.listen(port, host, () =>
  console.log(
    JSON.stringify({
      url: `http://${host}:${port}`,
      username,
      password,
      synthetic: true,
      note: "仅本机合成验收，没有真实盒子或用户资料",
    }),
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    websocket.close();
    server.close(() => process.exit(0));
  });
