# 已关联盒子的 P2P 接入与联调

本轮从“万象账号已经关联盒子”开始，只处理盒子网络映射、当前客户端访问授权、P2P 连接和免登录打开。发现设备、配置家庭网络、认领盒子由另一条产品流程负责，不能在这里重新创建绑定或更换所有者。

## 输入与边界

已有流程需要提供账号关联、Consumer registry device ID、可信物理身份 identity device ID。三个概念不能用显示名称、主机名或 IP 相互替代。

盒端需要已运行现有 OS P2P 网络服务，并接入 `https://p2p.qeeshu.com`。如果盒子仅完成 Wi-Fi 配置而尚未加入 P2P 网络，仍须通过已有 OS 网络服务完成入网；这不是重新发现或认领设备。

当前版本支持客户端自动入网、按既有账号权限创建访问策略。**盒子身份与管理端 peer 的对应关系仍需运维一次性登记**。没有设备自主申请 setup key 并证明 peer 归属的新协议，也不会按相同主机名或相似 IP 自动认领 peer。

## 一次性登记已在线盒子

先通过受信的盒端运维渠道核实这台物理盒子的 registry ID、现有 identity 和管理端 peer ID。脚本验证 peer 存在及分组内容，但不能代替这一步身份核实；在后台搜索到一个同名节点不构成证明。

在已配置数据库连接与管理令牌的 Admin `admin-backend` 环境中运行：

```bash
python scripts/register_wanx_network_box.py \
  --registry-device-id '<已有 registry device ID>' \
  --peer-id '<已核实属于该盒子的 peer ID>' \
  --display-name '我的万象盒子'
```

`--device-id` 是 `--registry-device-id` 的兼容别名。管理令牌沿用 Admin 服务端的 `WANX_NETWORK_MANAGEMENT_TOKEN`，不应放进客户端或命令行参数。

未传 `--group-id` 时，脚本创建或复用 `wanx-box-<registry device ID>` 专属组，仅允许一个指定 peer。如果已有映射，则优先验证映射中保存的组。原来显式指定 `--group-id` 的调用继续可用，但该组必须已经只含这一个 peer，且不能是 `All`、owner 共享组或客户端组。

脚本不改现有组成员、不改 owner 共享组、不改 `All` 或其他网络策略。重复执行保持映射；创建组成功但响应丢失时，下一次按确定名称恢复。重复组名、其他 peer、资源组、已被其他 registry 占用的 peer/group、既有 identity 变化均明确失败，需要运维核实，不能通过覆盖旧映射解决。

## 客户端与 Admin 协议

以下路径均相对于已有 Consumer API 基址，沿用当前账号及客户端签名认证。

| 接口 | 用途 | 边界 |
| --- | --- | --- |
| `GET /app-api/network/boxes` | 获取账号已关联的盒子和接入状态 | 不等待 P2P 就绪，不创建授权，不返回未获网络权限的服务地址 |
| `POST /app-api/network/boxes/prepare`，请求体 `{}` | 为本人已有关联盒子准备当前客户端所缺少的默认访问权限 | 只补缺失项，遵守已有授权限制与设备确认流程 |
| `GET /app-api/network/devices` | 获取当前已获授权的可连接网络目标 | 核验设备映射与当前权限；实际打开另需有效网络会话 |
| `POST /app-api/devices/{deviceId}/wanx/sso-grants` | 为选定盒子换取短期打开凭证 | 需要盒子 challenge、网络会话及既有可信签名链 |

账号盒子列表使用 `{boxes: [{deviceId, displayName, deviceRole, accessState}]}`。`deviceId` 是 registry ID；列表中的就绪状态是平台授权准备状态，不能替代盒子在线与服务探测。

Owner 默认权限补齐仅针对当前账号本人拥有的盒子和当前客户端：基础 `remote.p2p` 与万象应用 `omnia.use`。已被撤销、过期、限制或分享成员的权限不能自动扩大。新权限必须进入已有授权快照下发及盒端 ACK 流程，收到有效设备确认前仍是授权同步中；不能将“服务端已写入”当成“设备已确认”。

