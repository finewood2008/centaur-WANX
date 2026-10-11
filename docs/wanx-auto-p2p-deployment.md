# 万象账号自动入网与盒端免登录：部署和联调

更新日期：2026-10-11。本文按独立 `wanx-bridge` 盒端实现更新。此前已记录 Admin 发布和客户端自动入网成功；这不代表本轮重构后的 bridge 镜像已经发布或盒端免登录已经真实验收。本轮未执行远程部署。

## 1. 部署范围与依赖

整条链路需要同时发布三个部分：

| 位置           | 实现                                                                                   | 必需条件                                                                          |
| -------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 万象连接桌面端 | `wanx-client/account`、`platform.mjs`、内置 P2P 引擎                                   | 公网 Consumer 服务、系统安全存储、已打包的对应平台网络引擎                        |
| Admin 平台     | `network_access_service.py`、`network_access_controller.py`、`wanx_p2p_sso_service.py` | Consumer 身份与请求签名、SQL 迁移、网络管理 Token、平台签名私钥、当前设备证书账本 |
| 盒端 WANX      | 根目录 `wanx-bridge/`，通过公共 HTTP/OIDC 接口连接原始 Octop                           | 盒子身份、盒子 Ed25519 签名私钥、平台公钥、bridge 持久状态、原生管理账号凭据      |

默认公网地址：

- Consumer：`https://boss.nexusaos.qitus.cn/prod-api`，桌面端可通过 `WANX_CONSUMER_URL` 改为另一个受信 HTTPS 部署。
- P2P 管理：`https://p2p.qeeshu.com`，Admin 的 `WANX_NETWORK_MANAGEMENT_URL` 必须与桌面端预期地址一致；当前桌面端会校验服务端返回值等于此默认地址。
- 盒子：可信目录返回 `http://<盒子 P2P IP>:8088`，请求经内置隧道；用户不填写 IP。

不要依赖退役的 `nexusaos-app`，也不要把平台管理 Token、平台签名私钥或设备 RSA 证书私钥放进桌面端。

## 2. 平台数据库与基础授权

在 `nexusaos-admin/admin-backend` 的目标环境按现有迁移流程部署新增 SQL：

1. `sql/20261011_wanx_network_access.sql`：网络注册任务、账号/客户端/peer 映射、可信盒子映射。
2. `sql/20261011_wanx_p2p_sso.sql`：盒端登录 challenge 的持久化一次性消费记录。

同时确认现有 Consumer、Owner/Grant、成员授权、`client_session_version`、Omnia link-key、设备证书 issuer ledger 迁移已经部署。设备公钥证明依赖 `sql/20261003_omnia_device_link_challenges.sql`；不能因新增两张功能表存在，就认为原有鉴权表和证书账本完整。

需要已有、有效的授权事实：

- Consumer 账号和当前 macOS/Windows/Linux 客户端均为 active，登录会话版本匹配。
- 盒子物理设备为 bound，拥有不可变 `identity_device_id`，当前证书及 issuer ledger 记录有效。
- 当前 Owner/成员、设备客户端 Grant 有效，Owner 投影 `access_status=ready`，版本与 `ownership_epoch` 一致。
- 设备 Grant 包含 `remote.p2p`，`omnia-desktop` 应用授权包含 `omnia.use`。

新客户端登录只自动建立 Consumer Grant，尚不会建立 `omnia.use` 应用授权。现有系统需要可信内部操作通过 `PUT /internal/remoteops/application-relay/scope-grants` 为当前 `accountId/clientId/deviceId` 设置 `applicationId=omnia-desktop`、`scopes=["omnia.use"]`、`status=active`，并等待设备 ACK。旧电脑的应用许可不能直接复制给新客户端；所有者默认开通规则需另行明确。

自动入网不会制造 Owner/Grant，也不会把未绑定盒子自动变成当前用户的设备。若上述记录尚不存在，需要先完成现有绑定和授权流程。

## 3. 平台环境配置与密钥

通过部署系统向 Admin 进程注入：

```text
WANX_NETWORK_ENABLED=true
WANX_NETWORK_MANAGEMENT_URL=https://p2p.qeeshu.com
WANX_NETWORK_MANAGEMENT_TOKEN=<管理服务专用 PAT，仅服务端>

OMNIA_PLATFORM_ASSERTIONS_ENABLED=true
OMNIA_NATIVE_SSO_ENABLED=true
OMNIA_PLATFORM_ASSERTION_PRIVATE_KEY_FILE=/run/secrets/wanx-platform-ed25519.pem

REMOTEOPS_CA_CERT_FILE=<当前受信设备 CA PEM 的绝对路径>
REMOTEOPS_CERTIFICATE_ISSUER_ID=<已登记的 issuer ID>
REMOTEOPS_APPROVED_CA_SPKI_SHA256=<已批准且与 issuer ledger 相符的 SPKI SHA-256>
```

