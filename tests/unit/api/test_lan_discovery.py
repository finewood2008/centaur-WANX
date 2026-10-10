import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from octop.api.lan_discovery import mount_lan_discovery


class DiscoveryTests(unittest.TestCase):
    def test_identity_survives_restart_and_contains_no_account_or_workspace(self):
        with (
            tempfile.TemporaryDirectory() as root,
            patch.dict(os.environ, {"WANX_LAN_DISCOVERY": "0"}),
        ):
            server = SimpleNamespace(paths=SimpleNamespace(config=Path(root) / "config.json"))
            identities = []
            for _ in range(2):
                app = FastAPI()
                mount_lan_discovery(app, server)
                app.state.wanx_lan_endpoint = ("0.0.0.0", 8088, False)
                with TestClient(app) as client:
                    r = client.get("/.well-known/wanx")
                    self.assertEqual(r.status_code, 200)
                    identities.append(r.json())
            self.assertEqual(identities[0]["serverId"], identities[1]["serverId"])
            self.assertEqual(
                set(identities[0]),
                {"product", "protocol", "serverId", "name", "version", "capabilities"},
            )


if __name__ == "__main__":
    unittest.main()