常见状态：`network_unconfigured` 表示网络映射尚未登记；`authorization_pending` 表示当前客户端权限或盒端确认未完成；`access_denied` 表示现有权限不允许访问；`identity_unavailable` 表示设备身份不可用；`authorization_unavailable` 表示该盒子需更新授权同步组件，其他支持的盒子可以继续准备。客户端应分别展示这些原因，避免把有盒子但尚未就绪显示为“暂无盒子”。

网络租约就绪后，Admin 只把授权盒子专属组加入当前客户端的 TCP `8088` 单向访问策略。不得用放开 `All` 来绕过列表、授权或连接失败。

## 联调顺序与验收

1. 发布包含新接口的 Admin，确认现有管理令牌有效且网络功能开启。
2. 核对目标盒子已绑定的 registry/identity，以及盒端 P2P 管理连接与真实 peer。未入网时先完成现有 OS 网络服务入网。
3. 执行一次性映射登记。重跑应成功且不新增组，不改变同机其他设备的策略。
4. 启动最新版“万象连接”并登录。P2P 关闭或连接中也能看到已关联盒子，缺失映射显示明确状态。
5. 开启 P2P。Owner 默认权限准备后，等待既有设备授权 ACK；客户端网络进入就绪，授权盒子出现可打开状态。
6. 部署包含独立 `wanx-bridge/` 的 WANX 镜像，启用盒子平台 SSO，并按现有证书证明登记盒子 SSO 公钥。点击打开应直接进入 Dashboard，不再次输入盒子账号密码。
7. 持续使用至少五分钟，验证聊天流、文件上传/下载、刷新及适用的长连接；关闭 P2P 应停止远程使用，原 Web 开发模式仍可用。
8. 用无权限账号或已撤权客户端检查拒绝访问；权限撤销后不应被默认权限补齐重新激活。网络端策略撤除与 bridge 短期凭证过期应符合既有租约时限。

测试分工：Admin 自动化覆盖真实 SQL 的权限/映射、管理 API 请求结构、幂等恢复和拒绝分支；客户端测试覆盖已关联列表、准备授权和 P2P 状态；实际盒子联调再验证隧道与 bridge 全链路。Mock 管理端测试不能证明生产 peer 在线或 `.102` 已可访问。

### 本轮验证记录（2026-10-11）

- Admin：网络访问、已关联盒子权限准备、节点登记和万象 SSO 共 118 项通过；现有账号认证、会话撤销、应用授权与原生 SSO 回归 166 项通过。其中授权准备使用真实 SQL 投影与设备 ACK，覆盖旧盒与正常盒同时存在的情况。
- 客户端：133 项测试通过，覆盖 P2P 关闭、慢连接、权限同步、撤权、账号切换及旧盒兼容提示。
- WANX：`make all PYTEST_JOBS=4` 通过，4421 项通过、17 项跳过；`src/octop` 无修改。
- macOS arm64：Electron 目录打包通过，本地验证包未签名。

代码与本地验证已完成；部署、可信节点登记和实机全链路验收仍待执行。

### 列表为空与网络异常排查

- 客户端主进程不会因源文件更新而自动重新加载。更新后需退出并重启“万象连接”；只刷新窗口不足以更新网络逻辑。
- `NETWORK_SERVICE_NOT_DEPLOYED`：检查线上是否包含 `GET /app-api/network/boxes` 与 `POST /app-api/network/boxes/prepare`。兼容客户端会用已有 `/app-api/devices` 显示关联目录，标记“账号服务待更新”，不会据此授予网络权限或开放盒子。
- `revocation_pending`：上一条客户端网络会话尚未清理完成。客户端应显示清理中，不能将它误报成响应格式错误，也不能跳过清理创建新连接。后台任务会重试清理；确认 `revoked` 后才可重新注册。
- 持续清理失败时，在 Admin 日志查找 `wanx_network_management_failure`。日志只含操作、资源类型、HTTP 状态或错误类别，不包含令牌、设备标识、请求或响应正文。例如 `status=401/403` 需核对管理令牌及权限；`error=timeout/transport` 需核对 Admin 到网络管理服务的连通性；其他 HTTP 错误按具体操作排查。删除一个已不存在的资源（404）不算失败。