平台签名密钥必须为 Ed25519 私钥 PEM，路径为绝对路径、非符号链接，文件属于 Admin 运行用户，权限为 `0600`。只向盒子分发对应的**公钥** PEM。新协议的 JWT `kid` 是 Ed25519 **原始公钥字节**的 SHA-256 十六进制值，不是 PEM 文件的哈希，也不是旧 `OMNIA_PLATFORM_ASSERTION_KEY_ID` 操作员标签。

新签票 issuer 固定为 `nexusaos-platform`。不要因旧部署另有 issuer 标签，就在盒端填入不一致值。平台公钥更换需要配套更新盒端固定公钥；当前实现不是自动 JWKS 轮换。

当管理 Token 存在时，Admin 生命周期会启动网络授权同步任务；关闭 `WANX_NETWORK_ENABLED` 后仍清理已有访问。不要先删除管理 Token 再期待后台完成撤权。

## 4. 网络隔离与可信盒子映射

先核验现有策略。启用的 All-to-All 规则会让注册被拒绝；本实现不会自动覆盖部署中其他策略。客户端使用自己的专属源组，不把所有产品用户加入同一个 owner 组。每个盒子使用仅包含该盒子 peer 的目标组，平台只开放当前授权目标的 TCP `8088`。

由运维通过受信设备登记信息核对真实盒子与管理 peer 的对应关系，不能只凭 hostname 或 IP 判断。随后在配置了目标数据库和管理 Token 的 Admin 环境运行：

```sh
.venv/bin/python scripts/register_wanx_network_box.py \
  --device-id '<Consumer registry device ID>' \
  --peer-id '<确认属于该物理盒子的 peer ID>' \
  --group-id '<只包含该 peer 的组 ID>' \
  --display-name '我的万象盒子'
```

此工具检查物理设备、peer 及组成员，写入 `nexus_network_boxes`，不改变 Owner/Grant。已有不同身份或 peer 映射会被拒绝覆盖。

必须区分两个设备标识：API 路径和 `--device-id` 使用 **Consumer registry ID**；盒端 `WANX_PLATFORM_DEVICE_ID` 和签名票据使用设备证书的不可变 **identity device ID**。二者不可互换。

## 5. 登记盒端 SSO 公钥

盒子 Ed25519 私钥签 challenge；平台需要先可信固定它的公钥。仅完成上节的 peer 映射不够，否则平台会返回 `SSO_LINK_KEY_UNAVAILABLE` 或 `SSO_CHALLENGE_INVALID`。

新增 `nexusaos-admin/admin-backend/scripts/register_wanx_box_sso_key.py` 是盒子侧工具，可单独复制到盒子，在安装了 `httpx`、`cryptography` 的 Python 环境执行。它不访问平台数据库，也不提供跳过设备证明的选项。

准备：

- 已由设备注册流程生成的 DeviceKey，放在仅含该值的私密 UTF-8 文件中。
- 与平台当前有效设备证书对应的 RSA 私钥；不能另生成 RSA 密钥冒充已登记证书。
- 供 WANX 使用的 Ed25519 私钥 PEM。已有公钥登记时必须复用其对应私钥；轮换需增加 generation，并配套更新盒端运行配置。

首次新建盒子 SSO 密钥可在受控的盒子目录使用 `openssl genpkey -algorithm ED25519 -out <box-key.pem>`，随后设置所有权与 `0600`；不要覆盖已有密钥。平台公钥通过受信部署渠道分发，不从一次未验证的 challenge 推断信任。

在盒子上运行下列命令，参数中只放路径，不放密钥内容：

```sh
python3 register_wanx_box_sso_key.py \
  --api-url 'https://boss.nexusaos.qitus.cn/prod-api' \
  --registry-device-id '<Consumer registry device ID>' \
  --device-key-file '<DeviceKey 私密文件>' \
  --certificate-key-file '<当前 RSA 设备证书私钥 PEM>' \
  --box-key-file '<WANX 的 Ed25519 私钥 PEM>' \
  --generation 1
```

私密文件必须为普通文件、非符号链接、无 group/other 权限；非 root 执行者只能读取自己拥有的文件。root 可读取运行用户拥有的私密文件，便于设备证书和 WANX 使用不同运行 UID。

