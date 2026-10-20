"""Read-only restart diagnostics; never print credentials or business data."""
import json
import os
from pathlib import Path
import socket
from urllib.parse import urlsplit

from dotenv import dotenv_values
import httpx

root = Path('D:/项目文件/semantica')
values = {key.casefold(): value for key, value in dotenv_values(
    root / '.env', encoding='utf-8-sig', interpolate=False).items()}
configuration = {}
for key in ('integration_service_token', 'integration_box_id', 'integration_application_id'):
    value = values.get(key) or ''
    configuration[key] = ('missing' if not value.strip() else
                          'too_short' if key.endswith('_token') and len(value) < 32 else 'present')
configuration['integration_application_tokens'] = 'present' if values.get('integration_application_tokens') else 'absent_optional'
override = values.get('wanx_model_url')
try:
    port = urlsplit(override).port if override else None
except ValueError:
    port = 'invalid'
configuration['wanx_model_url_explicit'] = bool(override)
configuration['wanx_model_url_explicit_port'] = port

checks = []
with httpx.Client(trust_env=False, follow_redirects=False, timeout=5) as client:
    for path in ('/api/integration/status', '/api/open/v1/warehouse'):
        result = client.get('http://127.0.0.1:8090' + path, headers={'Origin': 'null'})
        checks.append({'path': path, 'origin_null_status': result.status_code})

ports = {}
for port in (8090, 8091, 8088, 18088, 18089):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=2):
            ports[str(port)] = 'reachable'
    except OSError as exc:
        ports[str(port)] = {'reachable': False, 'error_type': type(exc).__name__}

credential_path = os.environ.get('WANX_BRIDGE_ADMIN_CREDENTIAL_FILE')
bridge = {'admin_credential_path_in_probe_environment': bool(credential_path)}
if credential_path:
    bridge['semantica_config_exists'] = Path(credential_path).with_name('semantica.json').is_file()
report = {'local_env_file_only': configuration, 'running_origin_checks': checks,
          'loopback_default_ports': ports, 'bridge_probe_environment_only': bridge}
Path(__file__).with_name('restarted-diagnostics.json').write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=True, indent=2))
