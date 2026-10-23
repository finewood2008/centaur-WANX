import hashlib
import json
from pathlib import Path

source = Path('D:/项目文件/semantica')
stage = Path(__file__).resolve().parent
originals = {}


def edit(name, changes):
    path = source / name
    originals[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    content = path.read_text(encoding='utf-8')
    for old, new in changes:
        assert content.count(old) == 1, (name, old)
        content = content.replace(old, new)
    target = stage / 'files' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content.replace('\n', '\r\n').encode('utf-8'))


edit('app/integration/auth.py', [
    ('"""Short-lived service-signed resource grants, independent of MCP tool arguments."""',
     '"""WANX resource contexts; service signatures remain required only in managed mode."""'),
    ('\ndef authenticate(headers: Headers, settings: Settings) -> IntegrationScope:', '''
def read_context(headers: Headers) -> IntegrationScope:
    """Parse WANX-owned routing context, not a user authentication mechanism.

    Standalone integration must be reachable only by the trusted WANX backend.
    Keep resource binding, request lifetime and operation checks in both modes.
    """
    encoded = headers.get("x-semantica-scope", "")
    if len(headers.getlist("x-semantica-scope")) != 1 or not encoded or len(encoded) > 8192:
        raise PermissionError("WANX request context is required")
    try:
        claims = IntegrationScope.model_validate_json(base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
    except (ValueError, ValidationError) as exc:
        raise PermissionError("invalid WANX request context") from exc
    if not time.time() < claims.expires_at <= time.time() + 300:
        raise PermissionError("request context expiration is invalid")
    claims.validate_bindings()
    return claims


def authenticate(headers: Headers, settings: Settings) -> IntegrationScope:'''),
    ('''    try:
        claims = IntegrationScope.model_validate_json(base64.b64decode(
            encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True))
    except (ValueError, ValidationError) as exc:
        raise PermissionError("invalid signed scope") from exc''',
     '    claims = read_context(headers)'),
    ('"""Authenticate integration in both modes; gate native REST/MCP only in managed."""',
     '"""Accept WANX context in standalone; authenticate signed grants in managed."""'),
    ('            grant = authenticate(headers, self.settings)',
     '            grant = authenticate(headers, self.settings) if managed else read_context(headers)'),
    ('return await JSONResponse({"detail": str(exc)}, 401)(scope, receive, send)',
     'return await JSONResponse({"detail": str(exc)}, 401 if managed else 400)(scope, receive, send)'),
    ('"authorization", "x-semantica-scope", "x-semantica-signature")})',
     '"authorization", "x-semantica-scope", "x-semantica-signature") if key in headers})'),
])
edit('app/services/processing_models.py', [
    ('        secret = self.settings.integration_service_token.get_secret_value()\n', ''),
    ('''        signature = hmac.new(
            secret.encode(),
            stamp.encode() + b"." + nonce.encode() + b"." + raw,
            hashlib.sha256,
        ).hexdigest()
''', ''),
    ('            "x-starklink-signature": signature,\n', ''),
    ('''        request = httpx.Request(
            "POST",
            self.base + "/internal/starklink/models",''', '''        if self.settings.integration_mode == "managed":
            secret = self.settings.integration_service_token.get_secret_value()
            headers["x-starklink-signature"] = hmac.new(
                secret.encode(), stamp.encode() + b"." + nonce.encode() + b"." + raw,
                hashlib.sha256,
            ).hexdigest()
        request = httpx.Request(
            "POST",
            self.base + "/internal/starklink/models",'''),
])
edit('.env.example', [('''# Optional trusted WANX integration, also supported in standalone mode.
# Native workbench and standalone MCP do not require these credentials.
# Match the bridge's existing Semantica service token (at least 32 random
# characters), box_id and application_id. Never expose the token to Electron.
INTEGRATION_MODE=standalone
INTEGRATION_SERVICE_TOKEN=
INTEGRATION_BOX_ID=
INTEGRATION_APPLICATION_ID=
''', '''# WANX owns authentication in standalone mode. Its private backend sends the
# account/warehouse context; no shared service token or identity sync is needed.
# Keep /api/integration/* reachable only by the trusted WANX backend.
INTEGRATION_MODE=standalone
# Legacy managed deployments still require INTEGRATION_SERVICE_TOKEN,
# INTEGRATION_BOX_ID and INTEGRATION_APPLICATION_ID; standalone ignores them.
''')])
old_readme = source.joinpath('README.md').read_text(encoding='utf-8')
start = old_readme.index('## STARLINK 经万象接入 standalone')
end = old_readme.index('## 进入开发终端', start)
edit('README.md', [(old_readme[start:end], '''## STARLINK 经万象接入 standalone

调用链为 `STARLINK → 万象 bridge → Semantica`。standalone 不校验服务 Bearer 或 HMAC 签名，
也不要求配置 `INTEGRATION_SERVICE_TOKEN`、`INTEGRATION_BOX_ID`、`INTEGRATION_APPLICATION_ID`。
用户登录、应用准入、账号权限与撤权检查由万象负责。bridge 校验会话后构造
`X-Semantica-Scope` 上下文，客户端提供的身份头不能透传。

`/api/integration/*` 仍需要包含账号、盒子、应用、数据仓、读写操作及有效期的上下文，
用于数据路由、归属检查和幂等控制；缺失或格式无效返回 400，不会回退到共享默认仓。
Semantica 不再与本地配置比对 box/application，也不会验签，因此这些集成接口必须只对可信
万象后端可达，不能直接暴露给不可信客户端。原生工作台及 standalone MCP 保留原有访问方式。
开放 `/api/open/v1/*` 仍验证知识 Key 的范围、有效期与撤销状态，这不是万象服务密钥。
显式使用 managed 的旧部署继续执行原有服务签名验证。

新部署由 bridge 使用万象现有 device ID、固定 `semantica` 应用命名空间及已验证用户 ID
构造上下文，无需单独创建 `semantica.json`。已有该文件的部署继续使用原有 box/application
标识，避免改变数据归属；无需再将它们复制到 Semantica `.env`。旧文件中的有效服务密钥
只用于兼容 managed 调用，不是 standalone 接入的前提。

模型回调默认使用 `WANX_MODEL_URL=http://127.0.0.1:18089`，对应 bridge 私有
`/internal/starklink/models`，两服务共享该回环地址所在的网络命名空间。
standalone 回调不签名，保留时间戳与 nonce；bridge 检查回环来源、当前用户权限、任务与
模型快照，并拒绝重放。已有显式 URL 配置优先；更新两端代码后重启各自服务生效。
本次不改写实例 `.env`、既有数据身份或已保存模型配置。

standalone 也启动处理能力监测，`processing_checks` 返回真实缓存的依赖状态及 worker 状态。
`embedding_prepared` 沿用本地模型清单与文件检查，远程 embedding 不据此宣称就绪；
模型 API 配置完整不代表实际推理已验证。健康接口可用也不等于 `processing_ready` 或 `production_ready`。
监测不下载模型、不执行推理，图数据库使用有超时的只读常量查询。

''')])
edit('tests/test_standalone_integration.py', [
    ('import asyncio\n', 'import asyncio\nimport base64\nimport json\n'),
    ('from unittest.mock import patch', 'from unittest.mock import patch'),
    ('class StandaloneMiddlewareTests', '''def context_headers(self, **changes):
    encoded = base64.urlsafe_b64encode(json.dumps(
        {**self.claims, **changes}, separators=(",", ":"), sort_keys=True
    ).encode()).decode().rstrip("=")
    return {"X-Semantica-Scope": encoded}


class StandaloneMiddlewareTests'''),
    ('        self.settings.integration_mode = "standalone"\n\n    headers = managed.ScopeTests.headers',
     '        self.settings = Settings(_env_file=None, integration_mode="standalone")\n\n    headers = context_headers'),
    ('"signed": bool(request_auth_headers.get().get("x-semantica-signature"))',
     '"context": bool(request_auth_headers.get().get("x-semantica-scope"))'),
    ('[{"actor": "actor-a", "signed": True}, {"actor": "actor-b", "signed": True}]',
     '[{"actor": "actor-a", "context": True}, {"actor": "actor-b", "context": True}]'),
    ('test_unconfigured_or_invalid_credentials_do_not_break_native_access',
     'test_standalone_context_needs_no_valid_local_credentials'),
    ('                self.assertEqual(result.status_code, 401)', '''                self.assertEqual(result.status_code, 400)
                result = await client.get("/api/integration/status", headers=self.headers())
                self.assertEqual(result.status_code, 200)'''),
    ('self.assertEqual((await client.get("/api/integration/status")).status_code, 401)',
     'self.assertEqual((await client.get("/api/integration/status")).status_code, 400)'),
    ('        self.settings.integration_mode = "standalone"\n        self.settings.mcp_host = "0.0.0.0"',
     '        self.settings = Settings(_env_file=None, integration_mode="standalone", mcp_host="0.0.0.0")'),
    ('    headers = managed.ScopeTests.headers\n    tool =', '    headers = context_headers\n    tool ='),
    ('self.assertEqual(self.client.get("/api/integration/status").status_code, 401)',
     'self.assertEqual(self.client.get("/api/integration/status").status_code, 400)'),
    ('((self.headers(expires_at=1), 401),\n                                ({**self.headers(), "X-Semantica-Signature": "invalid"}, 401),',
     '((self.headers(expires_at=1), 400),\n                                ({"X-Semantica-Scope": "invalid"}, 400),'),
    ('        self.assertFalse(self.settings.public_status()["mcp_authentication"])', '''        self.assertFalse(self.settings.public_status()["mcp_authentication"])
        # Even obsolete/mismatched service credentials do not control standalone.
        headers = {**self.headers(), "Authorization": "Bearer obsolete", "X-Semantica-Signature": "invalid"}
        self.assertEqual(self.client.get("/api/integration/status", headers=headers).status_code, 200)

    def test_standalone_model_callback_has_no_shared_secret(self):
        owner = json.dumps(["box-a", "omnia", "wanx:7"])
        with patch("app.services.processing_models.httpx.Client") as client:
            sender = client.return_value.__enter__.return_value.send
            sender.return_value = httpx.Response(200, json={"items": []})
            self.assertEqual(self.app.state.processing_models.relay("catalog", owner), {"items": []})
        request = sender.call_args.args[0]
        self.assertNotIn("authorization", request.headers)
        self.assertNotIn("x-starklink-signature", request.headers)
        self.assertEqual(len(request.headers["x-starklink-nonce"]), 32)
        self.assertTrue(request.headers["x-starklink-time"].isdigit())
        self.assertEqual(json.loads(request.content)["owner"], owner)'''),
])
(stage / 'originals.json').write_text(json.dumps(originals, indent=2), encoding='utf-8')
print('Prepared', len(originals), 'Semantica files; original source unchanged.')