2026-10-11 实际客户端检查确认旧目录可返回关联盒子，新网络目录接口尚未部署，网络恢复接口返回 `revocation_pending`；以上两类问题需分别处理，不能将网络未就绪当成账号无设备。

本次故障修复验证：客户端 142 项、Admin 网络相关 126 项通过；`make all PYTEST_JOBS=4` 再次通过（4421 通过、17 跳过）。实际窗口已显示 8 个关联盒子，均标记服务待更新且禁止打开。macOS arm64 使用本机同版本 Electron 37.10.3 完成未签名目录打包。服务端新接口发布和旧会话清理仍未完成验证。

## 102 盒端部署记录（2026-10-11）

已使用 `centuarai-os/scripts/box.sh` 完成 **101 构建 → 上传 MinIO → 102 下载部署**，版本 `wanx-102-p2p-20261011-02`。配置位于 OS 仓库私有文件 `.private/fleet-102-wanx.json`，builder 为 `192.168.0.101`，唯一 target 为 `192.168.0.102`；只选择 `wanx` 及 `base/docker` 依赖，没有重新配置 P2P。

```sh
./scripts/box.sh release --config .private/fleet-102-wanx.json --module wanx --target 192.168.0.102 --version wanx-102-p2p-20261011-02
# 同一已发布制品的部署重试：
./scripts/box.sh deploy --config .private/fleet-102-wanx.json --module wanx --target 192.168.0.102 --release wanx-102-p2p-20261011-02
```

最终部署回执 `.private/results/20261011T055328Z-65ea2c.json` 返回 `result=ok`。容器 `centuarai-wanx` 为 healthy，重启策略 `unless-stopped`；镜像 ID 为 `sha256:37951f76d9f43682a5c30a9ca5c8b52d4d755ca1565530e12b39441fb33a45f5`。在盒端验证 `http://100.120.69.169:8088/` 返回 HTML 200，`/api/health` 返回 200、`ok=true`、`db=true`。监听仅位于该 P2P 地址的 8088，镜像中可导入 `wanx_bridge`。

旧 `/var/lib/centauros/omnia` 数据库版本号为 21，但缺少当前迁移预期的 `agents.application_id`；直接导入会启动失败，部署器已移除失败容器。原始目录保持不动，导入副本保存在 `/var/lib/centuarai/wanx-legacy-import-20261011`。当前 `/var/lib/centuarai/wanx` 是新初始化的独立万象数据，**旧账号和历史数据尚未迁移到新服务**。原生管理凭据由入口生成，保存在盒端 `/var/lib/centuarai/wanx/.octop/credential.json`，不写入发布文档或日志。

当前 `WANX_PLATFORM_SSO_ENABLED=0`：只完成包含 bridge 的镜像部署，未启用平台免登录。部署当时 Admin 新接口仍为 404；后续发布、网络清理修复和映射登记的结果见下节。仍需核实或更新盒端 SSO 公钥登记（现存签名私钥与历史登记指纹不一致）、设备授权确认与真实跨端验收。未更改历史 SSO 登记，也未宣称免登录全链路成功。

构建中修复 OS 部署器遗漏 `wanx-bridge` 上下文、Buildx 客户端未继承构建代理两个问题，相关 96 项测试通过。构建下载所用的临时 Docker daemon 代理配置已从 101 和 102 移除。

部署与 SSO 参数见 [自动入网部署文档](wanx-auto-p2p-deployment.md) 和 `centuarai-os/docs/wanx-platform-sso.md`。

## Admin 更新后的实机复验（2026-10-11）

本次使用已登录的真实桌面客户端、Admin 部署环境和 102 的 SSH 运维渠道复验，结果如下：

