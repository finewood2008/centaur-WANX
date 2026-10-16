"""Resource import/export contract and sensitive-file boundaries."""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1] / "package-resources.py"
SPEC = importlib.util.spec_from_file_location("package_resources", TOOL)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def spec(kind="expert", identity="test-expert"):
    return {
        "schemaVersion": 1,
        "kind": kind,
        "resourceId": identity,
        "version": "1.0.0",
        "name": "测试专家",
        "description": "",
        "dependencies": [],
        "metadata": {},
    }


def package():
    return {**spec(), "files": [{"path": "AGENTS.md", "contentBase64": "aGk="}]}


class PackageResourcesTests(unittest.TestCase):
    def test_library_complete_manifest_and_binary_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("default", "first"):
                source = root / name
                (source / "skills/example/assets").mkdir(parents=True)
                (source / "manifest.json").write_text(
                    json.dumps({"id": name, "label": {"zh": "名字"}})
                )
                (source / "skills/example/SKILL.md").write_text("---\nname: example\n---\n")
                (source / "skills/example/assets/data.bin").write_bytes(b"\x00\xff\x01")
                (source / "AGENTS.md").write_text("Instruction text is data")
                (source / "__pycache__").mkdir()
                (source / "__pycache__/example.pyc").write_bytes(b"cache")
            built = module.library_packages(root, "1.0.0")
            self.assertEqual(len(built), 1)
            self.assertEqual(built[0]["resourceId"], "octop-first")
            files = {
                entry["path"]: base64.b64decode(entry["contentBase64"])
                for entry in built[0]["files"]
            }
            self.assertEqual(files["skills/example/assets/data.bin"], b"\x00\xff\x01")
            self.assertIn("manifest.json", files)
            self.assertNotIn("__pycache__/example.pyc", files)
            self.assertEqual(len(module.library_packages(root, "1.0.0", True)), 2)

    def test_split_skills_are_source_qualified_and_do_not_remove_embedded_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ("first", "second"):
                source = root / name
                (source / "skills/same").mkdir(parents=True)
                (source / "manifest.json").write_text(json.dumps({"id": name}))
                (source / "skills/same/SKILL.md").write_text(name)
            built = module.library_packages(root, "1.0.0", split_skills=True)
            self.assertEqual(
                {entry["resourceId"] for entry in built},
                {"octop-first", "octop-second", "octop-first-same", "octop-second-same"},
            )
            self.assertTrue(
                all(
                    any(file["path"] == "skills/same/SKILL.md" for file in entry["files"])
                    for entry in built
                )
            )

    def test_custom_explicit_file_list_does_not_read_other_workspace_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "AGENTS.md").write_text("safe template")
            (root / "SOUL.md").write_text("safe persona")
            (root / ".env").write_text("TOKEN=private")
            result = module.build_package(
                root, spec(), ["AGENTS.md", "SOUL.md"], "explicit-template-files"
            )
            self.assertEqual([item["path"] for item in result["files"]], ["AGENTS.md", "SOUL.md"])
            self.assertIsNone(result["metadata"]["provenance"]["gitCommit"])
            self.assertIsNone(result["metadata"]["provenance"]["dirty"])

    def test_custom_rejects_runtime_and_credentials_paths(self):
        for path in (
            ".env",
            "skills/foo/.env.example",
            "credentials.json",
            "sessions/current.json",
            "memory/a.md",
            ".octop/manifest.json",
            "id_rsa",
            "cert.pfx",
            "history/chat.json",
            "local.sqlite3",
        ):
            with self.subTest(path=path), self.assertRaises(module.PackageError):
                module.template_path(path)
        for path in ("AGENTS.md", "SOUL.md", "skills/foo/references/memory.md"):
            self.assertEqual(module.template_path(path), path)

    def test_no_symlink_or_private_key_contents(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "not-secret.md").write_text("-----BEGIN OPENSSH PRIVATE KEY-----\nprivate")
            with self.assertRaises(module.PackageError):
                module.build_package(root, spec(), ["not-secret.md"], "custom")
            if os.name != "nt":
                (root / "link.md").symlink_to(root / "not-secret.md")
                with self.assertRaises(module.PackageError):
                    module.build_package(root, spec(), ["link.md"], "custom")

    def test_metadata_reports_real_dirty_and_content_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            commands = (
                ["init", "-q"],
                ["config", "user.email", "test@example.invalid"],
                ["config", "user.name", "Resource Test"],
            )
            for command in commands:
                subprocess.run(["git", "-C", str(root), *command], check=True, capture_output=True)
            (root / "AGENTS.md").write_text("v1")
            subprocess.run(
                ["git", "-C", str(root), "add", "AGENTS.md"], check=True, capture_output=True
            )
            subprocess.run(
                ["git", "-C", str(root), "commit", "-qm", "fixture", "--no-verify"],
                check=True,
                capture_output=True,
            )
            clean = module.build_package(root, spec(), ["AGENTS.md"], "custom")
            self.assertFalse(clean["metadata"]["provenance"]["dirty"])
            (root / "AGENTS.md").write_text("v2")
            dirty = module.build_package(root, spec(), ["AGENTS.md"], "custom")
            self.assertTrue(dirty["metadata"]["provenance"]["dirty"])
            self.assertEqual(
                clean["metadata"]["provenance"]["gitCommit"],
                dirty["metadata"]["provenance"]["gitCommit"],
            )
            self.assertNotEqual(
                clean["metadata"]["provenance"]["contentSha256"],
                dirty["metadata"]["provenance"]["contentSha256"],
            )

    def test_contract_rejects_unknown_fields_ranges_optional_and_float(self):
        for mutate in (
            lambda p: p.update(unknown=True),
            lambda p: p.update(schemaVersion=True),
            lambda p: p.update(version="1.0.0-beta.1"),
            lambda p: p.update(
                dependencies=[{"kind": "expert", "resourceId": "other", "minVersion": ">=1.0.0"}]
            ),
            lambda p: p.update(
                dependencies=[
                    {
                        "kind": "expert",
                        "resourceId": "other",
                        "minVersion": "1.0.0",
                        "optional": True,
                    }
                ]
            ),
            lambda p: p.update(metadata={"value": 1.5}),
            lambda p: p.update(metadata={"value": 9007199254740992}),
        ):
            candidate = package()
            mutate(candidate)
            with self.assertRaises(module.PackageError):
                module.validate(candidate)

    def test_paths_duplicate_casefold_parent_and_base64(self):
        for path in (
            "../bad",
            "/bad",
            "a\\b",
            "a//b",
            "aux.txt",
            "a.",
            "a:b",
            "e\u0301.md",
            "a" * 256,
        ):
            with self.subTest(path=path), self.assertRaises(module.PackageError):
                module.safe_path(path)
        candidate = package()
        for addition in (
            {"path": "agents.MD", "contentBase64": "aGk="},
            {"path": "AGENTS.md/sub", "contentBase64": "aGk="},
        ):
            with self.assertRaises(module.PackageError):
                module.validate({**candidate, "files": [*candidate["files"], addition]})
        with self.assertRaises(module.PackageError):
            module.validate({**candidate, "files": [{"path": "file", "contentBase64": "aGk"}]})

    def test_immutable_output_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "resource.json"
            module.emit(output, b"a")
            module.emit(output, b"a")
            with self.assertRaises(module.PackageError):
                module.emit(output, b"b")

    def test_upload_uses_only_draft_endpoint_and_validates_response(self):
        candidate = package()
        receipt = {**module.validate(candidate), "status": "draft"}
        body = json.dumps({"code": 200, "success": True, "data": receipt}).encode()
        requests = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return None

            def read(self, _limit):
                return body

        class Opener:
            def open(self, request, timeout):
                requests.append(request)
                return Response()

        with tempfile.TemporaryDirectory() as temporary:
            token_file = Path(temporary) / "token"
            token_file.write_text("private-token")
            token_file.chmod(0o600)
            with patch.object(module.urllib.request, "build_opener", return_value=Opener()):
                result = module.upload_draft(
                    candidate, "https://admin.example/prod-api", token_file
                )
            self.assertEqual(result["status"], "draft")
            self.assertNotIn("private-token", json.dumps(result))
            self.assertEqual(
                requests[0].full_url, "https://admin.example/prod-api/nexus/resources/versions"
            )
            self.assertEqual(requests[0].data, module.canonical(candidate))
            for url in (
                "http://admin.example",
                "https://secret:pass@admin.example",
                "https://admin.example/?token=secret",
            ):
                with self.assertRaises(module.PackageError):
                    module.upload_draft(candidate, url, token_file)

    def test_actual_bundled_library_all_packages_validate(self):
        packages = module.library_packages(module.LIBRARY, "1.0.0")
        expected = [
            directory
            for directory in module.LIBRARY.iterdir()
            if (directory / "manifest.json").is_file() and directory.name != "default"
        ]
        self.assertEqual(len(packages), len(expected))
        for item in packages:
            receipt = module.validate(item)
            self.assertGreater(receipt["files"], 0)
            self.assertIn("manifest.json", {entry["path"] for entry in item["files"]})
            self.assertNotEqual(item["resourceId"], "octop-default")
            self.assertEqual(len(item["metadata"]["provenance"]["contentSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
