# 知君桌面端设备发现与配网研究

研究对象：`/Users/lynn/Documents/centaurai/repos/nexusaos-centaurai-wanx-zhijun/zhijun-desktop`。
目标：把它的设备发现、身份确认、配网和认领流程映射到本仓库的 `wanx-client/`。

## 结论

知君的流程不是“扫描到蓝牙名称后直接写 Wi-Fi”。它分成四层：

1. **发现层**：macOS 原生 Swift/CoreBluetooth helper 只扫描固定 service UUID，并读取只读 Device Info characteristic；广告名只是显示提示，不能作为身份或授权依据。
2. **可信传输层**：Electron 主进程持有 provisioning coordinator、平台 consumer、密钥/信任配置和 IPC authority；渲染进程只能选择候选设备、展示状态并提交受校验的 Wi-Fi 字段。
3. **配网/认领状态机**：先读取并校验设备身份，再建立加密 GATT 通道，提交账号证明，写入 Wi-Fi，等待云端确认；操作带 flow/session、租约、超时、取消和恢复语义。
4. **网络恢复层**：设备联网后，使用已认证产品会话调用网络扫描/应用/状态接口；Wi-Fi 写入不自动重试，结果未知时只查询原 job，避免重复写入。

这与 `wanx-client` 现有边界是相容的：`provisioning/` 只编排首次接入，`box-access/` 负责日常盒端访问，平台 token 与盒端 token 分离。当前缺口是没有真实 discovery transport、provisioning coordinator、平台 claim API 和 Electron 主进程 adapter；`wanx-client/main.mjs:257` 仍使用 `createDemoAdapters()`，而 `shell/demo-adapters.mjs:60` 只是延时模拟五个阶段。

本轮已在 `wanx-client/shell/platform-provisioning.mjs` 和
`wanx-client/shell/electron-provisioning.mjs` 落地跨平台边界：`darwin` 与
`win32` 选择各自注入的 native transport，共用 `provisioning/provision.mjs`；缺少
transport 时 fail closed。具体 Swift/WinRT helper 仍需按设备协议接入，不能用一个
平台 helper 冒充另一平台实现。

## 外部实现的具体行为

### 1. BLE 发现和身份读取

`shell/native/zhijun-discovery.swift:4-5` 固定使用 service UUID `f6c7b7a0-...1000` 和 Device Info characteristic `f6c7b7a1-...1000`。扫描允许重复广告，但最多接纳 16 个外设；每次最多并行 2 个 probe，扫描窗口 12 秒，单 probe 5 秒，结束清理窗口 2 秒（`DiscoveryProbeQueue.swift:21-31`）。

广告中的 `LocalName` 只用于展示，代码明确不使用 OS 缓存的 `peripheral.name` 作为盒名（`zhijun-discovery.swift:66-80`）。真正的身份来自 characteristic 的 JSON：数据不超过 512 bytes、`schema_version == 3`、`device_id` 符合 `[A-Za-z0-9._-]{1,36}`；可选 `display_name` 还要过滤控制字符（`zhijun-discovery.swift:223-255`）。只有读成功并且连接已经释放后才发布身份记录，避免把尚未清理的 GATT 连接交给上层（`zhijun-discovery.swift:111-153`）。

Swift helper 通过 stdout 输出逐行 JSON；Node 侧 `discovery-names.cjs:78-179` 严格校验字段、行大小（2 KiB）、记录数（128）和总输出（32 KiB），并把 peripheral UUID 哈希成短期显示用的候选 ID。不同 peripheral 映射到同一候选 ID，或同一候选 ID 出现冲突的 public device identity 时，会阻断并撤销该候选，而不是“选第一个”。

macOS 打包时把 helper 作为独立原生二进制并声明蓝牙权限（`shell/package-mac.cjs:25-27,98-100`）。Electron 主进程在创建窗口后安装 Bluetooth picker、helper 和 diagnostics（`shell/main.cjs:325-363`）；关闭应用时先停止扫描、释放配网连接，再关闭 diagnostics（`shell/main.cjs:433-448`）。

### 2. 配网状态机和 IPC

渲染进程只拿到 `zhijunSetup` bridge：`state/begin/confirmPhysical/wifi/confirmOwnership/refresh/cancel/reset`，以及状态订阅（`shell/preload.cjs:72-92`）。BLE 的 connect/read/request/subscribe/close 通过另一个受限 transport bridge 往返主进程（`preload.cjs:94-107`），主进程负责 coordinator、crypto provider、证书根和 SPKI pin（`shell/provisioning-host.cjs:123-151`）。

