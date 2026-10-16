# 专家与技能资源导入

`tools/package-resources.py` 把原 Octop 内置专家和自建模板转换为 Admin 资源中心 v1 JSON 包；`tools/resource-upstream.py` 导入明确选定的 SkillHub 在线条目或离线下载包。它们不修改 Octop，不启动专家，不读取盒子，不调用模型。生成资源包与 Admin 上传分开；唯一写入 Admin 的命令是显式的 `upload-draft`，两个工具都没有发布接口。

资源版本使用稳定的 `major.minor.patch`。依赖使用 `kind + resourceId + minVersion`：所有依赖都是必需依赖，无可选项、版本区间或替代匹配；新稳定版本按向前兼容处理。包规则与 Admin 的 `docs/contracts/wanx-resources-v1.md` 一致。

## 导入原内置专家

在 `centuarai-wanx` 根目录执行：

```bash
python3 tools/package-resources.py library \
  --version 1.0.0 \
  --output-dir release/resource-catalog-20261015
```

工具只扫描本仓库固定的 `src/octop/infra/agents/experts/library`。每个专家输出一个独立 JSON 包和一个汇总 `index.json`。默认排除内部 `default` 模板；需要归档它时显式加 `--include-default`。不把 `__pycache__`、`.pyc` 等本机运行缓存当成模板内容。

这里覆盖仓库内置内容。Octop 原界面的在线专家/技能市场还会访问 SkillHub 外部目录，这些条目不在源码中，使用下一节的选定导入命令。本命令不会镜像整个外部市场。客户已经创建的全局技能包也不属于内置库；不能把本节的导出数量解释为在线市场和客户内容全部迁移。

资源 ID 使用 `octop-<原expertId>`，保留原根 `manifest.json`、提示词、技能脚本、附件和二进制文件。内置模板自带的技能会随专家包一起保留。不要用 `/api/experts/{id}` 的 `file_contents` 作为完整导出，它只是文本预览，会遗漏非预览文件和二进制。

每个包的 `metadata.provenance` 包含真实 Git commit、工作区 dirty 状态、模板文件内容摘要。无 Git 来源时 commit/dirty 为 null，不会伪造 clean 状态。输出不包含机器绝对路径或 Git 远端凭据。输出包是不可覆盖的：同路径相同字节可复用，不同内容必须使用新版本或新输出目录。

要同时把内置技能独立登记到技能资源库：

```bash
python3 tools/package-resources.py library \
  --version 1.0.0 --split-skills \
  --output-dir release/resource-catalog-with-skills-20261015
```

独立技能包保留 `skills/<slug>/SKILL.md` 和附件。ID 使用 `octop-<原expertId>-<技能slug>`，超长 ID 用来源完整字符串摘要截断；不同专家里的同名技能不会被错误合并。此模式额外生成技能包，不自动删除专家内的技能，也不擅自给专家添加外部依赖。之后经过人工确认的共享技能才应拆出并声明精准依赖。

## 导入选定的原在线市场内容

Octop 原市场使用 SkillHub 的公开接口。先在原市场选择具体条目，取得精确 slug，再执行对应命令；本工具不自动遍历、下载或发布整个外部目录。

导入单个技能，包含原始 `SKILL.md`、脚本与全部附件：

```bash
python3 tools/resource-upstream.py skill --slug weather --version 1.0.0 \
  --output release/skillhub-weather-1.0.0.json
```

导入技能集作为专家（默认 `--kind expert`）：

```bash
python3 tools/resource-upstream.py skillset --slug tech-test-automation --version 1.0.0 \
  --output release/skillhub-test-expert-1.0.0.json
```

如果要把同一技能集维护成独立技术包，添加 `--kind skill-package`。它包含编排技能和全套配套技能，可作为应用或专家的精准依赖；专家导入默认保留内嵌技能，不会自动创建含糊的按名称匹配依赖。

取数过程对应原 Octop 的真实路径：

1. 专家详情：`GET https://api.skillhub.cn/api/v1/skillsets/{slug}`。
2. 专家编排包：`GET /api/v1/skillsets/{slug}/download`。此 ZIP 本身不一定包含配套技能，不能直接视为完整专家。
3. 按 manifest 的完整 `skillSlugs` 逐个执行 `GET /api/v1/download?slug={skillSlug}`，保存每个 ZIP 的全部文件。任何下载、校验或大小检查失败，整个资源包不生成。

