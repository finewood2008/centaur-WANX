# 万象项目结构与盒端接入规划（最终版）

本版确定产品与目录边界；“当前结构”描述已有代码，“目标结构”描述拟新增模块，不代表已经实现。第一阶段交付局域网访问，后续集成组网。

万象运行在 Ubuntu 主机盒子上。用户使用统一的桌面客户端注册平台账号、首次发现盒子、完成配网和初始化。初始化完成后，客户端从用户的设备列表中选择盒子，通过当前 Host URL 直连盒端 Octop。用户既可以使用原生 Dashboard，也可以使用直接调用盒端公开 API 的定制专家 UI。

本规划的核心约束是：

- 不新增独立的连接 SDK；
- 不自研组网协议；后续由集成的组网工具提供 IP 可达能力；
- 局域网和后续组网统一通过盒子 IP 直连；
- 不新增盒端连接网关、逐接口代理或新的应用层桥接；
- Octop 的 Dashboard、HTTP API、WebSocket 和业务逻辑保持不变；
- 平台账号、设备管理和首次配网放在 Octop 之外，减少对官方代码的侵入，便于跟随社区版本升级。

## 1 当前项目结构

### 1.1 `centaur-WANX`

```text
centaur-WANX/
├── src/octop/                         Octop Python 后端、CLI 和运行时
│   ├── api/                           FastAPI 路由
│   ├── cli/                           官方 CLI
│   └── infra/                         领域服务、数据库、用户和初始化能力
│
├── dashboard/                         顶层 React/TypeScript Dashboard 源码
│   ├── src/pages/Boxes/                现有盒子页面
│   ├── src/utils/boxConnection.ts     现有盒子连接工具
│   └── vendor/                         客户端 SDK 交付包
│
├── sdk-box-management/                平台设备管理 SDK 宿主
│   ├── host.mjs
│   ├── worker.mjs
│   ├── build.mjs
│   ├── vendor/
│   └── tests/
│
├── wanx-desktop/                      旧 Electron 用户端，保持原样
├── wanx-admin-desktop/                旧管理员桌面原型，保持原样
├── desktop/                           Wails 壳和便携包链路
├── fnos/                              飞牛 fnOS 安装包
├── scripts/fnos/                      飞牛专用脚本
├── docs/                              项目文档
└── tests/                             后端和集成测试
```

`dashboard/` 是 Dashboard 的前端源码目录，构建产物进入 `src/octop/dashboard/`。`src/octop/dashboard/` 不作为源码编辑目录。

`sdk-box-management/` 是已有的平台设备管理 SDK 宿主，负责平台侧设备管理能力。它不是盒端连接 SDK，本规划不把它扩展成连接层。

`fnos/` 和 `scripts/fnos/` 只服务飞牛 fnOS。Ubuntu 盒端的系统服务、设备身份、配网和网络配置由 `nexusaos-centuarai-os` 负责，不放入 fnOS 目录。

### 1.2 参考工程 `nexusaos-app`

```text
nexusaos-app/
└── src/
    ├── consumer/                      平台账号、客户端身份、设备目录
    ├── ble/                           首次发现和设备身份读取
    ├── provisioning/                  配网、认领、初始化
    ├── softap/                        配网备用能力
    └── remoteops/                     既有远程操作代码
```

`nexusaos-app` 只作为设备发现、BLE、认领和配网协议的参考实现。当前产品使用桌面客户端，不继续把移动 App 作为交付端。

### 1.3 盒端系统仓库 `nexusaos-centuarai-os`

```text
nexusaos-centuarai-os/
├── systemd/services/                  盒端系统服务
│   └── centauros-provisioning.service
├── remote-agent/internal/
│   ├── octopbridge/                   已有历史桥接代码
│   ├── control/                       授权、撤销和设备控制
│   └── application/                   盒端应用和资源约束
├── contracts/connectivity/v2/         设备连接和网络配置契约
└── scripts/installation-drivers/      安装和升级驱动
```

该仓库继续负责盒端服务启动、设备身份、初始化和网络配置。已有桥接代码保留在原位置，但新客户端通过盒子 IP 直接访问 Octop，不以它作为新的应用访问链路。

