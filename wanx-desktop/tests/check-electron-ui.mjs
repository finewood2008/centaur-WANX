import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.WANX_TEST_PLAYWRIGHT ||
  "/Users/finewood/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const { WebSocketServer } = require("ws");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = resolve(root, "../verification/electron-ui");
const user = {
  id: 1,
  username: "synthetic-ui-admin",
  display_name: "模拟管理员",
  role: "admin",
  permissions: ["*"],
  locale: "zh",
};
const products = [];
const requests = [];
const server = http.createServer(async (req, res) => {
  const parts = [];
  for await (const chunk of req) parts.push(chunk);
  const body = Buffer.concat(parts).toString();
  const url = new URL(req.url, "http://localhost");
  requests.push({ path: url.pathname, method: req.method });
  let data = {};
  if (url.pathname === "/api/auth/login")
    data = { access_token: "private-ui-fixture-token", user };
  else if (url.pathname === "/api/auth/me") data = user;
  else if (url.pathname === "/api/agents") data = [];
  else if (url.pathname === "/api/preferences")
    data = {
      locale: "zh",
      remote_browser_bookmarks: [],
      preferred_model: null,
      model_reasoning: {},
      sidebar_nav: { groups: [], items: [{ key: "chat" }] },
    };
  else if (url.pathname === "/api/settings/timezone")
    data = { timezone: "Asia/Shanghai" };
  else if (url.pathname.startsWith("/api/i18n/")) data = { labels: {} };
  else if (url.pathname === "/api/settings/capabilities")
    data = {
      server_version: "synthetic-ui",
      mobile: { enabled: false },
      sdk_management: { applications: true, protocol_version: 1 },
    };
  else if (url.pathname === "/api/admin/applications") {
    if (req.method === "POST") {
      const product = {
        ...JSON.parse(body),
        created_by: 1,
        created_at: 1,
        updated_at: 1,
        connection_identity: { status: "pending" },
      };
      products.push(product);
      data = product;
    } else data = products;
  } else if (/\/api\/admin\/applications\/.+\/deployment$/.test(url.pathname))
    data = {
      application_id: products[0]?.application_id,
      enabled: false,
      resource_bindings: {},
      configuration: {},
      updated_at: 1,
    };
  else if (
    /\/api\/admin\/applications\/.+\/(releases|access)$/.test(url.pathname)
  )
    data = [];
  else if (url.pathname === "/api/setup/status")
    data = { setup_required: false };
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
});
const sockets = new WebSocketServer({ server });
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const baseURL = `http://127.0.0.1:${server.address().port}`;
const userData = await mkdtemp(join(tmpdir(), "wanx-computer-ui-"));
await mkdir(artifacts, { recursive: true });
let electron;
let page;
const errors = [];
const consoleMessages = [];
try {
  const env = { ...process.env, WANX_DESKTOP_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!process.env.WANX_TEST_ELECTRON)
    throw new Error("Set WANX_TEST_ELECTRON to an unpackaged Electron runtime");
  electron = await _electron.launch({
    executablePath: process.env.WANX_TEST_ELECTRON,
    args: [root],
    env,
    timeout: 30000,
  });
  electron
    .process()
    .stdout?.on("data", (data) => consoleMessages.push(data.toString()));
  electron
    .process()
    .stderr?.on("data", (data) => consoleMessages.push(data.toString()));
  page = await electron.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.waitForLoadState("domcontentloaded");
  // Keep the synthetic user's Chinese UI stable across system locale settings.
  await page.evaluate(() => localStorage.setItem("octop:ui-locale", "zh"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  console.log(
    "Initial",
    await page.evaluate(() => ({
      url: location.href,
      bridge: Boolean(window.wanxDesktop),
      body: document.body.innerText,
    })),
  );
  await page.getByText(/电脑端平台账号|Computer platform account/).waitFor();
  assert.ok(page.url().startsWith("http://127.0.0.1:"));
  assert.notEqual(new URL(page.url()).origin, baseURL);
  await page.screenshot({
    path: join(artifacts, "computer-boxes.png"),
    fullPage: true,
  });
  await page.getByRole("menuitem", { name: /应用中心|Applications/ }).click();
  await page.getByText(/先连接盒子|Connect to a box and verify/).waitFor();
  await page
    .getByRole("menuitem", { name: /盒子连接|Box connections/ })
    .click();
  await page
    .getByText(
      /已有可信服务的兼容接入|Compatibility connection to an existing service/,
    )
    .click();
  await page.getByLabel(/WANX 服务地址|WANX service URL/).fill(baseURL);
  await page
    .getByLabel(/盒子本地用户名|Box-local username/)
    .last()
    .fill("synthetic-ui-admin");
  await page
    .getByLabel(/盒子本地密码|Box-local password/)
    .last()
    .fill("synthetic-ui-password");
  await page
    .getByRole("button", { name: /连接并重新登录|Connect and sign in again/ })
    .click();
  await page
    .getByText(/盒子已连接|Box connected/, { exact: true })
    .waitFor({ timeout: 20000 });
  const clientOrigin = new URL(page.url()).origin;
  assert.notEqual(clientOrigin, baseURL);
  const tokenCheck = await page.evaluate(() => ({
    token: window.wanxDesktop.sessionToken(),
    local: localStorage.getItem("auth_token"),
    session: sessionStorage.getItem("auth_token"),
  }));
  assert.notEqual(tokenCheck.token, "private-ui-fixture-token");
  assert.equal(tokenCheck.local, null);
  assert.equal(tokenCheck.session, null);
  await page
    .getByText(/应用中心|Applications/, { exact: true })
    .first()
    .click();
  await page.getByLabel(/产品标识|Product ID/).fill("synthetic.ui.product");
  await page.getByLabel(/应用名称|Product name/).fill("模拟产品");
  await page
    .getByRole("button", { name: /保存本地草稿|Save local draft/ })
    .click();
  await page.getByText(/草稿已按盒子|Draft saved locally/).waitFor();
  await page.getByLabel(/应用名称|Product name/).fill("临时修改");
  await page
    .getByRole("button", { name: /恢复本地草稿|Restore local draft/ })
    .click();
  await page.waitForFunction(
    () => document.getElementById("name")?.value === "模拟产品",
  );
  await page
    .getByRole("button", { name: /保存产品定义|Save definition/ })
    .click();
  await page.getByRole("tab", { name: /盒子部署|Box deployment/ }).waitFor();
  await page.screenshot({
    path: join(artifacts, "computer-applications.png"),
    fullPage: true,
  });
  assert.equal(products[0].application_id, "synthetic.ui.product");
  assert.ok(
    requests.some(
      (item) =>
        item.path === "/api/admin/applications" && item.method === "POST",
    ),
  );
  await page.getByRole("button", { name: /断开盒子|Disconnect box/ }).click();
  await page
    .getByText(/未连接盒子|No box connected/, { exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => window.wanxDesktop.sessionToken()),
    "",
  );
  assert.equal(new URL(page.url()).origin, clientOrigin);
  assert.deepEqual(errors, []);
  await writeFile(
    join(artifacts, "electron-ui.json"),
    JSON.stringify(
      {
        result: "passed",
        packagedApp: await electron.evaluate(({ app }) => app.isPackaged),
        syntheticOnly: true,
        independentUIOrigin: true,
        clientTabsVisibleBeforeConnecting: true,
        oldServerSidebarPreservesClientTabs: true,
        sdkDirectAdapterLogin: true,
        nativeCredentialsHidden: true,
        localDraftRestored: true,
        applicationCreatedThroughSDK: true,
        disconnectReturnsToLocalClient: true,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log("WANX computer Electron UI acceptance passed.");
} catch (error) {
  console.log("Electron diagnostics", { errors, consoleMessages });
  if (page && !page.isClosed()) {
    await page.screenshot({
      path: join(artifacts, "electron-ui-failure.png"),
      fullPage: true,
    });
    await writeFile(
      join(artifacts, "electron-ui-failure.json"),
      JSON.stringify(
        {
          url: page.url(),
          errors,
          consoleMessages,
          state: await page.evaluate(() => ({
            bridge: Boolean(window.wanxDesktop),
            body: document.body.innerText,
          })),
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await electron?.close();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(userData, { recursive: true, force: true });
}
