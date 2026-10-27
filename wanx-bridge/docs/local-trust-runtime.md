# 独立设备信任管理服务

本服务实现设备首次认领、申请、独立批准和签名状态读取，监听独立 HTTPS 端口。它使用盒端账本及绑定密钥证明，不依赖云账号、旧 Bridge Bearer、Octop 或管理后台在线。数据切换需要显式安装 required policy、独立 gateway key、原生 gate 与数据配置；仅完成绑定不表示数据入口已经切换。required 模式在同一个 HTTPS runtime 中运行数据网关和唯一 authority。

2026-10-27：required runtime 同时接入 root-only 离线 Wi-Fi broker；这不自动授予任何绑定网络权限。192.168.1.80 仍处于 legacy，本地信任未启用；101 当前源码的 Linux 隔离验证已通过 102 项测试、33 个子测试，无跳过，物理 BLE、NetworkManager 联网、systemd 安装和目标盒子切换尚待验收。详细权限、线协议和发布步骤见 [OS 离线配网文档](../../../centuarai-os/docs/local-trust-offline-wifi.md)。

协议见 [`management-v1.md`](../../contracts/local-trust/management-v1.md)。成功响应是 `application/jose` 原始 compact JWS；错误响应是仅含 `code` 的 JSON，所有响应禁止缓存。桌面必须从受控交付包取得 HTTPS origin、TLS SPKI pin 和 box public key，在主进程校验 pin、响应签名和 checkpoint。不能从首次网络连接、旧 Bearer 或制造证书推导主人资格。

## 受信安装与初始化

推荐 POSIX 主机 systemd 部署。Windows 在具有审查通过的 ACL 和进程锁适配器之前拒绝启动。管理端口直接终止 TLS，不通过旧 Bridge、反向代理或外部 TLS 终止器；服务不信任 Forwarded / X-Forwarded-*。

安装人员先将经审查的 `wanx-bridge/` 发布内容（含 `pyproject.toml`、`uv.lock`、`wanx_bridge/`）放入 root 管理、其他用户不可写的 `/opt/centuarai/wanx-bridge`，同时将匹配版本的 `packages/local-data-gate/` 安装到 `/opt/centuarai/packages/local-data-gate/`（锁文件中的相对来源），该目录也必须由 root 管理、其他用户不可写。使用已验证的依赖制品。以 root 安装锁定版本，避免可编辑源码从工作目录载入：

```sh
uv sync --project /opt/centuarai/wanx-bridge --frozen --no-dev --no-editable
/opt/centuarai/wanx-bridge/.venv/bin/python -I -m wanx_bridge.local_trust_runtime --help
```

OS 离线制备入口必须使用同一个 Python 环境，才能导入同版本 `wanx_bridge.local_authority_store`。将经审查的完整 OS `deployment/` 模块目录放在 root 管理、其他用户不可写的独立发布暂存目录，例如 `/opt/centuarai/releases/<release>/os/deployment/`；不要只复制 `local_trust_provisioning.py`，它需要相邻的 `box_reset.py`、`box_reset_legacy.py`、`box_reset_data_engine.py`、`consumer_authorization.py` 等既有 helper。固定目标 `/opt/centuarai/os/deployment/` 的工作器文件由 create-only 安装器写入，不能先复制同名文件再运行安装器。操作员批准制备、替换实际 release 后，入口为：

```sh
cd /opt/centuarai/releases/<release>/os
/opt/centuarai/wanx-bridge/.venv/bin/python -E -m deployment.local_trust_provisioning < /root/approved-local-trust-provision.json
```

该输入应由 OS 制备流程生成并经操作员审查；服务安装不会生成或执行擦除命令。当前制备仅接受可验证的完整擦除回执，`provision-factory` 在缺少可信工厂清洁数据证据时保持拒绝；存量数据也不能凭旧账号或历史 grant 自动迁移。制备创建 `/var/lib/centauros/local-trust`、账本和 seal，另行输出一次性交付包。交付包只通过受控渠道交给主人，不存入应用目录、工单、日志或环境变量。