## 2 总体边界

```text
平台控制面
  └── 平台账号、设备归属、授权和盒子地址记录
          ▲
          │ 平台接口
          ▼
wanx-client（新的统一用户桌面端）
  └── 取得目标盒子 IP
      └── 直接访问盒端 Octop HTTPS / WebSocket
          └── Octop 原生认证和业务权限
              ├── 盒端 Dashboard
              ├── 定制 UI 直接访问 Octop HTTP API
              └── 业务数据和流式接口
```

网络层负责客户端到盒子 IP 的可达性，客户端负责取得并更新目标地址。应用访问入口始终是盒端 Octop 服务。局域网 IP 和后续组网 IP 使用同一套访问流程；平台控制面不转发 Dashboard 页面、专家业务请求或流式数据。

## 3 目标新增结构

新的用户桌面端在仓库顶层单独规划为 `wanx-client/`：

```text
wanx-client/
├── shell/                            桌面窗口、系统能力、凭据存储和生命周期
├── account/                          平台账号界面、平台 API 和平台会话
├── provisioning/                     首次发现、认领、配网和初始化
├── devices/                          多盒子目录、地址更新、状态和选择
├── box-access/                       客户端内部的通用直连模块
│   ├── address.ts                    Host URL 规范化、地址选择和更新
│   ├── health.ts                     盒端健康检查
│   ├── session.ts                    Octop 登录、续期、失效和盒子会话隔离
│   ├── http.ts                       直接请求盒端 HTTPS，包括上传与流式响应
│   └── socket.ts                     按 Octop 原生协议建立 WebSocket
├── octop/                            Octop 公开接口适配与原生界面入口
│   ├── dashboard.ts                  打开当前盒端 Dashboard，不复制其页面
│   ├── api/                          专家、Agent、对话等公开 API 的类型化调用
│   └── context.ts                    当前盒子、Octop 用户及目标 Agent 上下文
├── expert-apps/                       客户端内置的定制专家 UI
│   ├── registry.ts                   UI 应用与专家类型的对应关系
│   ├── shared/                       专家 UI 共用的前端组件
│   └── <expert-app>/                 某类专家的定制 UI，按需增加
│       ├── index.tsx                 应用入口
│       ├── pages/                    该专家的业务页面
│       └── hooks/                    页面状态与业务流程组合
├── tests/                            直连、会话隔离及两类界面的验收
└── README.md
```

`box-access/` 只是 `wanx-client` 内部的普通代码模块，不独立发布、不提供给其他项目引用，也不在盒端运行。它不实现组网协议、不实现新的连接协议、不代理业务 API，因此不称为连接 SDK。

`wanx-desktop/` 和 `wanx-admin-desktop/` 是旧代码，保持原样，不迁移、不合并，也不作为新用户端的基础目录。

上述文件名用于表达职责，实际实现随桌面技术栈落地；不为目录齐全预建空模块。定制 UI 首期随新客户端交付，不新增专家应用商店、动态代码加载器或盒端 UI 托管服务。

### 3.1 模块调用边界

| 模块 | 可以调用 | 职责与边界 |
|---|---|---|
| `account/` | 平台公开 API、`shell/` 凭据存储 | 管理平台会话，不把平台 token 当作 Octop token |
| `provisioning/` | 系统 BLE 能力、既有盒端初始化接口、平台认领接口 | 首次配置，不转发日常业务请求 |
| `devices/` | 平台设备目录、`box-access/` | 管理设备 ID、候选地址与实际可达状态 |
| `box-access/` | 当前盒子的公开 HTTP/WebSocket 入口 | 处理传输与会话，不包含专家业务逻辑，不启动 HTTP 代理服务器 |
| `octop/api/` | `box-access/` | 描述公开 API 的参数、返回类型和调用方法；是进程内代码，不是新的服务接口 |
| `octop/dashboard.ts` | `shell/` 窗口能力、当前盒端地址 | 打开远端页面，不截获、重写或代理其逐个 API 请求 |
| `expert-apps/` | `octop/api/`、`octop/context.ts` | 组合 UI 和流程，不访问 Octop 数据库、Python 内部模块或盒端文件系统 |
| `shell/` | 桌面运行时和操作系统 | 提供窗口、配网所需系统能力与凭据存储，不承载专家业务服务 |

