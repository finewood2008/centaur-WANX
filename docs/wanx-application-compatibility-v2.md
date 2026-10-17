# 市场应用兼容合同 v2 / v3 与资源准备

状态：v2 只读语义保留；v3 增加基于已发布制品的资源准备。客户端实现不修改 Octop 源码，不给旧应用改实例或伪造来源。下方 v2 章节记录原协议，v3 增量如下。

## v3 精准资源依赖

描述 `schemaVersion: 3` 与包内 `manifest.protocolVersion: 3` 必须一致，签名覆盖两处完全一致的 `compatibility`。v2 的客户端/Host/后端接口/数据 schema 字段保留；仅将 `requiredExperts` 替换为：

```json
{
  "resourceDependencies": [
    {"kind": "expert", "resourceId": "zhijun-personal-companion", "minVersion": "1.0.0"},
    {"kind": "skill-package", "resourceId": "research", "minVersion": "1.2.0"}
  ]
}
```

每一项都必须满足。允许空数组表示无资源依赖，禁止 `required`、`versionRange`、名称匹配和重复 `(kind, resourceId)`。资源 ID 遵循 `[a-z0-9][a-z0-9._-]{0,63}`；最低版本只能是稳定三段 SemVer，各段最大 `2147483647`，不接受预发行或 build metadata。新版资源需保证向前兼容，按最低版本检查，不设资源版本上限；应用自己的客户端/接口兼容区间不受此规则替代。

打包工具直接读取应用清单、复制为包内清单、生成一致的签名描述。运营上传包和签名描述时，Admin 从发行制品读取依赖，不需要重复录入。不能凭应用名称推断依赖，也不自动将旧 schema1/2 包改写为 v3。新版客户端候选请求声明 `supportedDescriptorSchemas: [1, 2, 3]`，旧客户端继续使用原协议。

候选只核验客户端、Host 和必要后端接口；资源未下载或未实例化不阻止选择可安装应用。签名安装在摘要与归档清单核验完成后调用准备回调。已连接盒子则自动准备，未连接仍可安装前端，列表提示“打开时将自动检查并准备盒端专家和技能包”。准备失败或离线不等于授权成功。启动前必须对当前已认证盒子重新准备和核验，不信任磁盘安装时留下的 ready 状态。

准备请求：`POST /api/platform/applications/prepare`，正文严格为 `{schemaVersion: 1, applicationId, artifactId}`。权威依赖由 Admin 已发布的 artifact 解析，客户端不提交待授权依赖。准备返回的 `deviceId`、`applicationId`、`artifactId`、`backendProductId`、ISO 8601 UTC 观测时间、`resources` 与 `bindings` 都要校验。只有已安装版本达到最低版本，且专家有真实 `instanceId`、技能包有真实 `packageId`，才允许 ready。下载成功不等于可运行。

随后请求 `POST /api/platform/applications/readiness`，v3 正文额外包含 `artifactId`，再次检查后端接口和授权。显式拒绝仍然阻断。prepare/readiness 使用同一个固定应用连接，每次响应后检查账号、客户端和盒子；连接发生变化时丢弃迟到结果。该固定连接继续用于应用 Host 会话，避免准备 A 盒后从 B 盒启动。

v3 的后端产品由已验签清单 `backendProductId` 指定，主进程连接只接受已支持的 `wanx` / `super-advisory`。Bridge 再将其与 Admin 的已发布制品和真实上游账号产品核对。旧 schema1/2 继续按历史应用 ID 选择产品。renderer 与 Host SDK 不接受任意产品覆盖，应用请求不能通过额外字段更换作用域。当前动态资源准备支持 `wanx` 私有专家通道；`super-advisory` 专用产品路径未支持时明确返回阻塞，不通过切换管理账号处理。

Host context 增加 `applicationId`、`artifactId`、`resourceBindings`。新应用通过 `host.resolveResourceBinding(kind, resourceId)` 取精准绑定，或通过 `host.requestExpert(resourceId, "/threads")` 自动使用真实实例路径。不再根据显示名称寻找专家或创建同名实例。旧应用的 Host 方法与选择路径保持不变。资源准备采用 Bridge 对外 API 及独立账本，具体入库/下载/实例归属参见资源中心协议；本客户端不实现独立授权或直接操作 Octop 数据库。