工具核对详情与编排包的技能清单一致、编排包声明的文件 SHA-256/大小正确，然后生成符合 Octop 公开安装路径的根 `manifest.json` 和 `SOUL.md`。原始编排、manifest、附件完整保存在 `skills/<skillset>/source/`，配套技能保存在各自 `skills/<slug>/`。原始附件字节不会转码。只有预览文本、缺少编排或缺少任何声明技能时会明确拒绝导入。

默认资源 ID 分别为 `skillhub-skill-<slug>`、`skillhub-skillset-<slug>`；必要时用源字符串摘要缩短，大小写来源不会被误合并。Admin 版本由 `--version` 明确指定，不把上游可变目录误当成不可变发布版本。`--resource-id` 可指定经确认的 Admin 身份。来源元数据包含精确 slug、每次下载的 URL、字节数、SHA-256 和最终内容摘要；网络来源的 Git commit/dirty 均为 null。

网络仅允许 `api.skillhub.cn` 指定公开下载/详情路径，以及实际下载接口返回的 `skillhub-1388575217.cos.accelerate.myqcloud.com/skills/...zip`。每次重定向重新检查；不接受外部 host 参数、HTTP、认证信息或任意下载 URL。保留 HTTPS 证书校验，允许无认证的系统代理，不读取 `.netrc`。单 ZIP 最多 24 MiB、单次总下载最多 64 MiB，展开后的资源仍受 256 文件/16 MiB 限制。ZIP 只在内存解析，拒绝穿越、隐藏运行目录、私密内容、软链接、特殊文件、加密包、大小写冲突和异常压缩比，不执行脚本或安装依赖。

离线单技能导入（完全不联网）：

```bash
python3 tools/resource-upstream.py skill --slug weather --version 1.0.0 \
  --archive /path/to/weather.zip --output release/skillhub-weather-1.0.0.json
```

离线专家需给出编排 ZIP，并用重复的 `--skill-archive <slug>=<文件路径>` 明确列出 manifest 中的每一个配套技能 ZIP。例如一个清单恰有 `one`、`two` 两个技能的专家：

```bash
python3 tools/resource-upstream.py skillset --slug chosen-workflow --version 1.0.0 \
  --archive /path/to/workflow.zip \
  --skill-archive one=/path/to/one.zip --skill-archive two=/path/to/two.zip \
  --output release/chosen-workflow-1.0.0.json
```

少给、多给或重复技能包均拒绝，不会偷偷联网补下载。生成的 JSON 经下面的 `validate` 和 `upload-draft` 流程进入 Admin 草稿；它不会自动发布或改变现有客户实例。

## 打包自建模板

创建模板专用目录，并另建一个显式文件清单，例如 `resource-spec.json`：

```json
{
  "schemaVersion": 1,
  "kind": "expert",
  "resourceId": "company-advisor",
  "version": "1.0.0",
  "name": "企业顾问",
  "description": "企业经营问题分析",
  "dependencies": [],
  "metadata": {},
  "files": ["manifest.json", "AGENTS.md", "SOUL.md", "skills/research/SKILL.md"]
}
```

```bash
python3 tools/package-resources.py directory \
  --root /path/to/template \
  --spec /path/to/resource-spec.json \
  --output release/company-advisor-1.0.0.json
```

`files` 必须逐一列出相对文件路径，不接受通配符或整目录递归。`AGENTS.md`、`SOUL.md`、`SKILL.md` 等指令文件只作为模板数据打包，不执行其内容。工具拒绝路径穿越、软链接、Windows 不兼容路径、大小写重复、私钥内容及常见凭据/运行数据路径，包括 `.env`、`.octop`、会话、记忆、历史、数据库。文件清单仍应由作者确认，不能把个人工作区的整包备份当成市场模板；Octop 的 `/workspace/archive` 会包括 `.env` 等内容，不能直接公开上传。

单包最多 256 个文件，单文件最多 4 MiB，总原始内容最多 16 MiB，JSON 最多 24 MiB。metadata 不超过 64 KiB，禁止浮点数和超出 JavaScript 安全范围的整数。专家包的根 `manifest.json` 在运行端安装时会映射为 `.octop/manifest.json`；不要在源包中直接加入 `.octop` 工作区状态。

## 校验与草稿上传

```bash
python3 tools/package-resources.py validate \
  release/resource-catalog-20261015/expert--octop-zhijun-personal-companion--1.0.0.json
```

