# 独立本地身份的离线应用资源目录

应用资源准备由原生 Octop 以已经验证的本地用户 UID 执行。目录签名只证明发布内容和依赖，不授予用户或应用访问权限。每次 prepare/readiness 都通过父操作的 `authorize_resources` 复核当前资源授权，写入和等待锁后再次执行 `require_live`。

当前原生适配器支持应用协议 v3、稳定版本号、`backendProductId: "wanx"` 的私有 expert 和 skill-package。其他产品、未知协议或目录缺失明确拒绝，不调用旧云账号 Bridge 执行器。`releaseAccess: "account"` 的应用或资源仍需要在线市场许可；本目录不解除许可限制。只有已安装且不要求在线市场许可的应用，可以完全离线运行。

## 部署布局

主机目录 `/var/lib/centuarai/local-resource-catalog` 由可信部署管理员维护，在 Octop 容器内只读挂载为 `/run/centuarai-local-resource-catalog`。信任文件只读挂载为 `/etc/centuarai/local-trust/resource-trust.json`。

```text
OCTOP_LOCAL_RESOURCE_CATALOG=/run/centuarai-local-resource-catalog
OCTOP_LOCAL_RESOURCE_TRUST=/etc/centuarai/local-trust/resource-trust.json
```

信任文件使用以下精确结构。应用发布公钥和资源发布公钥分开配置，不自动使用开发测试公钥，不接受来自客户端请求的公钥。

```json
{
  "schemaVersion": 1,
  "applicationKeys": { "application-release-key-id": "Ed25519 public PEM" },
  "resourceKeys": { "resource-release-key-id": "Ed25519 public PEM" }
}
```

发布流水线沿用现有应用 descriptor envelope（`keyId/descriptorBase64/signatureBase64`）和 `wanx.resource.v1` envelope。资源包可由仓库 `tools/package-resources.py` 的 `library` 或 `directory` 命令生成；它们生成内容包，正式发布系统为这些内容包签发 envelope。不能把未签名草稿当成已发布资源。

部署时在已安装 Octop 的 Python 环境运行：

```sh
python -m octop.infra.applications.local_catalog install \
  --catalog /var/lib/centuarai/local-resource-catalog \
  --trust /etc/centuarai/local-trust/resource-trust.json \
  --application-envelope /opt/release/application-envelope.json \
  --resource /opt/release/expert-envelope.json /opt/release/expert-package.json \
  --resource /opt/release/skills-envelope.json /opt/release/skills-package.json
```

每个 `--resource` 接收一个 envelope 文件和一个包文件；第二个参数也可以是目录，此时仅读取该目录固定的 `package.json`。必须提供应用签名声明的完整依赖闭包，额外资源也会被拒绝。CLI 不执行应用、资源脚本或安装钩子，不从包内容接受目标路径，不联网下载或发布。

CLI 验签、核对包哈希、大小、资源身份、版本和安全相对路径后，先发布不可变 `packages/<sha256>.json`，再原子发布 `artifacts/<artifactId>.json`。同 artifact 的 descriptor 不可改变，资源版本不能回退，相同资源版本的内容不能替换。跨进程安装使用文件锁；目录和文件拒绝符号链接。目录中的发布记录仍保留完整签名，运行时重新验证，不仅信任安装时的检查结果。单包上限 24 MiB，单 artifact 的资源原始包总量上限 64 MiB。

## 原生行为与边界

仅 `wanx-host` 的当前本地会话可调用以下三个 POST。应用子会话不能用它们扩大权限。

- `/api/platform/applications/prepare`：协议 1 的 artifact 资源准备。
- `/api/platform/applications/candidates/prepare`：协议 2 的幂等 candidate 准备。
- `/api/platform/applications/readiness`：只读检查当前资源内容、私有所有者和绑定。

请求携带 artifact ID；原生端从可信目录独立读取已签名依赖。请求中的 compatibility 必须与签名 descriptor 精确一致。返回的 `bindingScope` 是：

```json
{
  "schemaVersion": 2,
  "authorization": "local-trust-v1",
  "boxKeyThumbprint": "pinned-box-public-key-thumbprint",
  "principalId": "local-principal-id",
  "deviceId": "box-id",
  "ownershipEpoch": 1,
  "artifactId": "immutable-artifact-uuid"
}
```

绑定不包含云 accountId。专家由真实 AgentManager 创建，内容通过 BackendWorkspace 写入；技能包属于该本地 UID，不能复用其他用户的全局包。相同签名资源可在前端版本更新后继续使用；发布格式中旧名 `expertInstanceScope: "account"` 在本地模式中仅表示当前独立 principal。内容漂移时返回 `RESOURCE_USER_MODIFIED`，不会覆盖用户修改。每 principal 的准备使用跨进程锁，等待期间也持续复核授权；每进程最多 4 个准备或检查操作。

桌面 root 和应用 channel 最长 300 秒。root 到期前重新建立所有当前 launch 的独立会话，逐一检查原有 namespace、binding revision 和权限上限，再原子切换稳定 Host wrapper。旧流关闭，SDK 可重连，应用进程保持运行。锁定、撤销或权限变化会终止会话。为容纳服务端每 binding 32 个 channel 的新旧切换批次，桌面最多同时维持 14 个应用 launch。

## 本地验证

```sh
uv run --no-sync pytest tests/unit/applications/test_local_resources.py -q
node --test wanx-client/tests/device-trust-data-session.test.mjs wanx-client/tests/resource-dependencies-v3.test.mjs
```

原生测试使用合成发布密钥，通过实际安装 CLI、SQLite、AgentManager 和 BackendWorkspace 验证资源准备，仅替代模型启动以避免 LLM 请求。桌面测试使用真实临时 HTTPS、证书 pin、Host SDK、HTTP 和 WebSocket，验证无云登录、独立应用会话、续期、锁定、上传上限及私有 scope。