资源有新发行时可自动下载到缓存；已绑定的专家版本只要满足应用 `minVersion` 就继续复用，`updateAvailable` 不代表切换实例。首次创建使用满足依赖的最新发行。应用提高最低版本、已有实例需要迁移时，以 `RESOURCE_MIGRATION_REQUIRED` 明确阻塞该应用的新版本，保留原绑定和历史数据供兼容旧应用继续使用；不通过创建新实例假装完成迁移。

验证：`tests/resource-dependencies-v3.test.mjs` 覆盖签名与包声明一致、没有可选/区间依赖、向前兼容、离线安装、准备前归档校验、迟到账号/盒子结果、显式拒绝、真实 Host SDK 精准实例请求，并消费真实 Python ResourceRuntime 调用 Octop API 产生的 `wanx-bridge/tests/fixtures/resources-prepare-v1.json`。跨端签名向量为 `tests/fixtures/market-contract-v3.json`，仅含测试公钥与签名归档，不含私钥。


## 签名合同

市场描述使用 `schemaVersion: 2`，包内 `manifest.protocolVersion: 2`。两处必须包含完全一致的 `compatibility`，签名覆盖整个描述；包内清单仍经过摘要与规范化内容比较。旧客户端会拒绝新 schema/protocol。

```json
{
  "backendProductId": "wanx",
  "clientRange": ">=0.1.0 <1.0.0",
  "hostProtocolRange": ">=1.0.0 <2.0.0",
  "backendContracts": [
    {"id": "wanx-bridge.readiness", "range": ">=1.0.0 <2.0.0", "features": ["read-only"]}
  ],
  "requiredExperts": [
    {"templateId": "zhijun-personal-companion", "versionRange": ">=1.0.0 <2.0.0", "role": "companion", "count": 1, "required": true}
  ],
  "localDataSchema": {"readRange": ">=1.0.0 <2.0.0", "writeVersion": "1.0.0"}
}
```

范围仅支持空格分隔的稳定 SemVer 比较器：`=`, `>`, `>=`, `<`, `<=` 或准确版本。没有 `*`、`^`、`~`、`||` 或隐式版本范围。Host 整数协议 `1` 对应 `1.0.0`。未知 v2 字段、未知必需扩展和非空 `critical` 拒绝；未来模型、额外权限和迁移策略需要受支持的新合同，不能静默省略。

schema1 保持原有运行语义，诊断结果明确标为 `legacy / LEGACY_CONTRACT`，不声称已证明所有后端兼容。schema1 中携带 v2 `compatibility` 会被拒绝，不能靠改低版本绕过约束。

## 检查位置

- 导入、签名安装和旧版本选择检查客户端与 Host，不要求盒子在线。
- 启动会重新检查当前盒子的后端合同、应用授权和必需专家；无证据时阻断，未建立应用会话。
- 候选请求声明 `supportedDescriptorSchemas: [1, 2, 3]`。已连接盒子不兼容时可附上 `backendReadiness` 请求仍受支持的历史候选；每个响应仍独立验签。未连接盒子可选择客户端兼容包，打开前再检查。
- 向 v2 回退必须取得真实的 `localDataSchemaVersion`，且目标 `readRange` 可读；从 v2 回退到无数据声明的 v1 阻断。不会从版本号推断数据已迁移或可以恢复。
- 安装、选择和启动也检查已知的真实数据版本。卸载保留的 profile、旧路径 `application-data/<applicationId>` 和无可信连续性记录的已有数据，在版本未知时阻断；不能通过卸载重装旧包绕过读取范围。
- 后端证据最多保留五分钟，未来时间超过一分钟拒绝；提供 `expectedDeviceId` 时必须匹配当前目标，专家实例按 `instanceId` 去重。

Admin 市场接口已支持 v2 校验、兼容历史候选与合法历史制品下载，响应以 `selection: "compatible_history"` 标识历史选择。缺少 `supportedDescriptorSchemas` 的旧请求仍按 schema1 处理。已撤回发行不得新激活；候选返回不构成盒端权益授权。Node 与 Python 共用 v2 签名归档样例验证合同一致性。

`createApplicationManager` 和 `createApplicationMarket` 接受 `getCompatibilityContext({manifest, descriptor, phase})`，返回 `{clientVersion, hostProtocol, backendRequired, expectedDeviceId, backend, localDataSchemaVersion}`。只在选定盒子需要检查候选时设置 `backendRequired: true`。提供方必须使用本次受权会话读取当前盒子，并在返回前再次检查会话；不能按应用名缓存跨账号、跨盒子的结果。

