# WANX 客户端结构对比与 P2P 集成计划

## 基线与本阶段边界

- 远端分支 `upstream/dev/uni_deploy_20261010` 已合并到当前工作分支。
- 当前远端基线提交：`19a540959b01157997f277376e0167e1b9ddc6e0`。
- 远端 `wanx-client/` 的连接链路已验证可以连接设备列表中名称以 `102` 结尾的盒子并打开 Dashboard。
- 本地 UI 已从合并前快照恢复到 [`wanx-client/local-ui/`](../wanx-client/local-ui/)，并由远端 shell 作为活动控制页加载。
- 102 盒子 P2P 连接和 Dashboard 已经验证；本轮继续接入盒子发现扫描和 BLE 配网，不改已验证的 P2P 连接实现。
- 盒端访问约束：后续产品路径只允许 P2P；远端代码中保留的 direct 连接能力不能作为本次接入路径。

## 当前目录的两套结构

| 能力 | 已合并的远端结构 | 恢复的本地结构 | 集成判断 |
| --- | --- | --- | --- |
| Electron 入口 | [`wanx-client/shell/main.mjs`](../wanx-client/shell/main.mjs) | `wanx-client/local-ui/main.mjs`（历史快照） | 远端入口继续承载 P2P 生命周期；本地入口不覆盖它。 |
| 控制页 | [`wanx-client/fleet/index.html`](../wanx-client/fleet/index.html)、`fleet/app.js`、`fleet/style.css` | [`wanx-client/local-ui/renderer/index.html`](../wanx-client/local-ui/renderer/index.html)、`renderer.js`、`styles.css` | `fleet` 是测试控制 UI；本地 `renderer` 才是产品 UI 候选。应迁移 UI 表达，不应把测试页面当产品页面。 |
| Preload / IPC | [`wanx-client/shell/preload.cjs`](../wanx-client/shell/preload.cjs)、[`shell/control.mjs`](../wanx-client/shell/control.mjs) | [`wanx-client/local-ui/remote-preload.cjs`](../wanx-client/local-ui/remote-preload.cjs)、`renderer/renderer.js` | 通过薄适配层投影状态和转发动作；历史 `preload.cjs` 保留但不作为活动 preload。 |
| P2P 平台客户端 | [`wanx-client/platform.mjs`](../wanx-client/platform.mjs) | 本地没有对应实现 | 远端 `createPlatformClient` 是 P2P 连接的唯一候选核心，不能从本地旧链路重新实现。 |
| 网络传输 | [`wanx-client/network/index.mjs`](../wanx-client/network/index.mjs)、`sidecar.mjs`、`tunnel.mjs` | 本地没有对应实现 | 保留远端 sidecar、隧道和 native 资源；UI 只调用上层连接动作。 |
| 账号 | [`wanx-client/account/index.mjs`](../wanx-client/account/index.mjs)、`account/store.mjs` | 本地 `shell/consumer-client.cjs`、账号会话与安全存储 | 远端账号层同时承担 P2P 所需的网络接口；本地登录交互应适配到远端账号状态，不应并行维护两套网络账号会话。 |
| 设备列表 | 远端平台状态由 `client.mjs` 汇总并供 `fleet/app.js` 展示 | 本地 `devices/directory.mjs` 与 controller 记录设备 | 需要一个设备映射层：保留本地展示字段，使用远端设备 ID、授权状态和 P2P ready 状态作为连接依据。 |
| 盒端访问 | 远端 `client.connectBox(deviceId)` 走 P2P；控制层还存在 direct 分支 | 本地 `box-access/*` 支持旧的地址、健康检查和 HTTP 会话 | 本次产品路径只接 `connectBox`；旧 direct/HTTP 代码先保留，暂不接入新的 UI 动作。 |
| Dashboard | 远端 [`wanx-client/shell/dashboard.mjs`](../wanx-client/shell/dashboard.mjs) 创建并管理 Dashboard 窗口 | 合并前本地快照中的 `octop/dashboard.mjs` 与本地入口联动 | 以后统一由远端 P2P gateway 提供可访问地址，再由本地 UI 触发打开；不能让 UI 直接拼接盒端地址。 |
| 设备配网 | 远端分支没有本地 BLE 配网入口 | `shell/setup.mjs`、`shell/provisioning-host.cjs`、`account/pairing.mjs`、`local-ui/renderer/deviceSetupTransport.ts` | 配网作为独立 setup seam 接回；它复用远端账号身份，不创建第二个 P2P client。 |
| 构建与打包 | [`wanx-client/package.json`](../wanx-client/package.json) 的 `main` 为 `shell/main.mjs`，包含 `network/**`、`fleet/**`、`octop/**` 与 native 资源 | 同一入口现在额外包含 `local-ui/**`、BLE/provisioning vendor 包和 renderer bundle | 活动入口仍只有远端 shell；`fleet/**` 继续保留测试用途。 |