完整擦除制备输入的 exact 字段为 `action: "provision-full-erase"`、`deviceId`、`resetId`、`eraseReceiptSha256`、`baseUrl`、按 v1 排序的 `grants`。仅低层 `box_reset.apply` 返回 `erase_complete` 或安装标记返回 `marker_installed` 的隔离阶段接受制备；不能用已经自动完成 identity-only reset 的旧 `box.sh reset` 代替，也不能在 `ready` 已恢复写入后继续制备。输出包固定为 `/var/lib/centauros/local-trust-delivery/first-root.json`。authority、staging 或 delivery 任何遗留状态都会阻止自动重发/重建；业务备份与恢复应排除这三个目录。

运行期只打开已初始化状态，不运行 `initialize_authority`，不创建 box identity，也不重建缺失数据库。目录必须为当前运行 UID 所有且 `0700`，配置、密钥、证书、bundle、DB 与 seal 为 `0600` 普通单链接文件，不允许 symlink。默认制备由 root 执行，示例 unit 因此使用 root，且通过 systemd 限制写入范围；不能把该目录共享给旧 Bridge 或业务容器。

### 显式安装与 v1→v2 迁移

完整 required 安装使用同一受审解释器从上述发布暂存目录执行现有命令：

```sh
/opt/centuarai/wanx-bridge/.venv/bin/python -E -m deployment.local_trust_install --runtime-python /opt/centuarai/wanx-bridge/.venv/bin/python --bind-host <盒子监听IP>
```

安装器先检查业务 writer 持久隔离及 authority 排他锁，对已封存 v1（SQLite `user_version=0`）显式调用 `migrate_authority_v2`，记录 `schema.migrated` 和只前进下限，再调用 `verify_authority_v2` 完整验证。已有 v2（`user_version=2`）只验证，不改变 boot、会话、维护数据或文件 mtime。它拒绝未恢复 WAL/journal、未知版本、损坏或缺失状态；正常 runtime 和应用 OTA 不执行该迁移。迁移不创建 owner、不消费首根秘密、不导入云 grants；unclaimed 状态仍须用户在独立本地 vault 中用原交付秘密及自己的 AccessKey/ApprovalKey 完成首绑。

安装器还创建独立 gateway key、配置、固定 OS 工作器、unit 和 tmpfiles，不启动服务，不恢复旧 writer。旧输出或部分安装残留均拒绝覆盖，不能把它当作可重复覆盖的升级器。已有 protected 主机升级须逐项审查宿主 wheel/文件/unit/tmpfiles 的差异并保留身份、UID、origin/pin 和安全下限；只有应用镜像 OTA 不会更新这些宿主组件。首次配置应使用安装器输出的 `/etc/centuarai/local-trust/runtime/management.json`，无需另建下节的管理模式样本配置。

## 配置与启动

[`management-runtime.example.json`](../deploy/management-runtime.example.json) 是管理配置形状样本。未切换的管理模式使用四个字段；required 模式还必须指定 `dataConfig`：

| 字段 | 要求 |
| --- | --- |
| `schemaVersion` | 整数 `1` |
| `bindHost` | IPv4 / IPv6 字面地址，无 zone ID；选择实际管理网卡或明确的监听地址 |
| `bindPort` | 整数 `1..65535`，与 private bundle 的 HTTPS origin 端口相同 |
| `stateDirectory` | 已制备目录的绝对路径 |
| `dataConfig` | required 模式数据配置的绝对路径；固定 policy 或 authority floor 存在时不可省略 |

示例 unit 清空 capabilities，因此使用 `9443` 等非特权端口；不要直接改为需要特权的 `443`。`private-bundle.json` 中 `baseUrl` 是客户端可达的 HTTPS origin，例如 `https://box.example:9443`，不包含 `/local-trust/v1`、凭据或查询参数。所有请求的 Host 必须匹配该 origin。证书需匹配部署身份、当前有效，密钥及 SPKI 必须与制备材料一致。运行服务不会修改 pin 或证书。

以下样本路径只用于尚未切换数据面的独立管理模式。初始化成功后，将调整好的样本以 create-only 方式保存为 `/var/lib/centauros/local-trust/management-runtime.json`，root 所有、`0600`。不要覆盖已存在配置；先审查现有配置与制备 origin。required 安装使用上一节安装器生成的配置和 unit，不以样本替换它们。将相应 unit 安装到 `/etc/systemd/system/centuarai-local-trust.service` 后显式启动：