Host manager 在签名 v2 制品第一次访问空 profile 前，原子持久化 `applications/.data-access/<applicationId>.json`，记录可能的最后写入制品 `artifactId` 和已核验描述的 SHA-256 摘要。先同步临时文件，再原子替换记录并在支持的平台同步目录；启动中断和卸载均保留该记录。读取拒绝符号链接、非普通文件、重定向目录和损坏记录，不能把异常解释为没有数据。

同一签名制品重新打开时，可以凭 manager 核验的私有连续性证据继续使用同一 profile，因此 Electron 正常写入配置后不会阻止第二次打开。该证据只表示这个制品已获准访问数据，不证明真实数据 schema，也不把 `writeVersion` 当作迁移成功。远端诊断和 renderer 不能提供连续性豁免。已知真实 schema 仍必须符合 `readRange`；换制品、降版、回退和卸载后重装都需要真实 schema 证据，当前壳未接入这种证据时继续阻断（包括卸载后重装同一制品），不自动迁移或删除数据。

已安装版本等于或高于市场目标时，v2 候选仍重新核验当前盒子；不兼容时请求受支持的历史版本。历史候选低于本地版本只显示需要兼容恢复，不自动降版。

客户端自身升级可调用 manager 的 `beginMaintenance()` 同步取得排他锁，返回幂等释放函数；有应用操作进行时返回 `UPDATE_IN_PROGRESS`。锁内拒绝新的安装、选择、启动和回退，允许关闭。`isBusy()` 表示锁或正在进行的应用操作。

## Bridge 只读接口

`GET /api/platform/version` 要求有效平台会话，返回设备身份、观测时间、Bridge 自身安装包版本及可选发行配置 `WANX_BRIDGE_BUILD_ID` / `WANX_BRIDGE_SOURCE_REVISION`。缺失构建信息保持 null。`contracts` 仅声明当前 Bridge 实现的 `wanx-bridge.version` 与 `wanx-bridge.readiness` 1.0.0；不把 Bridge 版本当作 Octop 业务 API 版本。上游业务版本无公开证据时明确未知。

`POST /api/platform/applications/readiness` 请求为 `{schemaVersion: 1, applicationId, compatibility}`。响应包含 `productId`, `deviceId`, `observedAt`, `authorization`, `contracts`, `experts`, `checks`, `readOnly: true`，并沿用版本诊断字段。它只对当前会话执行公开 `GET /api/auth/me` 和需要时的 `GET /api/agents?scope=mine`；不访问 Octop 内部模块、数据库或文件。请求前后检查平台会话有效性，响应禁止缓存。

当前受控映射：`centaurai.wanx.zhijun → wanx`，`centaurai.wanx.superadvisors → super-advisory`。客户端提交的映射不产生权限。

## 旧 v2 只读协议的阻塞边界

公开专家列表没有可靠的模板版本、制品摘要和受管基线。即使名称相同，或上游返回未验证的版本样式字段，也不据此登记模板来源。已有个人实例只显示为 `provenance_unknown`，必需专家返回 `EXPERT_VERSION_UNKNOWN`；没有实例时返回 `EXPERT_NOT_PREPARED`。迁移能力返回 `EXPERT_MIGRATION_UNSUPPORTED`，所有原数据保留。

父 WANX 会话不能通过公开个人查询证明 `super-advisory` 的独立授权。现有 `/api/applications/{id}/profile` 与 `/release` 要求令牌已属于目标产品，`/api/admin/applications/{id}/access` 为管理员接口。应用 exchange 可能复用免费 bootstrap 并产生写入，因此诊断不调用它。父会话返回 `APP_AUTHORIZATION_UNVERIFIED`；已存在的目标作用域会话通过 `/api/auth/me` 才能证明当前授权。schema1 不受这些新诊断阻塞影响。

后续正式专家接入需要可信模板发行与摘要、Bridge 自有账号/设备/归属/模板/实例来源账本，以及公开接口提供的实例读取、并发隔离、恢复点、回读和幂等迁移能力。缺少任一前置条件继续阻断；不覆盖原专家，不删除重建，不绕过显式拒绝。正式的新实例准备应在权益和盒主资源政策允许后独立执行，并明确确认写入。
