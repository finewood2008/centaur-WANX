"""Selected upstream imports preserve complete bytes and fail closed on partial archives."""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import stat
import tempfile
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "resource_upstream", Path(__file__).resolve().parents[1] / "resource-upstream.py"
)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def zipped(files):
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as archive:
        for path, content in files.items():
            archive.writestr(path, content)
    return result.getvalue()


def skillset(identifier="workflow", skills=None):
    prompt = b"---\nname: workflow\n---\nComplete workflow"
    manifest = {
        "type": "skillset",
        "slug": identifier,
        "displayName": "Workflow",
        "skillSlugs": skills if skills is not None else ["demo"],
        "files": [
            {
                "path": "identify.md",
                "size": len(prompt),
                "sha256": module.package_tools.digest(prompt),
            }
        ],
    }
    return zipped({"manifest.json": json.dumps(manifest), "identify.md": prompt}), manifest


class FakeFetcher:
    def __init__(self, responses):
        self.responses = responses
        self.receipts = []

    def get(self, url, limit):
        if url not in self.responses:
            raise module.PackageError("missing fixture archive")
        data = self.responses[url]
        self.receipts.append({"url": url, "sha256": module.package_tools.digest(data)})
        return data


class ResourceUpstreamTests(unittest.TestCase):
    def test_single_skill_preserves_binary_and_wrapper(self):
        fetcher = FakeFetcher(
            {
                module.skill_url("demo"): zipped(
                    {
                        "demo/SKILL.md": "# skill",
                        "demo/assets/file.bin": b"\x00\xff\x01",
                    }
                )
            }
        )
        package = module.build(
            source="skill",
            identifier="demo",
            release_version="1.0.0",
            kind="skill-package",
            fetcher=fetcher,
        )
        files = {f["path"]: base64.b64decode(f["contentBase64"]) for f in package["files"]}
        self.assertEqual(files["skills/demo/assets/file.bin"], b"\x00\xff\x01")
        self.assertIsNone(package["metadata"]["provenance"]["gitCommit"])
        self.assertIsNone(package["metadata"]["provenance"]["dirty"])
        self.assertEqual(package["resourceId"], "skillhub-skill-demo")

    def test_skillset_fetches_all_skills_and_preserves_source_manifest(self):
        archive, manifest = skillset(skills=["one", "two"])
        fetcher = FakeFetcher(
            {
                module.skillset_url("workflow"): json.dumps(manifest).encode(),
                module.skillset_url("workflow") + "/download": archive,
                module.skill_url("one"): zipped({"SKILL.md": "one", "assets/a.bin": b"\xff"}),
                module.skill_url("two"): zipped(
                    {"SKILL.md": "two", "scripts/b.py": "print('data only')"}
                ),
            }
        )
        for kind in ("expert", "skill-package"):
            with self.subTest(kind=kind):
                package = module.build(
                    source="skillset",
                    identifier="workflow",
                    release_version="1.0.0",
                    kind=kind,
                    fetcher=fetcher,
                )
                files = {f["path"]: base64.b64decode(f["contentBase64"]) for f in package["files"]}
                self.assertEqual(files["skills/one/assets/a.bin"], b"\xff")
                self.assertIn("skills/two/scripts/b.py", files)
                self.assertEqual(
                    json.loads(files["skills/workflow/source/manifest.json"]), manifest
                )
                self.assertEqual("manifest.json" in files, kind == "expert")
                self.assertTrue(
                    all(p.startswith("skills/") for p in files if kind == "skill-package")
                )

    def test_missing_skill_does_not_emit_partial_output(self):
        archive, manifest = skillset()
        fetcher = FakeFetcher(
            {
                module.skillset_url("workflow"): json.dumps(manifest).encode(),
                module.skillset_url("workflow") + "/download": archive,
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "missing.json"
            with patch.object(module, "Fetcher", return_value=fetcher):
                result = module.main(
                    [
                        "skillset",
                        "--slug",
                        "workflow",
                        "--version",
                        "1.0.0",
                        "--output",
                        str(output),
                    ]
                )
            self.assertEqual(result, 2)
            self.assertFalse(output.exists())

    def test_details_archive_drift_is_rejected(self):
        archive, manifest = skillset()
        fetcher = FakeFetcher(
            {
                module.skillset_url("workflow"): json.dumps(
                    {**manifest, "skillSlugs": ["changed"]}
                ).encode(),
                module.skillset_url("workflow") + "/download": archive,
            }
        )
        with self.assertRaisesRegex(module.PackageError, "changed"):
            module.build(
                source="skillset",
                identifier="workflow",
                release_version="1.0.0",
                kind="expert",
                fetcher=fetcher,
            )

    def test_archive_manifest_hash_and_preview_only_rejected(self):
        for contents in (
            {
                "manifest.json": json.dumps(
                    {"type": "skillset", "slug": "workflow", "skillSlugs": ["demo"]}
                )
            },
            {
                "manifest.json": json.dumps(
                    {
                        "type": "skillset",
                        "slug": "workflow",
                        "skillSlugs": ["demo"],
                        "files": [{"path": "identify.md", "size": 1, "sha256": "0" * 64}],
                    }
                ),
                "identify.md": "x",
            },
        ):
            fetcher = FakeFetcher(
                {
                    module.skillset_url("workflow"): b'{"slug":"workflow"}',
                    module.skillset_url("workflow") + "/download": zipped(contents),
                }
            )
            with self.assertRaises(module.PackageError):
                module.build(
                    source="skillset",
                    identifier="workflow",
                    release_version="1.0.0",
                    kind="expert",
                    fetcher=fetcher,
                )

    def test_offline_skillset_requires_exact_complete_archives_and_never_networks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bundle = root / "set.zip"
            bundle.write_bytes(skillset()[0])
            skill = root / "skill.zip"
            skill.write_bytes(zipped({"SKILL.md": "full", "asset.bin": b"\xff"}))
            with patch.object(module.Fetcher, "get", side_effect=AssertionError("network called")):
                with self.assertRaisesRegex(module.PackageError, "one explicit archive"):
                    module.build(
                        source="skillset",
                        identifier="workflow",
                        release_version="1.0.0",
                        kind="expert",
                        archive=bundle,
                    )
                package = module.build(
                    source="skillset",
                    identifier="workflow",
                    release_version="1.0.0",
                    kind="expert",
                    archive=bundle,
                    skill_archives={"demo": skill},
                )
            self.assertEqual(package["metadata"]["provenance"]["sourceKind"], "skillhub-archive")
            self.assertEqual(len(package["metadata"]["provenance"]["downloads"]), 2)

    def test_unsafe_zip_members_case_duplicates_and_symlinks_rejected(self):
        paths = (
            "../bad",
            "/absolute",
            "a\\b",
            "C:drive",
            "a/.env",
            "a/.octop/state",
            "skills/a/sessions/log",
            "aux.txt",
            "trailing.",
        )
        for path in paths:
            with self.subTest(path=path), self.assertRaises(module.PackageError):
                module.parse_archive(zipped({path: "bad"}))
        for files in (
            {"A": "a", "a": "b"},
            {"a": "a", "a/b": "b"},
            {"key.md": "-----BEGIN PRIVATE KEY-----"},
        ):
            with self.assertRaises(module.PackageError):
                module.parse_archive(zipped(files))
        info = zipfile.ZipInfo("link")
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaises(module.PackageError):
            module.parse_archive(zipped({info: "target"}))

    def test_download_limits_and_redirect_allowlist(self):
        for url in (
            "http://api.skillhub.cn/api/v1/download",
            "https://api.skillhub.cn.evil.test/api/v1/a",
            "https://user:pw@api.skillhub.cn/api/v1/a",
            "https://api.skillhub.cn:443/api/v1/a",
            "https://127.0.0.1/api/v1/a",
            "https://api.skillhub.cn/api/v1/a#bad",
            "https://skillhub-1388575217.cos.accelerate.myqcloud.com/not-skills/file.zip",
        ):
            with self.subTest(url=url), self.assertRaises(module.PackageError):
                module.allowed_url(url)
        with patch.object(module.urllib.request, "getproxies", return_value={}):
            fetcher = module.Fetcher()
        destination = "https://evil.test/private"
        with patch.object(
            fetcher.opener,
            "open",
            side_effect=urllib.error.HTTPError(
                module.skill_url("demo"), 302, "redirect", {"Location": destination}, None
            ),
        ) as request:
            with self.assertRaises(module.PackageError):
                fetcher.get(module.skill_url("demo"), 10)
            self.assertEqual(request.call_count, 1)

        class Response:
            headers = {"Content-Length": "999"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        with (
            patch.object(fetcher.opener, "open", return_value=Response()),
            self.assertRaisesRegex(module.PackageError, "limit"),
        ):
            fetcher.get(module.skill_url("demo"), 10)

    def test_exact_namespaced_identity_does_not_merge_case_or_long_slugs(self):
        self.assertNotEqual(
            module.namespaced_id("skill", "Demo"), module.namespaced_id("skill", "demo")
        )
        self.assertNotEqual(
            module.namespaced_id("skill", "a" * 63 + "x"),
            module.namespaced_id("skill", "a" * 63 + "y"),
        )


if __name__ == "__main__":
    unittest.main()