## 关键运行链路对比

### 远端已验证链路

```text
fleet/app.js
  -> shell/preload.cjs
  -> shell/control.mjs
  -> client.mjs
  -> platform.mjs
  -> account/index.mjs + network/index.mjs
  -> native wanx-netbird sidecar
  -> octop/gateway.mjs
  -> shell/dashboard.mjs
```

这条链路已经覆盖账号、网络入网、盒子授权、P2P 隧道和 Dashboard 打开。当前只需要把本地产品 UI 放到控制面，不需要重写链路。

### 本地 UI 当前依赖

```text
local-ui/renderer/renderer.js
  -> local-ui/preload.cjs
  -> 历史 wanx-client:action / wanx-client:state IPC
  -> local main.mjs
  -> shell/controller.mjs + shell/real-adapters.mjs
  -> box-access/* / provisioning/* / octop/dashboard.mjs
```

本地 UI 的交互语义包括登录、设备刷新、旧设备连接、健康检查、Dashboard 打开和配网。它不能直接调用远端 `client.mjs`，因为 IPC 名称、状态字段、设备标识和错误码都还没有对齐。

## 结构性结论

1. **远端 P2P 核心应保持为唯一运行时。** `platform.mjs`、`client.mjs`、`network/*`、`octop/*` 和 native sidecar 已组成已验证链路。本地工作不应再引入第二套 P2P 或 tunnel 实现。
2. **本地 UI 与功能核心已经分层。** `local-ui/renderer/` 是活动产品 UI，远端 `shell/main.mjs` 仍是唯一实际入口；`remote-preload.cjs` 只做状态投影和 IPC 转发，不带入旧连接逻辑。
3. **真正的集成点是 adapter seam。** 它需要把远端 client 的状态投影为本地 UI 所需的状态，并把本地“打开盒子”动作收敛为 `connectBox(deviceId)`；UI 不直接接触 account、network、sidecar 或盒端地址。
4. **本地账号和配网能力要保留，但不能与远端 P2P 会话并行。** 登录凭据、安全存储和 BLE 配网可以继续使用本地交互；账号网络请求、设备授权和 P2P 会话最终必须归远端 account/platform client 管理。
5. **102 只能作为设备选择规则，不是新的连接协议。** 后续选择器应基于设备展示名称严格匹配唯一的 `name.endsWith("102")` 候选，再验证授权和 P2P ready，最后调用 `connectBox`。

## 当前接入状态

- **已完成**：本地 renderer 已成为活动 UI；远端 P2P runtime 可连接 102 盒子并打开 Dashboard。
- **本轮已接入**：恢复 `device-discovery-electron`、`local-provisioning-core`、BLE GATT transport、配网 host 和配对 API；配网完成后刷新远端设备目录。配网状态机调用供应包的 `confirmPhysicalDevice`、`provideWifi`、`confirmOwnership` 和 `refreshAuthority` 契约。
- **保持隔离**：配网只负责把新盒子接入账号和目录，不创建第二个 P2P client，也不干预已经打开的 102 Dashboard。
- **当前验证方式**：Node seam 测试覆盖扫描 bridge、配网状态机、账号复用和退出清理；新增接入测试 21/21 通过，真实蓝牙扫描仍需在 macOS/Windows 的 Electron 环境中手工验收。