- 新目录及准备接口已生效，8 台关联盒子正常显示，目录状态 `ready`。
- 原客户端会话持续 `revocation_pending` 的根因是管理 API 对空组返回 `peers: null, peers_count: 0`，原 `peer_ids()` 仅接受数组。现场旧 peer 和策略已删除、setup key 已撤销，但空组校验阻止最终清理。
- Admin 修复仅在 `peers` 明确为 `null` 且 `peers_count` 为严格整数 `0` 时认可空组；缺失、类型异常或非零计数仍拒绝。相关 141 项测试通过，包含真实 SQL 与模拟 HTTP 的完整撤销和部分清理重试回归。
- 已备份并更新服务器 `module_nexus/service/network_management_client.py`，通过现有 `scripts/run.sh restart` 重启。备份为同目录 `network_management_client.py.before-empty-group-20261011`。旧会话正常变为 `revoked`，重新入网后桌面 `platform.phase` 和 `network.phase` 均为 `ready`。本地修复尚未提交，后续正式发布需包含该修复，避免覆盖回旧版本。
- 已通过 102 受信 SSH 核对设备身份和本机 P2P 地址，并与管理 API 中唯一在线节点对应；使用 Admin 自带登记脚本建立映射：registry/identity `centauros-87dbbea31110a0bbf0000fe1` → peer `db5f1m3h01qc73ck2rv0` → `100.120.69.169`。脚本创建专属组，没有扩大其他分组或策略。
- 102 容器仍为 healthy，盒端无代理访问 `/api/health` 返回 HTTP 200、`ok=true`、`db=true`。映射后盒子状态已从 `network_unconfigured` 变为 `authorization_pending`，`canOpen=false`。

### 尚未通过的验收

1. **设备授权回执（后续已完成，见下节）**：当时 102 的 `centauros-cloud-agent.service` 和 `centauros-remote-agent.service` 均 masked/inactive，旧 Cloud Agent 程序也已移除，缺少替代同步组件。后续已通过独立组件恢复真实快照接收与 ACK，没有恢复包含配对/认领逻辑的旧 Agent。
2. **平台免登录**：Admin 当前仍登记 102 的第一代公钥，指纹 `8358d59a35c5df82e07f0afc2abd78d6452cf8e045f0189da2f05ec4aa08fbd5`，与现存候选私钥不匹配。须找回对应私钥，或经确认更新登记后再启用 bridge；本次未轮换密钥，SSO 仍关闭。
3. **端到端体验**：尚未完成桌面通过 P2P 打开 102、免二次登录、聊天/上传/长连接和撤权验收。客户端入网就绪与盒端本地健康检查不能代替这些验收。

## 102 独立授权同步部署及按钮复验（2026-10-11）

已在 OS 新增独立 `centuaros-consumer-authorization.service`，仅处理 Consumer v2 授权，不处理发现、配网、配对或认领。组件使用已有 DeviceKey，经 HTTPS 获取快照，严格核验设备/版本/摘要/ETag/请求关联，事务持久化并发送真实 ACK，支持冲突重取、失败重试、进程恢复及 304 续活。默认关闭，通过 `settings.consumer_authorization.enabled` 显式启用。

相关 187 项测试通过（运行时 33、部署新增 9、既有 system 21、fleet 124）；`git diff --check` 通过。`src/octop` 未为本功能修改。

发布严格使用 `centuarai-os/scripts/box.sh` 的 **101 构建 → MinIO → 102 部署**：

```bash
./scripts/box.sh release --config .private/fleet-102-authorization.json \
  --module base --target 192.168.0.102 --version wanx-auth-sync-20261011-01
```

部署回执 `.private/results/20261011T062402Z-b0329d.json` 返回 `result=ok`，基础制品 SHA256 为 `baa3384010b62f74a967c40d533b0f9fff31ec702b21de87c5ead7fdad5959f9`。未重建 WANX 镜像，未更改其他盒子，也未启用旧 Agent。

实机证据：

- 独立服务 `active`；授权版本 `295`，平台 ACK 已接受，本地状态 `ready`，无待发送 ACK，持续更新 liveness。
- 桌面账号目录、平台网络和 P2P 均 `ready`；102 的 `accessState=ready`、`canOpen=true`。
- 实际 DOM 按钮为“打开盒子”，`disabled=false`。其余未登记网络映射的盒子仍保持不可打开。
- 从客户端调用打开后，102 容器日志记录 `POST /api/auth/platform/challenge` 返回 **401**，证明请求已通过客户端内置 P2P 隧道到达盒端；当前 WANX 仍未启用 bridge，客户端报 `BOX_PLATFORM_AUTH_FAILED`。不能将操作系统直连 `curl` 的结果用来判断内置用户态隧道是否可达。

