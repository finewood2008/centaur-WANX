"""Synthetic real Bridge authority + real OS BLE engine, simulated physical Wi-Fi.

The private keys returned by metadata are generated for this disposable test only.
No production files, network interfaces, account or cloud API are used.
"""
import base64
import importlib.machinery
import importlib.util
import json
import traceback
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

os_repo = Path(sys.argv[1])
wanx_repo = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(wanx_repo / 'wanx-bridge'), str(wanx_repo / 'wanx-bridge/tests')]
from test_local_authority_store import NOW, provisioned
from test_local_ledger import ledger, prepare, commit
from wanx_bridge.local_wifi_authority import LocalWifiAuthority

loader = importlib.machinery.SourceFileLoader('offline_wifi_test_ble', str(os_repo / 'discovery/centauros-provisioning-ble-gatt'))
spec = importlib.util.spec_from_loader(loader.name, loader)
ble = importlib.util.module_from_spec(spec)
loader.exec_module(ble)

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory).resolve()
    supplied = provisioned.__wrapped__(root)
    history = ledger.__wrapped__(supplied)
    state = next(history)
    commit(state, prepare(state, 'network-wifi.authorize', {
        'bindingId': state.root.binding_id, 'expiresAt': None, 'delegable': True,
    }))
    authority = LocalWifiAuthority(state.authority)
    device_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    key_path = root / 'var/lib/centauros/device/device-key.pem'
    key_path.parent.mkdir(parents=True)
    key_path.write_bytes(device_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_path.chmod(0o600)
    calls, physical, protocol_trace, admissions = [], [], [], []
    original_fail = ble.fail_protocol

    def trace_protocol(*args, **kwargs):
        protocol_trace[:] = [f'{item.name}:{item.lineno}' for item in traceback.extract_stack(limit=7)[:-1]]
        return original_fail(*args, **kwargs)

    ble.fail_protocol = trace_protocol

    class LocalIPC:
        def has_required_policy(self):
            return True

        def policy(self):
            return {'boxId': supplied.bundle['boxId']}

        def call(self, method, body):
            calls.append(method)
            result = getattr(authority, method)(body, NOW + 20)
            if method == 'consume':
                admissions.append(result['execute'])
            return result

    backend = ble.ProvisioningV2Backend('synthetic-wifi-command', directory, clock=time.monotonic)
    backend.local_wifi = LocalIPC()
    backend.runtime_discovery_enabled = True
    backend.discovery_only = True
    original_popen = ble.subprocess.Popen

    def popen(argv, **kwargs):
        if argv[0] != 'synthetic-wifi-command':
            return original_popen(argv, **kwargs)
        assert admissions == [True]
        assert kwargs['env']['CENTAURUS_WIFI_SESSION_AUTHORITY'] == 'local-wifi-v1'
        physical.append(argv)
        return SimpleNamespace(communicate=lambda _: (b'ok', b''), returncode=0, poll=lambda: 0)

    def forbidden(*_args, **_kwargs):
        raise AssertionError('offline flow attempted cloud ownership or device attestation')

    def private(key):
        return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()

    with patch.object(ble.subprocess, 'Popen', side_effect=popen), patch.object(backend, '_owner_snapshot', side_effect=forbidden), \
         patch.object(backend, 'device_info_object', side_effect=forbidden), patch.object(backend, '_first_claim_eligible', side_effect=forbidden):
        for line in sys.stdin:
            try:
                message = json.loads(line)
                if message['op'] == 'metadata':
                    value = {'descriptor': {key: supplied.bundle[key] for key in ('boxId', 'boxKey', 'baseUrl', 'tlsSpkiSha256')},
                             'clientId': state.root.payload['clientId'], 'principalId': state.root.payload['principalId'],
                             'bindingId': state.root.binding_id, 'ownershipEpoch': 1,
                             'accessPrivateKey': private(state.root.access), 'approvalPrivateKey': private(state.root.approval)}
                elif message['op'] == 'request':
                    raw = backend.handle_logical_frame(base64.b64decode(message['frame']), 'synthetic-central')
                    value = base64.b64encode(raw).decode()
                elif message['op'] == 'close':
                    backend.drop_connection('synthetic-central')
                    value = None
                elif message['op'] == 'revoke':
                    commit(state, prepare(state, 'network-wifi.revoke', {'bindingId': state.root.binding_id}, now=NOW + 20), now=NOW + 20)
                    value = None
                elif message['op'] == 'stats':
                    value = {'physicalApplyCount': len(physical), 'authorityCalls': calls, 'protocolTrace': protocol_trace,
                             'proofRecordExists': (root / 'var/lib/centauros/provisioning/device-proof-retry').exists()}
                else:
                    raise ValueError('unknown test operation')
                print(json.dumps({'ok': True, 'value': value}), flush=True)
            except Exception as exc:
                print(json.dumps({'ok': False, 'error': str(exc)}), flush=True)
    history.close()