依赖方向为 `expert-apps → octop/api → box-access → 盒端公开 API`。原生 Dashboard 使用自己的前端 API 调用，不绕经客户端的专家 UI 模块。

## 4 首次接入和日常使用

### 4.1 首次接入

```text
用户在 wanx-client 登录平台账号
  → 发现盒子并读取设备身份
  → 配置盒子网络
  → 认领盒子并建立平台设备归属
  → 盒端系统服务完成初始化
  → 完成盒端 Octop 首次账号设置或账号关联
  → 保存盒子可访问 IP 和设备状态
  → 设备进入 ready
```

首次流程需要 BLE、局域网发现或盒端系统提供的其他配网能力；这些能力只负责让客户端获得设备身份、完成网络配置并得到盒子地址。完成后，客户端不再重复配网。

### 4.2 日常使用

```text
用户在 wanx-client 登录平台账号
  → 获取用户拥有或获授权的全部盒子
  → 取得目标盒子的当前 IP
  → 校验平台设备 ID 和盒端设备身份
  → 直接访问该 IP 的 Octop HTTPS 服务
  → 使用 Octop 原生认证建立会话
  → 加载该盒子的 Dashboard 或定制专家 UI
```

后续自动更新地址、探测可达性和恢复有效会话，不重复首次认领、配网和初始化。平台在线记录与当前客户端是否可达分开呈现；第一阶段处于其他局域网的盒子可能已上报在线，但当前客户端仍无法访问。网络更换或恢复出厂属于另行触发的重新配置流程。

## 5 盒子 IP 直连设计

### 5.1 统一访问路径

```text
wanx-client
  → 从设备记录取得盒子 IP
  → 拼接盒端 Octop HTTPS 入口
  → 直接建立 HTTPS / WebSocket 连接
  → Octop 完成用户认证和权限检查
  → 直接使用 Dashboard、API 和 WebSocket
```

局域网地址和组网地址都遵循这条路径：

| 场景 | 客户端拿到的地址 | 应用访问方式 |
|---|---|---|
| 局域网 | 盒子在当前局域网中的 IP | 直接访问该 IP 的 Octop 服务 |
| 后续组网 | 组网系统为同一盒子提供的可访问 IP | 直接访问该 IP 的 Octop 服务 |
| 地址变化 | 设备目录或盒端系统返回新 IP | 更新目标地址后按同一流程重连 |

组网系统负责提供可达 IP 和网络安全边界，`wanx-client` 不实现组网协议。客户端只需要验证目标设备身份、处理 HTTPS 信任和管理会话。

当前 Octop 默认配置是 `bind_host=127.0.0.1`、`port=8088`，默认只接受盒端本机访问。盒端要支持客户端通过局域网或组网 IP 访问，需要在部署配置中将监听地址设置为 `0.0.0.0` 或实际可达的网络接口，并放行对应端口。这个调整属于盒端运行配置，不改变 Octop 的 Dashboard、API、WebSocket 或业务逻辑。

### 5.2 复用现有 Host URL 直连机制

现有代码提供两类可参考实现，二者不能混同：

| 当前代码 | 已有机制 | 新客户端复用范围 |
|---|---|---|
| `desktop/src/boxes.go`、`desktop/src/main.go` | 校验 URL、请求 `/api/health`，随后用窗口 `SetURL` 打开盒端 Dashboard | 复用地址校验、健康检查和远端页面加载思路；页面路由按盒端版本选择，不固定照搬旧 `/boxes` 入口 |
| `wanx-desktop/shell/session.mjs` | `connectDirect` 按 `baseURL` 创建 HTTP transport，调用原生登录、保存 token 并验证当前用户 | 参考登录、续期、断开和切换时取消旧请求的逻辑，按新模块边界实现 |
| `wanx-desktop/shell/main.mjs`、`gateway.mjs` | 旧 Electron 客户端加载本机网关页面，并通过既有 SDK 处理请求 | 保留旧代码，不将本机网关、操作白名单或 SDK 宿主搬入新客户端 |