候选必须包含 `transport == "ble-gatt"`、`candidateId`、`transportHandle`、`selectionLeaseId`、广告名和时间戳；字段是闭集，RSSI、时间戳和名称都有边界（`provisioning-host.cjs:38-77`）。状态快照只公开有限字段：flow、state、verifiedDeviceId、networkState、pairingSessionId、claimState、错误和受控 identity preview；不会把凭据、证明材料或任意 coordinator 对象送入 renderer（`provisioning-host.cjs:79-119`）。

UI 状态顺序能从 `DeviceSetup.tsx:5-16` 看出：

`connecting → readingDeviceInfo → verifyingLocalDevice → localDeviceVerified → establishingSecureChannel → submittingAppProof → provisioningWifi → waitingCloud → completed`。

Wi-Fi 输入只允许 `open` 或 `wpa_personal`；SSID 为 1–32 UTF-8 bytes，WPA 密码为 8–63 个可打印 ASCII 或 64 位十六进制，隐藏网络用布尔字段表示（`DeviceSetup.tsx:294-321`；主进程网络 host 也重复校验于 `device-network-host.cjs:47-94`）。提交后立即清空密码。配对窗口倒计时来自设备返回的 `pairing_mode_remaining_seconds`（`DeviceSetup.tsx:127-137`）。

关键安全行为是“同一 claim 只观察、不重放”：UI 在 `attentionRequired/suspended` 后定时调用 `refresh()`，注释明确禁止再次调用 `confirmOwnership` 或再次发送 Wi-Fi payload（`DeviceSetup.tsx:149-159`）。关闭/卸载时调用 cancel；晚到的 flow 状态按 flowId 和 revision 丢弃（`DeviceSetup.tsx:161-209,227-263`）。

### 3. 认领、恢复和网络配置

平台 consumer 通过 `/app-api/device-pairing/*` 完成 pairing prepare、attestation、prove、查询和 cancel；设备认领码走 `/app-api/device-console-claims/redeem`，并带 `expectedDeviceId` 和幂等 client attempt（`shell/consumer-client.cjs:269-299,311-375`）。可恢复存储只保存 pairing session、claim 状态等元数据，不保存凭据或本地证明材料（`shell/claim-resume-store.cjs:118-124`）。

联网后的设备网络 host 先绑定当前账号、当前 deviceId 和当前 remote session，并在每个操作前再次 guard；账号变化、设备变化、session generation 变化都会拒绝请求（`shell/device-network-host.cjs:135-222`）。扫描结果最多 128 个网络，安全类型为 `open/wpa_personal/unsupported`，信号是 0–100（`device-network-host.cjs:47-94`）。apply 返回 jobId/state；queued/applying 的 job 保留，网络写入不自动重试，超时后查询原 job（文件顶部注释及 `device-network-host.cjs:135-160`）。

## 与当前 wanx-client 的对应关系

| 知君能力 | 当前模块 | 当前状态 | 应如何接入 |
|---|---|---|---|
| 平台登录/账号 | `account/session.mjs` | 已有独立 session | 接真实 consumer API；不要把平台 token 放入 `box-access/session.mjs` |
| 五阶段编排 | `provisioning/provision.mjs:22-28,136-191` | 已有 discover/identity/network/claim/initialize seam | 将每阶段替换为真实 adapter；保留 stage 错误和 AbortSignal |
| 稳定设备目录 | `devices/directory.mjs`、`shell/controller.mjs:51-79` | 已区分 deviceId、platformOnline、localReachability | 配网完成后写入 `deviceId + baseURL candidate`，再单独做 health/identity probe |
| 地址/健康/身份 | `box-access/address.mjs`、`health.mjs`、`identity.mjs` | 已有 seam 和测试 | 配网结果只能提供候选地址；必须先 `checkHealth` 再 `DeviceIdentityGuard.verify` |
| 日常盒端会话 | `box-access/session.mjs`、`http.mjs`、`socket.mjs` | 已有按 box/user 隔离 | 配网阶段不调用这些业务 transport；配网结束后才建立 Octop session |
| Electron 主进程 | `wanx-client/main.mjs` | 目前是 demo adapters | 新增 `shell/electron-provisioning.mjs`，由 main 组装真实 discovery/native helper、IPC 和平台 API |
| renderer UI | `wanx-client/renderer` | 只有通用 provisioning action | 可借鉴 DeviceSetup 的状态展示，但不要把 GATT handle、证明、Wi-Fi 密码放入 renderer state |

## 在 wanx-client 中的落地方案

### 阶段 A：先固定 adapter 契约

保留现有 `createProvisioning()`，把 `discovery` 拆成以下真实接口：