输出包括资源身份、文件数量、原始内容大小、JSON 大小和规范包 SHA-256。

把当前 Admin access token 保存到仅自己可读的文件（POSIX 权限 `0600`，内容只有原始 token），通过文件参数传入：

```bash
python3 tools/package-resources.py upload-draft \
  --package release/resource-catalog-20261015/expert--octop-zhijun-personal-companion--1.0.0.json \
  --api-base https://admin.example/prod-api \
  --token-file /private/path/admin-access-token
```

只发送 `POST /nexus/resources/versions`，使用系统 HTTPS 证书校验、禁止重定向，不输出 token。响应必须与上传包的身份、摘要、字节数一致且为 draft。正式发布需在 Admin 资源中心检查并执行；目录出现新草稿不会触发客户自动安装。

## 2026-10-15 离线导出验证

已生成但未上传、未发布：

| 输出 | 内容 | 规范 JSON 合计 |
|---|---|---:|
| `release/resource-catalog-20261015/` | 26 个专家 | 7,558,443 字节 |
| `release/resource-catalog-with-skills-20261015/` | 26 个专家、31 个来源明确的技能包 | 14,426,101 字节 |

全部包通过本工具校验，也通过 Admin 实际 `resource_center_contract.validate_package` 校验，规范 JSON 字节一致。源工作区存在修改，因此全部如实记录 `dirty: true`。

专家索引 SHA-256：`f75eeadca5cfe578d8a44d843fd4dec5cd1d0a594db87d165d5f0fee1cce4914`。

专家与技能索引 SHA-256：`3c09ab2103e4b17a0564a37692489f3ad69864dcbf8141345aad975a5024eca7`。

本工具回归命令：

```bash
python3 -m unittest discover -s tools/tests -p test_package_resources.py -v
```

覆盖完整内置文件/二进制、default 排除、同名技能隔离、显式清单、私密文件和软链接拒绝、真实 dirty 来源、协议边界、不可覆盖输出和 draft-only HTTP 请求。它不能替代盒端安装后业务验收。

公开 API 适配的实际集成测试另见 `wanx-bridge/tests/test_resource_octop_api.py`，需在仓库完整 Octop 测试环境运行。原 Octop 对虚拟文件系统专家挂载全局技能包有限制，会返回 `SKILL_PACKAGE_BACKEND_UNSUPPORTED`；运行端应使用原有技能复制 API 或直接写入已验证的私有工作区文件，不能为了挂载技能把用户工作区改成整机根目录访问。

## 2026-10-16 原在线市场只读验证

已从上述真实公开接口下载，不上传 Admin、不发布、不访问盒子，输出位于 ignored `release/resource-upstream-20261016/`：

| 来源 | 资源 | 文件数 | 原始字节数 |
|---|---|---:|---:|
| `weather` | 单技能包 | 2 | 3,290 |
| `tech-test-automation` | 完整专家，含编排和全部 6 个配套技能 | 31 | 155,971 |
| `tech-test-automation` | 完整技术包，含编排和全部 6 个配套技能 | 29 | 154,260 |

单技能包 SHA-256：`3a105d126447eb26aeca53ff38bd2dadc730d208dcf3ecaeb19c58a4d10a02b9`。

完整专家 SHA-256：`27bcf3e180239d9fc7603eaba727b62a88e10f6ff137081bf138920f5e527faa`。

完整技术包 SHA-256：`f2169e8d0e7a7dca894d0977085b779b72832d6ac43038f75fdfe196272a2f03`。

三包索引 SHA-256：`478bd46da0f77dd37d37b9adc0920bcafc3be8709297d94425e60d775c440f39`。三包均通过 Admin 实际 `validate_package`、`validate_installable_package`，规范 JSON 字节一致。

此验证覆盖了真实 API/CDN 重定向、完整附件下载和本地规范包生成。它证明选择性迁移路径可用，不能解读为整个在线市场已经迁入 Admin。模板内脚本和第三方依赖仍需发布人员审核，生成草稿本身不代表可在客户环境执行。

额外回归：`python3 -m unittest discover -s tools/tests -p test_resource_upstream.py -v`。覆盖完整多技能集、源 manifest 保留、预览/缺件拒绝、上下游清单变化、离线零网络、二进制字节保留、恶意 ZIP、下载限额、域名/重定向约束及精确资源 ID。