复用指沿用已验证的访问模式、可独立使用的逻辑和测试场景；新客户端不运行或依赖旧桌面端，也不直接导入其完整会话模块而引入旧 SDK/网关依赖。

Host URL 为 `scheme://host[:port]`，用作 `baseURL`；局域网或组网 IP 是其中的 `host`。客户端可以保留人工输入作为诊断入口，日常使用由设备列表自动提供地址。共同的访问准备过程是：

```text
用户或设备目录提供 baseURL
  → 校验为盒端根地址
  → 校验 HTTPS 信任与目标设备身份
  → GET <baseURL>/api/health 检查服务就绪
  → 打开原生 Dashboard，或进入定制专家 UI
```

Host URL 只表示服务入口，不是设备主键；健康检查成功也不等于已验证设备归属或已完成登录。地址按稳定的 `device_id` 管理。地址更新后重新验证目标，不将旧盒子的 token 发送到未经确认的新地址。

远程盒端沿用现有可信 HTTPS 策略，HTTP 仅用于本机回环地址。Host URL 不带用户名、密码、路径、查询参数或片段。若直接使用 IP 作为 HTTPS 主机，证书必须匹配该 IP 并被客户端信任；组网加密不自动解决 HTTPS 证书校验。证书配置与服务监听均在部署边界处理。

### 5.3 原生 Dashboard 直连

```text
devices/ 选择盒子
  → box-access/ 校验当前 Host URL 和服务状态
  → octop/dashboard.ts 请求桌面窗口打开 <baseURL>/
  → 盒端返回 Dashboard 页面及静态资源
  → Dashboard 使用其原生登录或已有会话
  → Dashboard 直接调用同源 /api 与 WebSocket / 流式接口
```

Dashboard 源码仍在顶层 `dashboard/`，构建输出仍为 `src/octop/dashboard/`，由该盒子的 Octop 版本一起交付。客户端只选择地址和打开页面，不复制 Dashboard、不注入业务请求代理、不维护逐接口映射。远端页面与桌面壳的系统能力隔离。

### 5.4 定制专家 UI 直连 API

每类专家可以配置自己的 UI 应用，同一个 UI 可以用于不同盒子上的该类专家实例；每个已安装专家实例是否有定制 UI，由客户端应用登记信息决定。尚无定制 UI 的专家仍通过原生 Dashboard 使用。此处规划的是定制入口，不表示系统已经能自动为任意专家生成 UI。

```text
expert-apps/registry.ts 选择专家 UI
  → octop/context.ts 提供 boxId、baseURL、Octop 用户与 agentId
  → expert-apps/<expert-app>/pages + hooks 组合交互
  → octop/api/ 组织公开接口参数
  → box-access/ 使用该盒子的 Octop 会话直接发起网络请求
  → <baseURL>/api/... 或该服务的 WebSocket / 流式接口
  → Octop 校验用户及 Agent 权限并执行业务
  → 定制 UI 展示结果和流式进度
```

`expert-apps/<expert-app>/` 保存专家专属页面、表单、结果展示和交互流程；通用请求放在 `octop/api/`，地址与认证放在 `box-access/`。这些都是客户端内部函数调用，网络请求的目标始终是盒子，不经过云端业务转发或本机 HTTP 代理。

专家模板 ID 与运行中的 Agent ID 分开处理。选择模板后，通过公开接口找到或创建用户可访问的 Agent 实例，再将该实例的 `agentId` 传入调用上下文。不同盒子上的实例独立，不能仅凭专家名称或模板 ID 跨盒子复用 Agent ID。

调用范围包括所需的专家/Agent 信息、对话、任务结果与已有资源接口，具体路径及请求结构以目标 Octop 版本的公开 API 为准。HTTP 登录与续期沿用原生机制；WebSocket 握手、SSE 和流式认证分别遵循对应端点的现有协议，不假定浏览器 WebSocket 可随意添加 Authorization 请求头。