```sh
systemctl daemon-reload
systemctl enable --now centuarai-local-trust.service
systemctl status centuarai-local-trust.service
```

unit 不含自动制备或擦除步骤。`ConditionPathExists` 只防止缺少材料时启动，不能替代 runtime 的完整校验。authority 目录必须可写，SQLite 需要写 DB/journal；不能把整个目录挂载成只读。安装后只允许预期管理网络接入该端口。

前台调试入口相同：

```sh
/opt/centuarai/wanx-bridge/.venv/bin/python -I -m wanx_bridge.local_trust_runtime --config /var/lib/centauros/local-trust/management-runtime.json
```

## 运行边界与恢复

每个 authority 目录只允许一个 runtime。进程持有 `management-runtime.lock` 的排他 flock；锁文件保留，不能用删除锁文件的方式启动第二实例。公共操作和证明后管理操作有独立来源预算、容量和 worker 队列；不信任请求头中的源 IP。请求体有大小与读取时限，HTTP 断开不会提前释放仍在执行的账本任务容量。缺少或无效读取证明统一拒绝，不提供公开名册和申请枚举接口。

每次启动生成新的 boot ID，旧未提交挑战和申请作废；已批准绑定与 ACK 保持持久。账本保留可信盒端时钟高水位，重启不能清除回拨保护。运行期不接受客户端时间覆盖盒端时钟。客户端重新启动后先完成带新 nonce 的签名状态读取，再依据 ACK 展示结果；不能仅凭本地缓存判断批准成功。

缺失/损坏账本、seal 或身份材料时服务失败关闭。不要通过删除 DB、复制陈旧备份、重跑制备或手写 seal 恢复。此版本没有可安全降级至旧授权根的回滚步骤；应用升级回退只能选择理解同一账本格式和信任合同的受信版本。保留现场，进入独立审查的恢复或迁移流程，数据 SSO 不能成为绕过途径。

验收使用本地合成身份：`uv run --project wanx-bridge pytest wanx-bridge/tests/test_local_trust_runtime.py`，以及桌面真实 HTTPS 跨端测试。仓库测试通过不代表已经在真实盒子上部署；首次主机安装仍需核对 service 状态、证书有效期、网络可达性、错误 pin 拒绝和重启后绑定持久性。


## Required 数据入口

生产数据 broker 只支持 Linux `SO_PEERCRED`。原生 Octop、Semantica、MCP 与 Clipboard 运行在独立非 root 服务 UID，只有独立 runtime 持有 authority 和 gateway 私钥。业务服务只得到 gateway 公钥、固定 Unix socket 与自己的 `0700` 临时目录。每次原生 HTTP/WS 请求都需要独立 purpose 的 ES256 proof、一次性 broker 准入和实时租约；旧 Bearer、原生 JWT/OIDC、Cookie、query token 不作为备用路径。旧 Bridge 在固定 required policy 存在时拒绝启动。

完整 OS 安装器会在材料均不存在时制备 gateway key，无需重复运行。仅在单独审查的数据入口安装流程中，操作员可在停服并持有既有材料后显式执行一次 gateway key 制备：

```sh
/opt/centuarai/wanx-bridge/.venv/bin/python -I -m wanx_bridge.local_data_install --provision-gateway /var/lib/centauros/local-trust
```

它只创建独立 `gateway-signing-key.pem` 和公共 `gateway-descriptor.json`，不初始化账本、不认领、不批准设备；任何旧文件或部分制备状态都拒绝覆盖。运行入口仍是 `local_trust_runtime --config ...`。OS 安装器使用 root `0700` 的 `/etc/centuarai/local-trust/runtime/` 放置两个 `0600` 配置文件，公共 policy 与 native gate 配置放在上一级 root `0755` 目录。数据配置 exact 形状为：