工具按既有协议调用：

1. `POST /prod-api/api/devices/{registryId}/omnia/link-key/challenge`，使用 `Authorization: CentaurOS-DeviceKey …`。
2. 从 Ed25519 私钥导出公钥，使用当前 RSA 证书私钥签名 challenge 与公钥登记正文，调用同路径去掉 `/challenge` 的登记接口。

平台验证 DeviceKey、一次性 challenge、RSA-PSS 签名、当前证书、CA pin 和 issuer ledger，然后写入 `nexus_omnia_link_keys`。任何私钥均不上传。成功输出仅包含 `deviceId`、`keyId`、`generation`，应与盒端实际私钥的公钥指纹一致。相同 key/generation 可以重新证明；更换 key 必须提高 generation。

完整原协议见 Admin 的 `admin-backend/deploy/README-omnia-device-link-key.md`。工具不能弥补尚未完成的设备证书签发、DeviceKey 配发或 Owner/Grant 投影。

## 6. 盒端环境与容器挂载

盒端采用独立进程，不再在 `src/octop` 内增加平台鉴权代码。公开的 P2P 入口和签票兑换属于 bridge；Octop 保持自身账号、OIDC、角色和业务 API。

```text
P2P IP:8088 → wanx-bridge → 127.0.0.1:18088 原始 Octop
                  └───── 127.0.0.1:18089 内部 OIDC provider
```

bridge 先通过原生管理 API 配置专用 OIDC，验证平台票据后在服务端完成标准 OIDC code/PKCE/nonce 流程。账号以稳定 subject 映射到原生 OIDC 用户，角色通过原生用户 API 同步。它不导入 Octop 私有模块、不读写其数据库、不读取或代签其 JWT 密钥。

部署器为同一容器内的两个进程配置：

```text
WANX_PLATFORM_SSO_ENABLED=1
WANX_PLATFORM_DEVICE_ID=<不可变 identity device ID>
WANX_PLATFORM_BOX_KEY_FILE=/run/wanx-platform/box-key.pem
WANX_PLATFORM_PUBLIC_KEY_FILE=/run/wanx-platform/platform-public.pem
WANX_PLATFORM_ISSUER=nexusaos-platform
WANX_BRIDGE_UPSTREAM_URL=http://127.0.0.1:18088
WANX_BRIDGE_BIND_HOST=<盒子的 P2P 监听地址>
WANX_BRIDGE_PORT=8088
WANX_BRIDGE_OIDC_HOST=127.0.0.1
WANX_BRIDGE_OIDC_PORT=18089
WANX_BRIDGE_STATE_DIR=/data/wanx-bridge
WANX_BRIDGE_ADMIN_CREDENTIAL_FILE=/data/.octop/credential.json
OCTOP_BIND_HOST=127.0.0.1
OCTOP_PORT=18088
```

注意盒端启用值是 **`1`**，平台两个 Omnia 开关及网络开关使用 **`true`**。

盒子容器应只读挂载两份文件：

```text
<盒子 Ed25519 私钥路径> → /run/wanx-platform/box-key.pem       readonly
<已确认的平台公钥路径> → /run/wanx-platform/platform-public.pem readonly
```

保持既有 `/var/lib/centuarai/wanx` → `/data` 持久化挂载和 WANX 运行 UID（默认 `10003`）；确保该运行 UID 能读取挂载文件。推荐盒子私钥由 WANX UID 拥有、权限 `0600`；平台公钥可为 `0644`，均不可被 group/other 写入。盒子密钥和平台密钥必须是不同的 Ed25519 身份，私钥使用无密码 PKCS8 PEM。不要把管理 PAT、平台签名私钥或设备 RSA 私钥挂入 WANX 容器。

`credential.json` 是原有初始化入口生成的 `{ "username": "…", "password": "…" }` 私密文件，须属于运行 UID 且权限 `0600`。bridge 仅用它经 HTTP 登录原生管理账号。已有数据库缺少此文件、凭据过期或账号不再是管理员时，需管理员受控补齐；不会重置已有账号，也不会改读数据库恢复密码。bridge 的 SQLite、OIDC 密钥及客户端凭据存放在独立状态目录；需要持久化，不能当作缓存清空。

原来的公开端口由 bridge 独占，Octop 与 OIDC 仅监听 loopback。不要通过反向代理或额外端口映射发布 `18088`、`18089`；同机可信进程仍能访问它们。容器入口监督两个进程，任一个意外退出便停止另一方。健康检查必须访问公开 bridge，初始化完成前不能报告就绪。