定制 UI 首期为桌面端内置页面。若从 WebView 页面直接跨源请求盒端，需要使用 Octop 已有的 `cors_origins` 配置放行明确的客户端源，并配置客户端自身的请求策略；当前后端已在 `api/app.py` 中提供 CORS 配置入口。WebSocket 的 Origin 与认证另行按原生接口验证。不能仅以 IP 可达推断内置页面已具备调用条件，也不通过关闭浏览器安全检查或新增代理解决。

按本规划新增专家 UI 无需修改 Octop 网络协议或复制其业务逻辑。若某专家所需能力尚无公开 API，则记录为单独的能力缺口，优先使用官方扩展机制或上游能力，不能把“UI 定制”当作现有后端功能已经齐备。

### 5.5 会话与多盒子隔离

原生 Dashboard 与定制 UI 使用同一个盒端认证体系和用户权限，但不同源的页面、桌面凭据存储不会自动共享 token。Dashboard 默认使用原生登录；定制 UI 由 `box-access/session.ts` 管理登录。统一登录体验需用目标版本支持的认证机制衔接并单独验收，不在 URL 中传递长期 token，也不假设客户端登录后 Dashboard 已自动登录。

会话至少按盒子 ID 和 Octop 用户隔离，专家页面状态再按 Agent ID 隔离。切换盒子、退出登录或会话失效时，关闭旧 WebSocket 和流式请求、取消未完成请求，清理旧页面上下文，防止旧响应写入新盒子的界面。缓存的有效会话可用于自动重连；失效后按原生认证流程处理。

### 5.6 应用层保持不变

盒端 Octop 的以下内容不因网络路径变化而修改：

- Dashboard 页面和资源加载方式；
- 现有 HTTP API；
- WebSocket、SSE 和流式接口；
- Agent、工作区、对话和其他业务逻辑；
- 盒端业务权限模型。

平台账号与 Octop 本地账号的关联发生在登录和初始化边界，不通过修改业务接口完成。只要客户端能访问盒端 IP，后续业务请求继续使用 Octop 原有协议。

## 6 两套账号和设备关系

平台账号和 Octop 本地账号保持边界分离。产品目标是用户以平台账号统一使用多盒子；账号关联与单点登录尚需验证，不能将该目标标为现有能力：

```text
平台账号
  └── platform_user_id
      └── device_id / box_id
          └── 盒端授权成员
              └── Octop 本地 subject
```

平台控制面负责：

- 用户注册、登录和会话；
- 用户拥有或获授权的盒子列表；
- 设备归属、成员角色和授权状态；
- 盒子的当前可访问 IP 或地址记录。

盒端系统和 Octop 负责：

- 设备身份和证书；
- Octop 本地用户、角色和业务权限；
- Dashboard、API、Agent、工作区和业务数据；
- 通过原生认证创建和撤销 Octop 会话。

平台密码不下发到盒子，也不把平台用户表复制到 Octop 数据库。网络可达只代表可以访问盒子，不代表已经完成 Octop 登录。

优先验证目标 Octop 版本已支持的认证/SSO 机制，在初始化时关联平台用户与各盒子的本地用户。每台盒子保存独立的业务身份和数据。平台撤权后只隐藏客户端入口不足以撤销盒端已有会话；需验证盒端原生会话撤销及后续组网 ACL 的联动边界。

## 7 Dashboard、旧集成与升级边界

顶层 `dashboard/` 继续作为 Dashboard 前端源码目录，构建后由盒端 Octop 提供。新的 `wanx-client` 负责平台侧页面、设备管理、配网入口、盒子选择、打开盒端 Dashboard 和承载定制专家 UI；它不复制盒端原生业务页面，也不在应用层增加代理接口。

已有 `/api/box-management`、`infra/boxes/management.py`、`sdk-box-management/` 以及旧桌面端代码按现状保留，用于兼容已有功能。本规划不把它们改造成新的盒端连接层。

为了跟随 Octop 社区版本升级：