**当时的剩余阻塞为免登录接线**：需要找回旧私钥或经确认更新 102 公钥登记，再启用已有 bridge 并重新部署 WANX。后续用户已允许更新登记，执行结果见下节。授权同步部署参数见 OS 的 `docs/consumer-authorization-sync.md`。

## 102 公钥轮换与免登录启用（2026-10-11）

用户明确允许更新 102 的免登录公钥登记后，已在盒端生成独立 Ed25519 密钥，私钥保存在 `/etc/centauros/wanx/box-sso-key.pem`，属主 `10003:10003`、权限 `0600`，从未传出盒子。通过 Admin 的 `register_wanx_box_sso_key.py` 使用既有 DeviceKey 和 RSA 设备证书证明登记，未直接改数据库、未改变设备归属。

第二代公钥登记成功：`generation=2`，`keyId=01f40259d6d60f412e57c1c3316ed17be11bbe366c5d5e9d19d2025872a047f1`。盒端 `/etc/centauros/omnia/platform-public.pem` 的原始公钥 SHA256 为 `7b603afe67b0990e4f85ea616243432e88033c24358584594818b7710f0ebbb0`，已与运行中 Admin 的签票公钥核对一致。临时注册脚本及依赖环境已清理。

使用 `box.sh` 启用 bridge，复用此前在 101 构建并上传 MinIO 的制品：WANX/Docker 使用 `wanx-102-p2p-20261011-02`，base 保留 `wanx-auth-sync-20261011-01`，没有将授权同步服务回退到旧 base。组合清单为本地私有部署清单，引用已有 MinIO 制品；不是重新构建的万象版本或新发布的 MinIO 清单。

```bash
./scripts/box.sh deploy --config .private/fleet-102-sso.json \
  --module wanx --target 192.168.0.102 \
  --release .private/wanx-102-sso-manifest.json
```

回执 `.private/results/20261011T062946Z-40e7fa.json` 返回 `result=ok`，部署标识 `wanx-102-sso-20261011-01`。base 与 Docker 未替换；WANX 使用同一已发布镜像，`platform_sso.enabled=true`、`runtime_ready=true`。旧容器保留为 `centuarai-wanx-history-1cd736ec0381`，持久数据未删除。

实机初步验收通过：

- bridge `100.120.69.169:8088/api/health` 返回 HTTP 200、`ok=true`、`db=true`。
- 原生 `18088` 与内部 OIDC `18089` 只监听 `127.0.0.1`；P2P 对外入口仍为 `8088`。
- 真实已登录客户端调用 `connectBox(102)` 成功，客户端和 P2P 均 `ready`。
- 自动打开万象页面容器，`/api/auth/me` 返回 200，Owner 映射为 `admin`，无需输入盒子密码；页面刷新后仍保持登录。当时未检查业务页面内容，不能据此认定首页已完整加载（后续启动问题见下节）。
- 连续 70 秒的三次页面探测均返回 `/api/auth/me` 200，无密码输入框；bridge 只读状态确认有有效租约和两枚未到期短期令牌，当前租约剩余 113 秒，覆盖至少一次自动签票续期。

上述证据证明自动入网、授权同步和免二次登录认证链路已连通。聊天生成、文件上传/下载、长期 SSE/WebSocket 与实际撤权演练仍需单独验收，不能据此宣称这些业务场景全部通过。

## 页面启动错误修复（2026-10-11）

用户随后反馈页面显示“无法连接半人马AI-万象服务”。实际抓取初始化请求发现：前端 AuthGuard 先读取 `GET /api/setup/status`，bridge 原来拒绝整个 `/api/setup` 路径，返回 403；AuthGuard 把这个失败显示成离线。`/api/auth/me` 为 200 与免登录认证成功，均不能证明页面完整启动。

修复只在 `wanx-bridge/wanx_bridge/server.py` 精确允许已认证的 `GET /api/setup/status`，仍验证当前平台会话；匿名、过期会话、其他 setup 路径及初始化写操作保持拒绝。没有修改 dashboard 或 `src/octop`。新增回归覆盖启动读取顺序及拒绝分支，bridge 全部 98 项测试通过。
