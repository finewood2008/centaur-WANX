"""Run with the WANX bundled Python. Tests never access user memory data."""

import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import UploadFile

from octop.api.routers import memory_portable as module


class PortableScope(unittest.IsolatedAsyncioTestCase):
    def test_actual_storage_path_and_namespace(self):
        server = SimpleNamespace(services=SimpleNamespace(config=object()))
        with (
            patch.object(
                module, "resolve_agent_workspace_dir", return_value=Path("/private/workspace")
            ),
            patch.object(module, "_agent_config_dict", return_value={}),
            patch.object(
                module,
                "open_memory_kwargs",
                return_value=(
                    "agent_Test-4",
                    "sqlite",
                    {"db_path": "/private/workspace/.octop/memory.sqlite"},
                ),
            ),
        ):
            self.assertEqual(
                module._portable_store(server, "Test-4"),
                (Path("/private/workspace/.octop/memory.sqlite"), "agent_test_4"),
            )

    async def test_import_ignores_foreign_host_namespace_and_targets_owned_database(self):
        result = SimpleNamespace(to_dict=lambda: {"applied": 1})
        with tempfile.TemporaryDirectory() as tmp:
            owned = Path(tmp) / ".octop" / "memory.sqlite"
            with (
                patch.object(module, "require_agent_owner_row") as owner,
                patch.object(module, "_refuse_postgres_portable"),
                patch.object(module, "_portable_store", return_value=(owned, "agent_test_4")),
                patch(
                    "octop_memory.operations.migration.portable.adopt", return_value=result
                ) as adopt,
            ):
                await module.adopt_agent_memory(
                    "Test-4",
                    UploadFile(filename="test.hmpkg", file=io.BytesIO(b"fixture")),
                    target_host="hermes",
                    target_namespace="foreign",
                    on_conflict="skip",
                    host_rewrite="keep",
                    dry_run=True,
                    user="own-user",
                    server="server",
                    as_user=None,
                )
                self.assertEqual(owner.call_args.args, ("Test-4",))
                self.assertEqual(adopt.call_args.args[1], "agent")
                self.assertEqual(adopt.call_args.kwargs["target_namespace"], "agent_test_4")
                self.assertEqual(adopt.call_args.kwargs["target_db_path"], owned)
                self.assertTrue(adopt.call_args.kwargs["dry_run"])
                self.assertFalse(owned.exists())

    async def test_diagnostics_use_owned_normalized_namespace(self):
        result = SimpleNamespace(to_dict=lambda: {"checks": [], "all_passed": True})
        with (
            patch.object(module, "require_agent_owner_row"),
            patch.object(module, "_refuse_postgres_portable"),
            patch.object(
                module,
                "_portable_store",
                return_value=(Path("/private/.octop/memory.sqlite"), "agent_test_4"),
            ),
            patch(
                "octop_memory.operations.migration.portable.doctor", return_value=result
            ) as doctor,
        ):
            await module.doctor_agent_memory(
                "Test-4",
                host_spec="agent:foreign",
                compare_pkg=None,
                user="own-user",
                server="server",
                as_user=None,
            )
            self.assertEqual(doctor.call_args.args[0], "agent:agent_test_4")
            self.assertEqual(doctor.call_args.kwargs["db_path"], "/private/.octop/memory.sqlite")

    def test_postgres_cannot_be_treated_as_a_sqlite_file(self):
        server = SimpleNamespace(services=SimpleNamespace(config=object()))
        with (
            patch.object(module, "resolve_agent_workspace_dir", return_value=Path("/private")),
            patch.object(module, "_agent_config_dict", return_value={}),
            patch.object(module, "open_memory_kwargs", return_value=("agent_t", "postgres", {})),
            self.assertRaises(module.OctopError),
        ):
            module._portable_store(server, "t")


if __name__ == "__main__":
    unittest.main()