```js
{
  discover({ signal }),
  readIdentity(candidate, { signal }),
  configureNetwork({ identity, candidate, input }, { signal }),
  initialize({ identity, deviceId, network, claim, input }, { signal })
}
platform: { claim({ identity, deviceId, network, input }, { signal }) }
```

`discover()` 返回经过主进程验证的候选，而不是 peripheral 原始对象；`readIdentity()` 返回 `deviceId/schema/fingerprint/displayName`；`configureNetwork()` 返回 `baseURL` 或网络 job 引用；`claim()` 必须幂等并绑定 expected deviceId；`initialize()` 只返回可持久化的设备状态。

### 阶段 B：实现 Electron 主进程 adapter

在 `wanx-client/shell/` 增加主进程实现，职责顺序如下：

1. macOS 使用独立 Swift helper；Windows/Linux 使用各自原生 BLE adapter，统一输出候选 seam。不要在 renderer 直接调用 Web Bluetooth 作为正式方案。
2. 主进程维护 `flowId/generation/AbortController`、候选选择租约和 pending RPC；renderer 仅通过 preload 暴露固定方法。
3. 主进程持有 coordinator/crypto/trust roots、平台 consumer 和安全存储；任何 late response 必须按 requestId + generation 丢弃。
4. 用 `structuredClone` 投影有限状态；禁止把 token、Wi-Fi 密码、private key、GATT handle 送到 UI。
5. 配网写入不自动重试；遇到超时或断线调用 `refresh/status` 查询同一 flow/job。

### 阶段 C：接入主流程和目录

把 `main.mjs:258` 的 `createDemoAdapters()` 改为按运行模式选择 `createRealAdapters()`；真实实现完成前保留 demo 模式用于 seam 测试。`controller.startProvisioning()` 已经会在成功后写入 ready 设备，但应补充：

- 持久化 `deviceId` 与地址候选，地址变化时强制重新身份验证；
- 把 `initialized/authorized/platformOnline/localReachability` 分开，不能以“平台在线”代替本地可达；
- 配网成功后先健康检查和设备身份校验，再允许 `connectDevice()`；
- logout、切换设备、窗口销毁时取消 BLE、HTTP、SSE 和 WebSocket。

### 阶段 D：网络恢复和日常访问

把知君的 network host 作为 `provisioning` 的后续诊断能力，而不是加入 `box-access/http.mjs` 的通用代理。scan/apply/status 应以 deviceId + 当前远程 session 绑定，job 状态持久化有限条数；写入结果未知时只查询，不重新提交 Wi-Fi。网络恢复后更新地址候选并重新跑 health → identity → Octop session。

## 不应直接照搬的部分

- 不要复制知君完整 `remote-client.cjs`、Consumer SDK 或平台私有 API 到 `src/octop/`；它们属于客户端 adapter。
- 不要把 BLE discovery 当作盒端 HTTP API；配网只产生设备身份、网络结果和地址，日常业务仍走 `box-access/` 直连盒端公开 API。
- 不要用广告名、peripheral UUID 或健康检查结果作为设备归属；稳定主键应是平台 `device_id`，身份材料必须再次验证。
- 不要把 `confirmOwnership`/Wi-Fi payload 放进可重试的通用请求队列；claim 和网络写入都需要幂等键或只读恢复。

## 验证清单

当前基线：`cd wanx-client && npm test` 已通过 56 个测试。

接入真实 adapter 后至少增加以下 seam 测试：

- 扫描候选字段闭集、设备身份 schema/fingerprint 不匹配拒绝、重复/冲突候选撤销；
- 两个并发 probe、超时、取消、晚到回调和 helper 清理；
- flow/session/generation 隔离，窗口关闭后 late response 不改变状态；
- Wi-Fi 输入边界、密码清理、claim 与 apply 不重复写入；
- 设备目录的 platform online、local reachability、initialized、authorized 四态互不混淆；
- 地址变更后重新 health + identity，旧盒端 token 不发送到新地址；
- `make all`（仓库 ship bar）以及 `wanx-client/npm test`。

## 尚需向平台/设备协议确认的字段

外部代码已经暴露了流程形状，但没有在本仓库定义 WANX 的正式协议：service/characteristic UUID、Device Info schema v3、pairing API 返回字段、attestation/claim 服务器地址、证书根/SPKI pin、BLE 的 Windows/Linux 实现、盒端返回 `baseURL` 的来源，以及平台设备目录的 address freshness/多地址优先级。这些必须作为真实 adapter 的契约输入确认，不能从 demo 或 `zhijun-desktop` 的私有 endpoint 名称推断为 WANX 公共协议。