```json
{
  "schemaVersion": 1,
  "gatewayId": "<gateway-descriptor 中的 gatewayId>",
  "gatewayKeyFile": "/var/lib/centauros/local-trust/gateway-signing-key.pem",
  "brokerSocket": "/run/centuarai-local-trust/native-gate.sock",
  "stagingDirectory": "/var/lib/centauros/local-trust/data-staging",
  "policyFile": "/etc/centuarai/local-trust/required.json",
  "upstreams": {
    "octop": {"origin": "http://127.0.0.1:18088", "uid": 10003},
    "semantica": {"origin": "http://127.0.0.1:8090", "uid": 10004},
    "semantica-mcp": {"origin": "http://127.0.0.1:8091", "uid": 10004},
    "clipboard": {"origin": "http://127.0.0.1:8092", "uid": 10005}
  }
}
```

示例 UID 不能覆盖已安装账户；OS 安装器必须填写实际服务 UID。socket 目录为 root:专用 IPC 组 `0750`，socket 为 `0660`，每个服务只加入该组并按 UID 绑定允许的 audience。容器只挂载公共 native config 与 socket，不能挂载 authority、gateway key 或交付材料。安装器在每个镜像内部执行 `python -m centuarai_local_data_gate.capabilities --require-service octop|semantica|clipboard`，核对实际可导入的 shared/native adapter 版本。required native 健康检查仅为 `GET /__local-trust/health`，不返回旧系统健康数据或身份材料。

安装器应先创建 socket 目录，再启动挂载该目录的原生服务；systemd 使用 `RuntimeDirectoryPreserve=yes` 保留目录 inode，避免重启后容器继续看到旧目录。异常终止遗留的 socket 仅由持有 authority 排他锁的 runtime 恢复：验证 root 所有、单链接、`0660`、正确 IPC 组及文件类型，连接探测明确返回 `ECONNREFUSED` 后再次核对同一 inode 才删除。活监听器、异物或权限不符一律拒绝；通用 broker 不自动清理。冷启动仍需先创建目录并保证 native 服务与 runtime 的正确依赖顺序。

本地 principal 使用独立用户映射；设备分支原为迁移 031，当前合并版本位于 schema 33，不能仅凭数字 31 判断身份表已经存在。旧账号、相同用户名和历史共享 Agent 不会自动成为本地私人资源。当前模型执行仅允许纯文本模型对话与 `current_time` 工具；聊天前置流程同样拒绝平台 slash 命令、附件、临时 MCP/技能/其他 Agent/知识外挂和 HITL 提权，避免工具中间件之前发生宿主访问。后台消息队列只携带不可序列化的进程内租约检查，断开或撤权会停止当前本地任务；宿主终端、桌面、手机控制、宿主浏览器交互、MCP/ACP/任意插件和文件工具不向普通本地数据授权开放。HTTP 私人文件、个人空间、剪贴板和 Semantica 使用各自资源边界；剪贴板子调用在文件事务内验证应用目录，导出只允许批准的固定 ID 和目标。

共享原生 gate 包支持 Python 3.11 及以上；Bridge 和 Octop 保持各自项目声明的 Python 版本。该兼容性已通过独立 Python 3.11 wheel 构建安装及真实 gate/ASGI 签名、租约和暂存测试验证，不能据此跳过服务自身的依赖与集成测试。

## Root-only 离线 Wi-Fi broker

required runtime 使用同一个 authority 和事务锁加载 [LocalWifiAuthority](../wanx_bridge/local_wifi_authority.py) 与 [LocalWifiBroker](../wanx_bridge/local_wifi_broker.py)，没有第二个独立权限库。固定 socket 为 `/run/centuarai-local-trust-network/network.sock`，root:root `0600`，父目录 root:root `0700`；双向校验 Linux `SO_PEERCRED` 的 UID 0。该目录与 native broker 目录分开，禁止挂到应用容器；增加网络权限不会增加原生数据、文件或备份权限。

仅有效 `manage` 绑定、独立 ApprovalKey 和当前 `network:wifi/write` grant 能使用该通道。首次自授权限当前原始主人，或主人主体内明确有 `ownership.transfer` 能力的管理设备；同主体后续委派须已有可委派网络来源且目标已绑定。受限恢复和普通管理角色不能自行开启；成员邀请不得夹带网络 grant。`network-wifi.authorize`/`network-wifi.revoke` 走名册治理及逐笔确认，委派期限和来源链受到当前权限限制。