OS 的可选部署配置为 `applications.wanx.platform_sso`：

```json
{
  "applications": {
    "wanx": {
      "platform_sso": {
        "enabled": true,
        "device_id": "<不可变 identity device ID>",
        "identity_file": "/var/lib/centauros/device/identity.json",
        "box_key_file": "<盒子 Ed25519 私钥绝对路径>",
        "platform_public_key_file": "<平台公钥绝对路径>",
        "issuer": "nexusaos-platform"
      }
    }
  }
}
```

部署器校验本机 identity、密钥类型和文件访问条件后注入环境及只读挂载；默认不启用。此配置不自动生成或登记公钥，必须先完成第 5 节证明。发布时必须使用包含此可选接线的新 OS 部署器；旧版仅传递 `OCTOP_*` 参数，更新 WANX 镜像自身不会注入 `WANX_PLATFORM_*`。OS 侧详细说明见 `centuarai-os/docs/wanx-platform-sso.md`；更换密钥会改变部署摘要并触发相应容器更新。

启动前还需确认：

- 内部 `18088`、`18089` 没有被占用，公开端口不与其相同。
- Octop 未配置另一个企业 OIDC issuer/client；冲突时返回 `BOX_UPSTREAM_OIDC_CONFLICT` 并停止初始化，不覆盖已有登录系统。
- Octop 登录采用当前支持的原生 `slider` 配置。强验证码供应商要求交互时返回 `BOX_UPSTREAM_CAPTCHA_REQUIRED`，bridge 不自动关闭验证码或绕过它。
- 同机 Zhijun 默认 upstream 自动改为 `http://127.0.0.1:18088`；显式 upstream 原样保留，需部署者核对。公开 bridge 不透传密码登录接口。

首次切换时需要一并重新部署同机 Zhijun：已经运行的旧容器不会因更新 WANX 自动改写自己的 upstream。关闭 bridge 恢复旧监听端口时，也应重新部署或调整 Zhijun。原生管理/初始化脚本如保存过公开地址，同样需改用可信内部入口。

关闭 `platform_sso` 后恢复原始 Octop 单进程，但已经写入 Octop 的 OIDC 配置仍保留。若需移除不可用的登录入口，由管理员通过原生管理界面/API 停用该 provider；关闭部署开关不会暗中清理原有账号、OIDC 配置或 bridge 状态。这与桌面端关闭 P2P 开关是不同操作。

## 7. 实际链路与失败定位

```text
Consumer 登录和请求签名
  → /app-api/network/restore 或 /network/enrollments
  → 内置引擎使用一次性凭据注册
  → 平台核验唯一 peer 并投影当前权限
  → /app-api/network/devices 返回已授权盒子
  → 盒端 /api/auth/platform/challenge
  → 平台 /app-api/devices/{registryId}/wanx/sso-grants
  → bridge /api/auth/platform/exchange
  → bridge 通过原生 OIDC 取得 Octop 会话并私有持有
  → 桌面代理持有短期 bridge 会话，打开原 Dashboard
```

平台注册任务窗口为 5 分钟，底层一次性 key 为 24 小时且 usage limit=1；任务过期由后台另行撤销凭据及 peer。key 过期不等于 peer 已撤权。网络平台租约至多 300 秒，客户端默认约每 60 秒续期；盒端授权票据不超过 60 秒，业务会话租约不超过 120 秒且受平台授权剩余时间进一步约束。

| 现象                                               | 首先核验                                                                      |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `NETWORK_SERVICE_NOT_DEPLOYED` / 网络接口 HTTP 404 | 核验目标 Admin 是否部署新增路由；旧版联调曾遇到 404，后续已记录发布及入网成功 |
| 平台登录成功，网络功能不可用                       | Admin 功能开关、管理 Token、管理 HTTPS 可达性、SQL 迁移                       |
| 注册被拒绝或长期 enrolling                         | All-to-All 等宽泛策略、专属组/凭据使用情况、注册窗口与后台任务                |
| 网络 ready，但“我的盒子”为空                       | Owner/Grant 和应用授权、投影 ready、可信盒子映射及物理身份                    |
| `NETWORK_DEVICE_IDENTITY_INVALID`                  | 当前设备证书、CA/SPKI pin、issuer ledger 及 identity 一致性                   |
| `SSO_LINK_KEY_UNAVAILABLE`                         | 第 5 节是否成功登记盒子公钥                                                   |
| `SSO_CHALLENGE_INVALID`                            | 当前盒子私钥与已登记公钥、registry/identity 区分、时间和票据上下文            |
| 盒端 exchange 拒绝                                 | 盒端开关、平台固定公钥、issuer、目标 identity、票据时效和重放                 |
| bridge 健康检查未就绪                              | 内部端口冲突、原生服务可达性、管理凭据、强验证码或已有 OIDC 冲突              |
| 约两分钟后业务中断                                 | 平台签票续期是否成功、当前权限是否被撤销、时钟与网络可达性                    |