## Trace bullet 集成计划

### P0 — 结构恢复与基线冻结（本阶段）

- `P0.1` → **恢复并启用本地 UI**：保留 `local-ui/main.mjs`、`local-ui/preload.cjs` 和 `local-ui/renderer/**`，由 `shell/main.mjs` 加载 `renderer/index.html`；`fleet/**` 继续保留测试用途。  
  **产出**：活动控制页切换到本地 UI；**验证**：入口 URL 和 preload 指向 `local-ui`，P2P 核心文件无改动。
- `P0.2` → **冻结远端基线**：记录提交 `19a5409`、远端入口、P2P 模块和 native 资源。  
  **产出**：本结构对比文档；**验证**：`git rev-parse HEAD` 与远端分支一致。
- `P0.3` → **确认测试范围**：后续只增加 seam 测试；远端已有网络测试中的既有失败先记录，不在本阶段修复。  
  **产出**：测试边界；**验证**：不产生任何连接功能 diff。
- `P0.4` → **建立 UI IPC 适配层**：`local-ui/remote-preload.cjs` 将本地 UI 的账号和设备动作转发到远端受保护 IPC，并把远端快照投影为本地 UI 状态；不暴露 direct 连接。  
  **产出**：本地 UI 可显示远端账号、设备和连接状态；**验证**：适配器不调用 `connect` direct 分支。

### P1 — 定义 P2P 前置 seam（只设计，不改功能）

- `P1.1` → **状态契约**：列出本地 UI 需要的 account、network、devices、connection、dashboard 字段，并标注远端 `client.snapshot()` 的来源。  
  **验收**：每个 UI 状态字段都有唯一来源和转换规则。
- `P1.2` → **动作契约**：定义 `login`、`logout`、`refreshDevices`、`connectBox`、`disconnect`、`openDashboard` 的输入、输出、取消和错误码。  
  **约束**：盒端动作只有 P2P `connectBox(deviceId)`，不暴露 direct URL/HTTP。
- `P1.3` → **窗口与生命周期归属**：确认 `shell/main.mjs` 负责 client、sidecar、Dashboard 和退出清理；本地 UI 只负责渲染和发送 IPC。  
  **验收**：没有第二个 client、sidecar 或 Dashboard owner。
- `P1.4` → **设备身份映射**：明确本地展示 `name`、远端 `deviceId`、平台身份和授权状态的映射，禁止用地址代替设备身份。  
  **验收**：102 选择后可得到稳定的远端 `deviceId`。

### P2 — 入口与 UI 接入方案（仍不改 P2P 逻辑）

- `P2.1` → **采用远端 `shell/main.mjs` 为唯一入口**，把本地 renderer 的窗口内容迁移到远端控制窗口或由远端入口加载本地 UI。  
  **验收**：启动脚本、native 资源和 P2P 生命周期保持远端实现。
- `P2.2` → **实现 UI adapter**，只做状态投影与 IPC 适配，不移动 `platform.mjs`、`network/*` 或 `client.mjs` 内部逻辑。  
  **验收**：本地 UI 的登录、列表、连接按钮能映射到远端动作名。
- `P2.3` → **处理 Dashboard 差异**：本地 UI 的打开按钮调用统一的 Dashboard gateway；不让 renderer 直接访问盒端 URL。  
  **验收**：窗口创建、关闭、外链策略由远端 shell 统一管理。
- `P2.4` → **再调整 package/build**：把 UI 文件纳入远端 `electron-builder.files` 和必要的构建脚本，确认不会将测试 `fleet` 误作为产品入口。  
  **验收**：构建产物只包含一个活动入口和一套 native P2P 资源。

### P3 — 账号与本地配网接回（已完成）

