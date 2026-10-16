#!/usr/bin/env python3
"""Package Octop templates for WANX Resource Center without modifying Octop.

Standard-library-only; all network activity is explicit and draft-only.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
LIBRARY = REPO / "src/octop/infra/agents/experts/library"
MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_REQUEST = 24 * 1024 * 1024
FIELDS = {
    "schemaVersion",
    "kind",
    "resourceId",
    "version",
    "name",
    "description",
    "dependencies",
    "metadata",
    "files",
}
IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
RESERVED = re.compile(r"(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\Z", re.I)
PRIVATE_NAMES = {
    "credentials",
    "credentials.json",
    "credential.json",
    "secrets.json",
    "token.json",
    "tokens.json",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "authorized_keys",
    "known_hosts",
}
PRIVATE_ROOTS = {
    ".octop",
    ".ssh",
    ".aws",
    ".azure",
    ".git",
    "memory",
    "memories",
    "sessions",
    "conversations",
    "history",
    "logs",
    "outbound",
    "inbound",
}
CACHE_PARTS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".DS_Store"}


class PackageError(ValueError):
    """Safe user-facing packaging error; never includes secret file contents."""


def canonical(value: Any) -> bytes:
    json_value(value)
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_value(value: Any, depth: int = 0) -> None:
    if depth > 32:
        raise PackageError("JSON nesting exceeds 32 levels")
    if value is None or type(value) in (bool, str):
        return
    if type(value) is int and abs(value) <= 9007199254740991:
        return
    if isinstance(value, list):
        for entry in value:
            json_value(entry, depth + 1)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for key, entry in value.items():
            json_value(key, depth + 1)
            json_value(entry, depth + 1)
        return
    raise PackageError(
        "metadata must contain only JSON strings, safe integers, booleans, null, arrays and objects"
    )


def version(value: Any) -> str:
    match = VERSION.fullmatch(value) if isinstance(value, str) and len(value) <= 32 else None
    if not match or any(int(item) > 2147483647 for item in match.groups()):
        raise PackageError("version must be stable major.minor.patch")
    return value


def resource_id(value: Any) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise PackageError("invalid resourceId")
    return value


def safe_path(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 512:
        raise PackageError("invalid file path")
    if (
        unicodedata.normalize("NFC", value) != value
        or "\\" in value
        or ":" in value
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise PackageError(f"non-portable file path: {value!r}")
    parts = value.split("/")
    if any(
        part in {"", ".", ".."}
        or len(part.encode("utf-8")) > 255
        or part.endswith((" ", "."))
        or RESERVED.fullmatch(part)
        for part in parts
    ):
        raise PackageError(f"non-portable file path: {value!r}")
    return value


def template_path(value: str) -> str:
    safe_path(value)
    parts = value.casefold().split("/")
    if parts[0] in PRIVATE_ROOTS or any(
        part in PRIVATE_NAMES
        or part in CACHE_PARTS
        or part == ".env"
        or part.startswith(".env.")
        or part.endswith((".pem", ".p12", ".pfx", ".key", ".sqlite", ".sqlite3", ".db"))
        for part in parts
    ):
        raise PackageError(f"private/runtime path cannot be published: {value}")
    return value


def read_json(path: Path) -> Any:
    if path.stat().st_size > MAX_REQUEST:
        raise PackageError("JSON file is too large")
    try:
        return json.loads(path.read_text("utf-8"), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PackageError(f"invalid JSON: {path.name}") from exc


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise PackageError("duplicate JSON key")
        result[key] = value
    return result


def validate(package: Any) -> dict[str, Any]:
    if (
        not isinstance(package, dict)
        or set(package) != FIELDS
        or type(package["schemaVersion"]) is not int
        or package["schemaVersion"] != 1
    ):
        raise PackageError("invalid resource package fields/schemaVersion")
    kind = package["kind"]
    if not isinstance(kind, str) or kind not in {"expert", "skill-package"}:
        raise PackageError("invalid resource kind")
    resource_id(package["resourceId"])
    version(package["version"])
    if (
        not isinstance(package["name"], str)
        or not package["name"].strip()
        or len(package["name"]) > 128
    ):
        raise PackageError("name must be nonempty and at most 128 characters")
    if not isinstance(package["description"], str) or len(package["description"]) > 8192:
        raise PackageError("description must be text of at most 8192 characters")
    dependencies = package["dependencies"]
    if not isinstance(dependencies, list) or len(dependencies) > 64:
        raise PackageError("invalid dependency list")
    seen_dependencies = set()
    for dependency in dependencies:
        if not isinstance(dependency, dict) or set(dependency) != {
            "kind",
            "resourceId",
            "minVersion",
        }:
            raise PackageError("dependencies must be exact required resources")
        if (
            not isinstance(dependency["kind"], str)
            or dependency["kind"] not in {"expert", "skill-package"}
            or (kind == "skill-package" and dependency["kind"] == "expert")
        ):
            raise PackageError("invalid dependency kind")
        identity = dependency["kind"], resource_id(dependency["resourceId"])
        version(dependency["minVersion"])
        if identity in seen_dependencies or identity == (kind, package["resourceId"]):
            raise PackageError("duplicate/self dependency")
        seen_dependencies.add(identity)
    if not isinstance(package["metadata"], dict):
        raise PackageError("metadata must be an object")
    json_value(package["metadata"])
    if len(canonical(package["metadata"])) > 64 * 1024:
        raise PackageError("metadata exceeds 64 KiB")
    files = package["files"]
    if not isinstance(files, list) or not 1 <= len(files) <= 256:
        raise PackageError("resource must contain 1 through 256 files")
    paths: set[str] = set()
    total = 0
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "contentBase64"}:
            raise PackageError("invalid file entry")
        path = safe_path(item["path"]).casefold()
        if path in paths:
            raise PackageError("case-insensitive duplicate file path")
        paths.add(path)
        encoded = item["contentBase64"]
        if not isinstance(encoded, str) or len(encoded) > ((MAX_FILE + 2) // 3) * 4:
            raise PackageError("file exceeds maximum encoded size")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, UnicodeError) as exc:
            raise PackageError("invalid base64") from exc
        if base64.b64encode(content).decode("ascii") != encoded or len(content) > MAX_FILE:
            raise PackageError("noncanonical base64 or oversized file")
        total += len(content)
    if any(
        "/".join(path.split("/")[:i]) in paths
        for path in paths
        for i in range(1, len(path.split("/")))
    ):
        raise PackageError("a file cannot also be a parent directory")
    if total > MAX_TOTAL or len(canonical(package)) > MAX_REQUEST:
        raise PackageError("resource package exceeds size limit")
    return {
        "kind": kind,
        "resourceId": package["resourceId"],
        "version": package["version"],
        "files": len(files),
        "decodedBytes": total,
        "sizeBytes": len(canonical(package)),
        "sha256": digest(canonical(package)),
    }


def read_template_file(root: Path, relative: str) -> bytes:
    template_path(relative)
    target = root
    for part in relative.split("/"):
        target /= part
        if target.is_symlink():
            raise PackageError(f"symlinks cannot be published: {relative}")
    info = target.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
        raise PackageError(f"invalid/oversized template file: {relative}")
    data = target.read_bytes()
    if b"-----BEGIN " in data and re.search(
        rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----", data
    ):
        raise PackageError(f"private key material cannot be published: {relative}")
    return data


def provenance(root: Path, files: list[dict[str, str]], source_kind: str) -> dict[str, Any]:
    content_index = [
        {"path": f["path"], "sha256": digest(base64.b64decode(f["contentBase64"]))} for f in files
    ]
    result: dict[str, Any] = {
        "sourceKind": source_kind,
        "contentSha256": digest(canonical(content_index)),
        "gitCommit": None,
        "dirty": None,
    }
    try:
        commit = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"],
            check=True,
            capture_output=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return result
    result.update(gitCommit=commit, dirty=bool(dirty))
    return result


def build_package(
    root: Path, spec: dict[str, Any], paths: list[str], source_kind: str
) -> dict[str, Any]:
    if root.is_symlink() or not root.is_dir():
        raise PackageError("template root must be a real directory")
    if (
        not isinstance(paths, list)
        or not 1 <= len(paths) <= 256
        or any(not isinstance(path, str) for path in paths)
    ):
        raise PackageError("an explicit list of 1 through 256 file paths is required")
    files = []
    total = 0
    for path in sorted(paths):
        content = read_template_file(root, path)
        total += len(content)
        if total > MAX_TOTAL:
            raise PackageError("template files exceed 16 MiB")
        files.append({"path": path, "contentBase64": base64.b64encode(content).decode("ascii")})
    if not isinstance(spec.get("metadata"), dict):
        raise PackageError("metadata must be an object")
    metadata = dict(spec.get("metadata", {}))
    if "provenance" in metadata:
        raise PackageError("metadata.provenance is generated by this tool")
    metadata["provenance"] = provenance(root, files, source_kind)
    package = {**spec, "metadata": metadata, "files": files}
    validate(package)
    return package


def emit(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.is_symlink() or path.read_bytes() != data:
            raise PackageError(f"output already exists with different contents: {path}")
        return
    with path.open("xb") as output:
        output.write(data)


def local_text(value: Any, fallback: str) -> str:
    if isinstance(value, str):
        return value or fallback
    if isinstance(value, dict):
        return str(value.get("zh") or value.get("en") or fallback)
    return fallback


def library_packages(
    root: Path, release_version: str, include_default: bool = False, split_skills: bool = False
) -> list[dict[str, Any]]:
    version(release_version)
    packages = []
    for directory in sorted(root.iterdir()):
        if not directory.is_dir() or not (directory / "manifest.json").is_file():
            continue
        if directory.name == "default" and not include_default:
            continue
        manifest = read_json(directory / "manifest.json")
        if not isinstance(manifest, dict) or manifest.get("id", directory.name) != directory.name:
            raise PackageError(f"manifest identity differs from source directory: {directory.name}")
        paths = [
            str(path.relative_to(directory).as_posix())
            for path in sorted(directory.rglob("*"))
            if path.is_file()
            and not any(part in CACHE_PARTS for part in path.relative_to(directory).parts)
            and path.suffix not in {".pyc", ".pyo"}
        ]
        spec = {
            "schemaVersion": 1,
            "kind": "expert",
            "resourceId": resource_id("octop-" + directory.name),
            "version": release_version,
            "name": local_text(manifest.get("label"), directory.name),
            "description": local_text(manifest.get("description"), ""),
            "dependencies": [],
            "metadata": {
                "octopExpertId": directory.name,
                "internalTemplate": directory.name == "default",
            },
        }
        packages.append(build_package(directory, spec, paths, "octop-bundled"))
        if split_skills:
            skill_root = directory / "skills"
            if not skill_root.is_dir():
                continue
            for skill in sorted(skill_root.iterdir()):
                if not skill.is_dir() or not (skill / "SKILL.md").is_file():
                    continue
                identity = f"octop-{directory.name}-{skill.name}"
                if len(identity) > 64:
                    identity = identity[:51] + "-" + digest(identity.encode())[:12]
                skill_spec = {
                    "schemaVersion": 1,
                    "kind": "skill-package",
                    "resourceId": resource_id(identity),
                    "version": release_version,
                    "name": f"{spec['name']} · {skill.name}",
                    "description": "Imported from the exact source expert; identical names in other experts remain separate.",
                    "dependencies": [],
                    "metadata": {"octopExpertId": directory.name, "sourceSkillSlug": skill.name},
                }
                skill_paths = [path for path in paths if path.startswith(f"skills/{skill.name}/")]
                packages.append(
                    build_package(directory, skill_spec, skill_paths, "octop-bundled-skill")
                )
    return packages


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


def upload_draft(package: dict[str, Any], api_base: str, token_file: Path) -> dict[str, Any]:
    validate(package)
    parsed = urllib.parse.urlsplit(api_base)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise PackageError(
            "api-base must be an HTTPS API base URL without credentials, query or fragment"
        )
    info = token_file.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_size > 16384
        or (os.name == "posix" and info.st_mode & 0o077)
    ):
        raise PackageError("token-file must be a private regular file (mode 0600)")
    token = token_file.read_text("utf-8").strip()
    if not token or any(c.isspace() for c in token):
        raise PackageError("token-file must contain only the raw access token")
    endpoint = api_base.rstrip("/") + "/nexus/resources/versions"
    request = urllib.request.Request(
        endpoint,
        data=canonical(package),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            raw = response.read(1024 * 1024 + 1)
    except (urllib.error.URLError, OSError) as exc:
        raise PackageError("draft upload failed; no publication was requested") from exc
    if len(raw) > 1024 * 1024:
        raise PackageError("draft response is too large")
    try:
        response = json.loads(raw)
        record = response["data"]
    except (ValueError, KeyError, TypeError) as exc:
        raise PackageError("invalid draft response") from exc
    expected = validate(package)
    if (
        response.get("code") != 200
        or response.get("success") is not True
        or not isinstance(record, dict)
        or any(
            record.get(key) != expected[key]
            for key in ("kind", "resourceId", "version", "sha256", "sizeBytes")
        )
    ):
        raise PackageError("draft response does not match the uploaded package")
    if record.get("status") != "draft":
        raise PackageError(
            "resource version already exists outside draft; no publish request was made"
        )
    return {
        key: record[key]
        for key in ("kind", "resourceId", "version", "status", "sha256", "sizeBytes")
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    library = commands.add_parser(
        "library", help="Export fixed bundled template source; no network"
    )
    library.add_argument("--version", required=True)
    library.add_argument("--output-dir", type=Path, required=True)
    library.add_argument("--include-default", action="store_true")
    library.add_argument(
        "--split-skills",
        action="store_true",
        help="Also export source-qualified skill packages; experts retain embedded skills",
    )
    custom = commands.add_parser(
        "directory", help="Package explicitly selected files from a custom template"
    )
    custom.add_argument("--root", type=Path, required=True)
    custom.add_argument(
        "--spec",
        type=Path,
        required=True,
        help="Resource fields with files as an explicit relative-path string array",
    )
    custom.add_argument("--output", type=Path, required=True)
    check = commands.add_parser("validate")
    check.add_argument("packages", type=Path, nargs="+")
    upload = commands.add_parser(
        "upload-draft", help="Upload a draft only; no publication endpoint is implemented"
    )
    upload.add_argument("--package", type=Path, required=True)
    upload.add_argument(
        "--api-base", required=True, help="For example https://admin.example/prod-api"
    )
    upload.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "library":
            packages = library_packages(
                LIBRARY, args.version, args.include_default, args.split_skills
            )
            index = {"schemaVersion": 1, "publication": "not-requested", "items": []}
            for package in packages:
                name = f"{package['kind']}--{package['resourceId']}--{package['version']}.json"
                emit(args.output_dir / name, canonical(package))
                index["items"].append(
                    {
                        **validate(package),
                        "file": name,
                        "provenance": package["metadata"]["provenance"],
                    }
                )
            emit(args.output_dir / "index.json", canonical(index))
            result = {
                "packages": len(packages),
                "decodedBytes": sum(item["decodedBytes"] for item in index["items"]),
                "index": str(args.output_dir / "index.json"),
                "publication": "not-requested",
            }
        elif args.command == "directory":
            spec = read_json(args.spec)
            if not isinstance(spec, dict) or set(spec) != FIELDS:
                raise PackageError(
                    "custom spec must use exact resource fields and explicit files array"
                )
            paths = spec.pop("files")
            package = build_package(args.root, spec, paths, "explicit-template-files")
            emit(args.output, canonical(package))
            result = validate(package)
        elif args.command == "validate":
            result = {"items": [validate(read_json(path)) for path in args.packages]}
        else:
            result = upload_draft(read_json(args.package), args.api_base, args.token_file)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (PackageError, OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
