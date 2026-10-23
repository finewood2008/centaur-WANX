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
    ('    tokens = settings.application_tokens()\n    credentials = tokens or',
     '''    # Standalone may run without bridge credentials; only its integration
    # surface needs them. Never accept a weak or partially configured principal.
    if (len(settings.integration_service_token.get_secret_value()) < 32
            or not settings.integration_box_id.strip()
            or not settings.integration_application_id.strip()):
        raise PermissionError("integration credentials are not configured correctly")
    try:
        tokens = settings.application_tokens()
    except ValueError as exc:
        raise PermissionError("integration credentials are not configured correctly") from exc
    credentials = tokens or'''),
    ('"""Authenticate before MCP dispatch and prevent native REST authorization bypass."""',
     '"""Authenticate integration in both modes; gate native REST/MCP only in managed."""'),
    ('        if scope["type"] != "http" or self.settings.integration_mode != "managed":\n',
     '''        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        managed = self.settings.integration_mode == "managed"
        if self.surface == "mcp" and not managed:
'''),
    ('        if self.surface == "workbench" and not path.startswith("/api/integration/"):\n',
     '''        if self.surface == "workbench" and not path.startswith("/api/integration/"):
            if not managed:
                return await self.app(scope, receive, send)
'''),
    ('# All managed operations are bounded JSON envelopes;',
     '# All integration operations are bounded JSON envelopes;'),
])
edit('app/main.py', [
    ('''            processing_readiness = None
            if settings.integration_mode == "managed":
                processing_readiness = ManagedProcessingReadiness(app.state)
                app.state.processing_readiness = processing_readiness
                processing_readiness.start()''',
     '''            processing_readiness = ManagedProcessingReadiness(app.state)
            app.state.processing_readiness = processing_readiness
            processing_readiness.start()'''),
    ('''                if processing_readiness is not None:
                    processing_readiness.stop()''', '                processing_readiness.stop()'),
])
edit('app/config.py', [('wanx_model_url: str = "http://127.0.0.1:8089"',
                        'wanx_model_url: str = "http://127.0.0.1:18089"')])
edit('app/services/managed_readiness.py', [
    ('Cached managed processing preparation, separate from production qualification.',
     'Cached integration processing preparation in standalone and managed modes.'),
])
edit('.env.example', [('APP_PORT=8090\n', '''APP_PORT=8090
# Optional trusted WANX integration, also supported in standalone mode.
# Native workbench and standalone MCP do not require these credentials.
# Match the bridge's existing Semantica service token (at least 32 random
# characters), box_id and application_id. Never expose the token to Electron.
INTEGRATION_MODE=standalone
INTEGRATION_SERVICE_TOKEN=
INTEGRATION_BOX_ID=
INTEGRATION_APPLICATION_ID=
# WANX private model relay, in the same host/network namespace.
# Existing explicit overrides are preserved; this is not the public API port.
WANX_MODEL_URL=http://127.0.0.1:18089
''')])
edit('README.md', [('## 进入开发终端', '''## STARLINK 经万象接入 standalone

调用链为 `STARLINK → 万象 bridge → Semantica`。无需改为 managed：
`/api/integration/*` 在两种部署模式下均验证万象服务签名，并建立账号、数据仓和操作上下文；
用户登录及业务权限仍由万象管理。原生工作台及 standalone MCP 保留原有访问方式。
开放 `/api/open/v1/*` 沿用知识 Key 校验，并统一拒绝浏览器 Origin、限制请求体为 128 KiB、禁止响应缓存。

接入时复用现有 `INTEGRATION_SERVICE_TOKEN`（至少 32 字符的随机密钥）、
`INTEGRATION_BOX_ID`、`INTEGRATION_APPLICATION_ID`，与 bridge 的配置保持一致。
未配置时仍可独立使用原生工作台，集成请求返回 401；错误配置不会降级为匿名集成访问。
密钥只在服务之间使用，不交给 Electron，也不要求用户再次登录 Semantica。
这是集成身份校验，不会使保留开放的 standalone 原生端口变成用户权限网关；桌面业务仍应走万象入口。

模型回调默认使用 `WANX_MODEL_URL=http://127.0.0.1:18089`，对应 bridge 的私有
`/internal/starklink/models` 接口；既有显式 URL 配置优先。两服务需共享该回环地址所在的网络命名空间。
代码更新后重启后端进程生效；本次不自动改写实例 `.env`、密钥或已有模型配置。

standalone 也启动处理能力监测，`processing_checks` 返回真实缓存的依赖状态及 worker 状态。
`embedding_prepared` 沿用本地模型清单与文件检查，远程 embedding 不据此宣称就绪；
模型 API 配置完整不代表实际推理已验证。健康接口可用也不等于 `processing_ready` 或 `production_ready`。
监测不下载模型、不执行推理，图数据库使用有超时的只读常量查询。

## 进入开发终端''')])
originals['tests/test_standalone_integration.py'] = None
(stage / 'originals.json').write_text(json.dumps(originals, indent=2), encoding='utf-8')
print('Prepared', len(originals), 'files; Semantica source unchanged.')