IPC 固定 POST 路径为 `/v1/wifi/challenge`、`session`、`check`、`consume`、`result`。最大 body/response 各 32 KiB、8 个连接；严格拒绝重复头、Transfer-Encoding、pipelining 和额外字段。authority 不收明文 SSID/密码及其摘要，只有本次 BLE 身份/版本、密文摘要与回执；密码仅从 root GATT 的 AEAD 解密内存经 stdin 交给固定 CLI。

GATT 读取现存持久 `device-key.pem` 的 RSA 公钥，由客户端已固定的 box ES256 challenge 签名绑定其 SPKI 摘要；每次新生成的是 pairingSessionId、nonce 和 32 字节 pairing token，RSA 密钥并非临时生成。此交换不提供前向保密承诺，制造 RSA 身份本身也不授予本地主人资格。

root GATT 还将已签 `security` 传入 local CLI 的必填 `--security open|wpa_personal`。CLI 激活前创建固定安全模式的全新 UUID profile（初始 autoconnect no），WPA 设置 `key-mgmt=wpa-psk`、open 无 security section，读回核对后只激活该 UUID 和网卡；确认活动 UUID/IPv4 才设 autoconnect yes。失败/取消删除仅本次 profile，密码只 stdin，不删除或复用历史同名配置。不能把签名包含 security 等同于已经约束实际 NetworkManager，也不能先按 SSID 连接后才验安全模式。