错误检查只记录固定错误码和公开标识，不记录请求 Authorization、setupKey、challengeReceipt、grant 或本地业务 Token。

短租约由盒端 bridge 强制执行，SSE/WS 正常续期不主动断开；原生 Octop 仍检查自身 JWT 有效期。超过原生 JWT 生命周期的 WebSocket 需要按原生行为重连，不能承诺仅靠平台续租无限维持旧 socket。

公开 bridge 限制账号、角色、邀请与密码管理写入，以及 setup、OIDC 配置和 `/api/admin/backup`；相关操作仍可由可信本地管理入口执行。备份中可能含原生 JWT/OIDC 凭据，不对远程会话开放。这不是主机权限沙箱：拥有终端任意执行能力或 root 的本地管理员仍处于受信边界，需要按原有主机权限管理。

## 8. 真实环境验收

使用受控测试账号和真实测试盒子依次执行，记录平台版本、镜像版本、客户端版本与时间。以下步骤需要实际部署和授权数据，离线测试不能替代。

1. **首次登录**：清晰识别测试客户端身份，登录万象后自动入网；不出现独立网络登录、验证码或入网码。平台只出现一个对应 peer。
2. **盒端免登录**：点击平台目录中的盒子直接进入 Dashboard；平台密码不传到盒子，不出现盒端账号登录页。
3. **持续使用**：保持页面超过两个业务租约周期，验证刷新、聊天流、SSE、上传、WebSocket 正常，续期不弹窗。
4. **恢复与重试**：重启桌面端、暂时断网后恢复；复用正确账号和客户端的网络身份，注册重试不产生重复活动节点。
5. **关闭 P2P**：关闭后不因登录而自动开启，本机直连和 `npm run dev:web` 仍可用；再次开启可恢复身份。
6. **账号隔离**：切换账号、不同电脑登录；目录及业务角色来自各自 Owner/Grant，不能凭 IP 或自报角色扩大访问。
7. **撤权**：注销、禁用当前客户端、撤销盒子授权或让授权到期；确认管理端 peer/组/策略已收敛，新票据拒绝，旧请求及长连接在业务租约边界失效。
8. **防重放与跨盒**：重复 exchange 同一票据、把票据发到另一盒子、修改 client/session/role，均应拒绝。
9. **故障恢复**：暂停管理 API 后触发撤权，平台记录 `revocation_pending`；恢复 API 后自动清理并回读验证。单独验证平台签票不可达时不会无限延长盒端业务租约。
10. **跨平台**：macOS 与 Windows 真机分别完成上述基础登录、打开盒子、上传和退出场景。
11. **部署边界**：从另一设备确认原始 Octop 与 OIDC 内部端口不可达；结束任一进程后容器不能继续健康运行；同机 Zhijun 仍能使用自己的账号登录与调用。

管理策略本身没有秒级 TTL：管理 API 故障时，300 秒平台租约不构成网络规则硬过期保证；后台保留撤权任务重试。5 秒后台轮询间隔也不是所有节点的最大传播时限。盒端短租约和请求/长连接校验需要独立验收。

## 9. 当前仍需部署方完成的事项

代码已提供管理适配、盒子 peer 登记、设备证书证明登记 SSO 公钥、可选容器接线与完整登录链路。实际激活仍要求：发布对应版本、应用迁移、注入管理凭据和平台签名材料、使用已登记的真实设备证书完成盒子公钥证明、确认 Owner/Grant 投影，并执行上述真实环境验收。

其中设备身份/证书配发、盒子绑定产生的 Owner/Grant、平台公钥的可信分发属于部署与产品授权底座；本功能没有把这些步骤伪装成“自动完成”，也不会绕过它们放行未知盒子。

独立 bridge 的运行和测试命令见 [`wanx-bridge/README.md`](../wanx-bridge/README.md)。发布时需要包含 bridge 的新镜像及新版部署入口；旧的 `src/octop` 内嵌鉴权镜像不能作为本轮重构的上线验收结果。