1. 不在 `src/octop/` 官方结构中新增平台设备总表、网络发现、配网或连接 SDK；
2. 不读取 Octop 内部数据库，不把平台业务逻辑塞入 Octop；
3. 新客户端通过盒端公开的 HTTPS、WebSocket 和认证入口访问 Octop；
4. 不维护逐个业务 API 的代理清单；
5. 每次升级验证原生认证、Dashboard、定制 UI 所用的公开 API、流式连接、数据库迁移和盒端初始化接口仍然可用；必要的公开 API 适配集中在客户端 `octop/api/`。

## 8 实施顺序

1. 固定当前 Octop 和盒端系统基线，确认现有设备身份、地址和初始化接口。
2. 对齐平台设备目录中的 `device_id`、授权状态和盒子 IP 字段。
3. 新建 `wanx-client`，完成平台账号、设备列表、首次发现、配网和初始化闭环。
4. 复用现有 Host URL 直连机制，实现客户端内部的地址校验、健康检查、HTTPS、WebSocket 和 Octop 原生认证。
5. 验证局域网 IP 访问、多个盒子切换、地址变化重连和授权撤销。
6. 选择一个已有专家实例，完成定制 UI 从选择 Agent、调用公开 API 到流式结果展示的闭环，验证跨域、会话及权限。
7. 对固定版本的 Octop 做升级演练，验证两类界面与公开 API 的兼容性。
8. 后续集成组网工具后，在双方已有可路由 IP 的条件下验证相同 Host URL 流程；不把组网实现纳入第一阶段。

### 8.1 实施验收边界

| 验收项 | 完成标准 |
|---|---|
| Host URL 直连 | 服务在目标网卡监听、端口可达、证书与目标匹配，健康检查和 Octop 登录分别通过 |
| Dashboard | 加载盒端页面与资源，原生登录、API 与实际使用的流式功能正常；请求目标是盒端 |
| 定制专家 UI | 使用正确盒子与 Agent 上下文，公开 API、跨域配置和流式认证正常，不调用客户端 HTTP 代理 |
| 多盒子 | 地址更新后验证目标；切换时旧请求和会话不串入新盒子；不可达状态不被当成未初始化 |
| 账号与权限 | 平台 token 与盒端 token 分离，普通成员不能因更换 UI 获得额外权限；撤权行为按确认方案验收 |
| Octop 升级 | Dashboard 与后端同版本，专家 UI 的公开 API 兼容，不依赖私有数据库或 Python 模块 |
| 后续组网 | 使用组网 IP 完成上述相同调用；只调整地址和网络配置，不增加业务代理或连接 SDK |

## 9 需要确认的接口

- 首次发现、设备身份读取和配网完成后，盒子 IP 如何返回给客户端；
- 平台设备目录如何记录局域网地址和后续组网地址；
- 盒端 HTTPS 入口、证书信任和设备身份校验方式；
- 目标 Octop 版本支持的原生认证机制，以及平台身份如何关联到 Octop 本地账号；
- 普通成员、所有者和管理员的权限映射；
- 桌面技术栈提供的页面源、CORS/请求策略配置，以及 Dashboard 与定制 UI 的登录衔接方式；
- 首个定制专家 UI 对应的 Agent 实例、公开 API 范围与版本兼容条件；
- 平台授权撤销后，客户端和盒端如何让已有 Octop 会话失效。

这些接口决定的是地址获取、身份关联和会话管理，不改变 Octop 的 Dashboard、API 和业务实现。

## 10 当前实现参考

以下路径用于实施时对照，均不是要求修改旧模块：

- [Wails URL 校验、健康检查和打开盒子](../desktop/src/boxes.go)
- [Wails 窗口加载远端页面](../desktop/src/main.go)
- [旧 Electron Host URL 认证与会话实现](../wanx-desktop/shell/session.mjs)
- [旧 Electron 窗口入口](../wanx-desktop/shell/main.mjs)与[旧本机网关](../wanx-desktop/shell/gateway.mjs)
- [Octop 监听与 CORS 配置](../src/octop/config.py)及[CORS 中间件](../src/octop/api/app.py)
- [Octop 原生认证接口](../src/octop/api/routers/auth.py)
- [专家模板及创建 Agent 接口](../src/octop/api/routers/experts.py)
- [Dashboard 原生请求与会话处理](../dashboard/src/api/request.ts)
