"""Verify the running standalone metadata endpoints without shared credentials."""
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'wanx-bridge'))
from wanx_bridge.semantica.desktop import DesktopConfig

origin = 'http://127.0.0.1:8090'
config = DesktopConfig(origin, '', 'restart-probe-box', 'semantica')
headers = config.headers(1, 'wanx')
assert set(headers) == {'x-semantica-scope'}
encoded = headers['x-semantica-scope']
claims = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
claims['expires_at'] = 1
expired = {'x-semantica-scope': base64.urlsafe_b64encode(
    json.dumps(claims).encode()).decode().rstrip('=')}
cases = [
    ('live', '/api/health/live', {}, 200),
    ('ready', '/api/health/ready', {}, 200),
    ('native_settings', '/api/settings/status', {}, 200),
    ('unsigned_status', '/api/integration/status', headers, 200),
    ('unsigned_capabilities', '/api/integration/capabilities', headers, 200),
    ('missing_context', '/api/integration/status', {}, 400),
    ('expired_context', '/api/integration/status', expired, 400),
    ('browser_origin', '/api/integration/status', {**headers, 'Origin': 'null'}, 403),
]
results = []
with httpx.Client(trust_env=False, follow_redirects=False, timeout=10) as client:
    for name, path, request_headers, expected in cases:
        response = client.get(origin + path, headers=request_headers)
        data = response.json()
        public = {key: data[key] for key in (
            'status', 'version', 'integration_mode', 'mcp_authentication', 'managed',
            'processing_ready', 'processing_checks', 'production_ready', 'ocr_ready', 'detail'
        ) if key in data}
        passed = response.status_code == expected
        if name == 'native_settings':
            passed = passed and data.get('integration_mode') == 'standalone'
        if name == 'unsigned_capabilities':
            passed = passed and data.get('managed') is False and isinstance(data.get('processing_checks'), dict)
        results.append({'check': name, 'http_status': response.status_code,
                        'expected': expected, 'passed': passed, 'metadata': public})
report = {'checked_at': datetime.now(timezone.utc).isoformat(),
          'origin': origin, 'shared_credentials_used': False,
          'synthetic_context_metadata_only': True, 'checks': results}
output = Path(__file__).with_name('unsigned-live-report.json')
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=True, indent=2))
sys.exit(0 if all(row['passed'] for row in results) else 1)