AccessKey intent 固定当前 BLE challenge 与 RSA SPKI，session receipt 只建立加密通道；每次 apply 必须额外使用 ApprovalKey 签署 sessionDigest、一次性 applyNonce、实际 requestId/counter/密文摘要。consume 在事务内重查 grant、委派链、principal、binding、epoch、boot 与版本，只有新鲜 root IPC 的 `execute=true` 可以启动。精确重试返回 `execute=false`，丢失响应不重新授权，重启不自动执行未完成操作。取消/锁定关闭 BLE 和未提交批准；撤权在 consume 前生效，不能承诺撤回已经开始的物理网络修改。详情及 GATT 分片/AEAD deviceId 映射见 [OS 协议说明](../../../centuarai-os/docs/local-trust-offline-wifi.md#ble-会话与逐笔执行)。

新版 OS 安装器创建独立网络目录的 tmpfiles 规则，authority unit 增加其 `ReadWritePaths`，目录准备服务位于 Docker 和 authority 启动之前。已有 protected 主机必须同步升级这些宿主文件，不能只升级应用镜像或 Bridge wheel。没有目录、错误属主/权限、活 socket 或不可验证的残留状态均应失败关闭；不得通过删除 required policy 回退旧 owner/console Wi-Fi。只有 marker 和 authority 路径均不存在的 legacy 才保留旧流程；任一残留（包括坏 symlink）都不能作为 factory-clean 证明。

## 可选 OS 备份工作器

只有固定 `/etc/centuarai/local-trust/operations.json` 存在时 runtime 才加载受信 OS `deployment.local_trust_operations.create_provider(authority)`，与同一 authority 共享账本。配置或安装模块不安全会阻止启动；未安装时相关操作明确不可用。runtime 校验 `/opt/centuarai/os/deployment` 为 root 所有、无 symlink、非组/其他用户可写的代码树，不从调用方选择模块或路径。

已安装 profile 还须与原生业务 schema 一起升级。`wanx-personal-v1` 只读识别已审设备分支 schema 31 和当前 schema 33 的精确形状，主身份库不进入归档；普通 31/32 或未知变体拒绝。`semantica-private-v1` 精确支持 11/19，恢复仅允许 11→11、11→19、19→19；schema 19 的技能内容属于业务范围，仓库身份/密钥、模型凭据、确认/执行租约、准备与转移记录不恢复。版本号不是放行条件，还须通过完整 schema 指纹、完整性及私域检查。目标使用已经独立建立的当前身份与空私域，业务恢复不得覆盖 authority、seal、首根秘密、名册、恢复材料、批准/撤销与安全下限；其他成员数据保持不变。

`/local-trust/v2/backup-io/` 只有七个固定 POST 操作：`targets.list`、`source.begin`、`source.append`、`source.finalize`、`source.read`、`archive.read`、`transfer.plan`。outer body 为 `{body,proof}`，响应是 `{receipt,contentBase64}`；chunk hash/length/range 由 receipt 绑定。仅 source.append 请求和 archive.read 响应放宽至 1,420,000 bytes，其余 IO 为 32 KiB，普通管理证明限制不变。`/local-trust/v2/operations/restore-key` 单独接收受证明约束的临时归档密钥，不记录请求体、不写入账本。

早期跨平台真实网络测试在 macOS 仅替换 peer UID 查询 seam。2026-10-27 在 101 的 root 临时目录补跑当前源码离线 Wi-Fi Linux 测试：102 passed、33 个子测试、0 skipped，覆盖真实双向 SO_PEERCRED、非 root 对端拒绝、并发唯一消费、丢回执重试、撤权/重放、时钟回拨保护与约 2 秒超时；另含真实 GLib/私有 D-Bus、内核权限和临时 tmpfiles 重建，临时文件已清理。该隔离结果不等于原生服务、systemd 安装、挂载和磁盘故障已在目标盒子验收，也不代表 80 已部署或物理蓝牙/NetworkManager 联网已通过。


`source.finalize` 与 `transfer.plan` 先在短账本事务内验证当前证明，再由共享的单线程、单在途槽执行归档校验或实际 OS 清单检查，最后重新取得盒端当前时间和授权提交。检查期间不持有 authority 执行锁，也不占用管理线程；调用方取消不提前释放仍在运行的检查槽。桌面仅这两个固定检查操作使用 60 秒截止时间，其他操作保持较短时限。

请求预算按实际连接源地址隔离：公共操作每分钟 60 次，管理操作 120 次；匿名 v2 auth challenge 保持每分钟 60 次；持钥 `/local-trust/v2/authenticated-challenge` 与已证明备份 IO 各有独立的每分钟 600 次预算、4 个在途槽和单独工作线程，避免归档分块消耗撤权等管理容量。持钥挑战先校验已登记绑定或恢复材料的签名，随后使用该 actor 独立的 8 个待消费槽；匿名 128 个槽耗尽也不能占用这些保留容量。client nonce 的发行记录保留到有效期结束，已消费证明不能重新发行。未知身份和错误签名统一拒绝，不创建配额；历史身份只能用自己的登记密钥申请 nonce，后续读取、恢复和备份仍检查各自实际权限。 `mutations/authenticated-challenge` 使用独立 purpose 的持钥证明并绑定具体 action，沿用相同验钥实现及独立 actor 配额；旧匿名 mutation 槽耗尽不会阻断已绑定设备的撤权和成员批准。 v2 管理人核对旧格式 use 申请时，也使用该持钥读 nonce；服务先验证其登记管理密钥，才允许旧 read 消费对应 actor 的 nonce。未认领设备、尚未批准的申请人仍使用独立有界的 bootstrap 通道，满额时明确限流。该保证针对协议中的状态分配和工作队列，不代表抵御任意 TLS、CPU 或带宽洪泛。

操作系统固定执行器由 systemd `.path`/oneshot 处理受保护 inbox，HTTP authority 不直接运行任意系统命令。固定入口为：

```sh
/opt/centuarai/wanx-bridge/.venv/bin/python -I -m wanx_bridge.local_trust_operations_loader --run-fixed-executor
```

该入口只导入验证过的 `deployment.local_trust_transfer.run_fixed_executor()`，没有模块、命令或路径参数。实际 root inbox 和执行许可由 OS 部署定义，普通业务服务无法写入。

撤销回执中的数据关闭状态使用当前进程的有界证据：每个原生 gate 周期报告实际未清理操作，临时文件与后台处理结束后才报告关闭；数据网关另外等待真实 HTTP/WS `connection_lost`。独立 runtime 显式安装对应 uvicorn 协议适配器，发送响应完成或 ASGI handler 返回都不能替代连接关闭。安装 OS 工作器时，其完整作业清单也参与关闭判断，runtime 最多保留一份待处理清单；没有 ready 证据、作业尝试或安全版本不符、发布尚未结束时不能显示完全关闭。缺参与者、重启、回报失联、历史溢出或关闭超时均保持 `unknown`，不会凭租约到期显示完全关闭。升级 uvicorn 时必须同时验证这两个真实 TLS 协议测试。