- `P3.1` → **账号 UI 适配**：`remote-preload.cjs` 将本地登录交互委托给远端 `account/index.mjs`；配对 API 复用当前账号身份和会话，不保留第二个 P2P session。  
  **验收**：`pairing-seam.test.mjs` 覆盖签名、幂等键、响应元数据校验、401 刷新和退出隔离。
- `P3.2` → **接回 BLE 配网**：`setup.mjs` 组合 discovery picker、GATT transport 和 provisioning host；renderer 通过 `wanxDiscovery` 候选事件选择盒子，再进入身份确认、Wi‑Fi、认领和初始化。  
  **验收**：`setup-preload.test.mjs`、`setup-runtime.test.mjs` 覆盖 bridge、状态机、账号切换和完成后只刷新设备目录。
- `P3.3` → **兼容安全存储**：恢复加密的 `claim-resume-store`，只保存可恢复的配网元数据，不复制账号 token 或本地证明材料。  
  **验收**：退出、账号切换和窗口销毁都会释放配网 host 与 BLE transport。

### P4 — 102 目标选择与 P2P 连接

- `P4.1` → **候选筛选**：从远端设备列表中筛选展示名称严格以 `102` 结尾的设备；候选必须唯一。  
  **验收**：无候选、多候选、名称大小写和空白情况都有明确结果。
- `P4.2` → **连接前置**：确认 account authenticated、network enabled/ready、platform ready、设备授权有效。  
  **验收**：前置不满足时不调用 `connectBox`。
- `P4.3` → **P2P 连接**：只调用 `connectBox(deviceId)`，等待远端 gateway/transport 完成，再打开 Dashboard。  
  **验收**：102 盒子 Dashboard 正常打开；不产生 direct HTTP fallback。
- `P4.4` → **断开与重连**：关闭 Dashboard 或点击断开时，释放 gateway/tunnel，保留账号和网络开关状态。  
  **验收**：重复连接不会产生第二条隧道。

### P5 — seam 测试与验收

- `P5.1` → **只测 seam**：覆盖状态投影、IPC 参数、102 唯一匹配、P2P-only 约束、连接成功/失败和 Dashboard 调用。  
  **命令**：按远端 package 的 Node test 入口运行针对性测试。
- `P5.2` → **原有远端测试基线**：`npm --prefix wanx-client test` 当前有 150 项，其中 149 通过、1 项既有 network shutdown 测试失败；暂不把它混入本次 seam 修复。  
  **记录**：失败项为 `tests/network.test.mjs` 的 stop 写入断言，后续单独处理。
- `P5.3` → **102 手工验收**：登录、打开 P2P、刷新设备列表、选中名称以 102 结尾的盒子、打开 Dashboard、断开。  
  **通过标准**：整条链路使用远端 P2P runtime，Dashboard 可持续使用。

## 在进入 P2P 功能改动前必须确认的决策

1. 远端 `shell/main.mjs` 是否正式作为唯一 Electron 入口；本地 UI 只作为 renderer 接入。
2. 本地账号交互是否全部改为调用远端 account client，哪些本地安全存储字段需要迁移。
3. 本地配网 flow 的生命周期如何挂到远端 shell，而不创建第二个网络 client。
4. 本地 UI 状态字段到远端 `client.snapshot()` 的最终映射表。
5. 102 多候选时是阻止连接并提示选择，还是由业务提供稳定设备 ID；在此决定前不应写死自动选择。

## 当前仍明确不做

- 不修改 `platform.mjs`、`client.mjs`、`network/*`、`octop/*`、native Go sidecar。
- 不修改远端测试 UI 的行为，不把 `fleet/` 直接改成产品页面。
- 不把本地 direct/HTTP 盒端访问接入新的 P2P UI。
- 不重写 `platform.mjs`、`client.mjs` 或 network/native 实现，不删除本地旧模块。
- 不修复远端已有的 network shutdown 测试失败；只记录为基线风险。
