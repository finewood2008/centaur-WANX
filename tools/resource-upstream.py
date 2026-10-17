#!/usr/bin/env python3
"""Import explicitly selected public SkillHub archives as local Admin resource drafts.

No Octop imports, code execution, Admin requests, authentication or publication.
"""

from __future__ import annotations

import argparse
import base64
import importlib.util
import io
import json
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

_SPEC = importlib.util.spec_from_file_location(
    "package_resources", Path(__file__).with_name("package-resources.py")
)
assert _SPEC and _SPEC.loader
package_tools = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(package_tools)
PackageError = package_tools.PackageError

API = "https://api.skillhub.cn"
ALLOWED_HOSTS = {"api.skillhub.cn", "skillhub-1388575217.cos.accelerate.myqcloud.com"}
SLUG = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\Z")
MAX_ARCHIVE = 24 * 1024 * 1024
MAX_JSON = 4 * 1024 * 1024
MAX_DOWNLOAD_TOTAL = 64 * 1024 * 1024


def slug(value: Any) -> str:
    if not isinstance(value, str) or not SLUG.fullmatch(value):
        raise PackageError("upstream slug must be a 1–64 character skill identifier")
    return value


def allowed_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_HOSTS
        or parsed.netloc != parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.fragment
        or any(ord(char) < 33 or ord(char) == 127 for char in url)
    ):
        raise PackageError("upstream URL must use an explicitly allowed HTTPS host")
    if parsed.hostname == "api.skillhub.cn":
        if parsed.path == "/api/v1/download":
            query = urllib.parse.parse_qsl(parsed.query)
            if len(query) != 1 or query[0][0] != "slug":
                raise PackageError("upstream skill download requires one explicit slug")
            slug(query[0][1])
        elif parsed.query or not re.fullmatch(
            r"/api/v1/skillsets/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?:/download)?", parsed.path
        ):
            raise PackageError("upstream API path is not allowed")
    elif parsed.query or not re.fullmatch(
        r"/skills/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}/[a-zA-Z0-9][a-zA-Z0-9._+-]*\.zip",
        parsed.path,
    ):
        raise PackageError("upstream CDN path is not an allowed skill archive")
    return url


class Fetcher:
    """Anonymous bounded GETs. Redirects are revalidated before each request."""

    def __init__(self) -> None:
        self.total = 0
        self.receipts: list[dict[str, Any]] = []
        # Support an anonymous configured egress proxy, never proxy credentials/.netrc.
        proxies = {}
        for scheme, proxy in urllib.request.getproxies().items():
            if scheme not in {"http", "https"}:
                continue
            parsed = urllib.parse.urlsplit(proxy)
            if parsed.username or parsed.password:
                raise PackageError("credential-bearing proxies are not supported for imports")
            proxies[scheme] = proxy
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler(proxies), package_tools.NoRedirect()
        )

    def get(self, url: str, limit: int) -> bytes:
        original = allowed_url(url)
        for _ in range(4):
            allowed_url(url)
            request = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json, application/zip, application/octet-stream",
                    "User-Agent": "wanx-resource-import/1.0",
                },
                method="GET",
            )
            try:
                with self.opener.open(request, timeout=30) as response:
                    declared = response.headers.get("Content-Length")
                    if declared is not None:
                        try:
                            size = int(declared)
                        except ValueError as exc:
                            raise PackageError("invalid upstream Content-Length") from exc
                        if size < 0 or size > limit:
                            raise PackageError("upstream response exceeds download limit")
                    data = response.read(min(limit, MAX_DOWNLOAD_TOTAL - self.total) + 1)
                    self.total += len(data)
                    if len(data) > limit or self.total > MAX_DOWNLOAD_TOTAL:
                        raise PackageError("upstream response exceeds download limit")
                    self.receipts.append(
                        {
                            "url": original,
                            "resolvedUrl": url,
                            "sizeBytes": len(data),
                            "sha256": package_tools.digest(data),
                        }
                    )
                    return data
            except urllib.error.HTTPError as exc:
                if exc.code in {301, 302, 303, 307, 308} and exc.headers.get("Location"):
                    url = allowed_url(urllib.parse.urljoin(url, exc.headers["Location"]))
                    continue
                raise PackageError(f"public upstream download failed: HTTP {exc.code}") from exc
            except (urllib.error.URLError, OSError) as exc:
                raise PackageError("public upstream download failed or timed out") from exc
        raise PackageError("too many upstream redirects")


def parse_json(data: bytes) -> dict[str, Any]:
    try:
        result = json.loads(data, object_pairs_hook=package_tools.unique_object)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PackageError("invalid upstream JSON") from exc
    if not isinstance(result, dict):
        raise PackageError("upstream JSON must be an object")
    return result


def read_archive(path: Path) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARCHIVE:
        raise PackageError("archive must be a regular file no larger than 24 MiB")
    return path.read_bytes()


def parse_archive(data: bytes) -> dict[str, bytes]:
    """Read only in memory; reject invalid entries instead of extracting them."""
    if len(data) > MAX_ARCHIVE:
        raise PackageError("archive exceeds 24 MiB")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > 512:
                raise PackageError("archive entry count exceeds limit")
            result = {}
            seen = set()
            total = 0
            file_paths = set()
            for entry in entries:
                path = entry.filename[:-1] if entry.is_dir() else entry.filename
                package_tools.template_path(path)
                if any(
                    part.startswith(".") or part.casefold() in package_tools.PRIVATE_ROOTS
                    for part in path.split("/")
                ):
                    raise PackageError("hidden/runtime archive paths cannot be installed")
                key = path.casefold()
                if key in seen:
                    raise PackageError("duplicate archive path, including case variants")
                seen.add(key)
                mode = entry.external_attr >> 16
                file_type = stat.S_IFMT(mode)
                if file_type not in {0, stat.S_IFREG, stat.S_IFDIR} or entry.flag_bits & 1:
                    raise PackageError("archive contains nonregular or encrypted entries")
                if (file_type == stat.S_IFDIR) != entry.is_dir() and file_type != 0:
                    raise PackageError("archive entry type differs from its path")
                if entry.is_dir():
                    continue
                file_paths.add(key)
                if not 0 <= entry.file_size <= package_tools.MAX_FILE:
                    raise PackageError("archive file exceeds 4 MiB")
                total += entry.file_size
                if total > package_tools.MAX_TOTAL or len(result) >= 256:
                    raise PackageError("archive contents exceed resource limits")
                if (
                    entry.file_size > 1024 * 1024
                    and entry.file_size > max(1, entry.compress_size) * 200
                ):
                    raise PackageError("archive compression ratio exceeds limit")
                with archive.open(entry) as stream:
                    content = stream.read(package_tools.MAX_FILE + 1)
                if len(content) != entry.file_size:
                    raise PackageError("archive file size mismatch")
                if re.search(
                    rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----",
                    content,
                ):
                    raise PackageError("archive contains private key material")
                result[path] = content
            if any(
                "/".join(path.split("/")[:i]) in file_paths
                for path in seen
                for i in range(1, len(path.split("/")))
            ):
                raise PackageError("archive file conflicts with a directory")
            return result
    except (zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, OSError) as exc:
        raise PackageError("invalid upstream ZIP archive") from exc


def skill_files(data: bytes) -> dict[str, bytes]:
    files = parse_archive(data)
    if "SKILL.md" not in files:
        roots = {path.split("/", 1)[0] for path in files}
        if len(roots) == 1:
            prefix = next(iter(roots)) + "/"
            if prefix + "SKILL.md" in files:
                files = {path[len(prefix) :]: value for path, value in files.items()}
    if not files.get("SKILL.md"):
        raise PackageError("skill archive is missing a nonempty root SKILL.md")
    try:
        files["SKILL.md"].decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise PackageError("SKILL.md must be UTF-8; refusing a partial/changed import") from exc
    return files


def skill_url(identifier: str) -> str:
    return API + "/api/v1/download?" + urllib.parse.urlencode({"slug": slug(identifier)})


def skillset_url(identifier: str) -> str:
    return API + "/api/v1/skillsets/" + slug(identifier)


def namespaced_id(source: str, identifier: str) -> str:
    identity = f"skillhub-{source}-{identifier}"
    if len(identity) > 64 or identity != identity.lower():
        identity = identity[:51].lower() + "-" + package_tools.digest(identity.encode())[:12]
    return package_tools.resource_id(identity)


def build(
    *,
    source: str,
    identifier: str,
    release_version: str,
    kind: str,
    archive: Path | None = None,
    skill_archives: dict[str, Path] | None = None,
    resource_id: str | None = None,
    fetcher: Fetcher | None = None,
) -> dict[str, Any]:
    slug(identifier)
    package_tools.version(release_version)
    if source not in {"skill", "skillset"} or kind not in {"expert", "skill-package"}:
        raise PackageError("invalid upstream source or resource kind")
    if source == "skill" and kind != "skill-package":
        raise PackageError("a single skill cannot be imported as an expert")
    supplied = skill_archives or {}
    if supplied and (source != "skillset" or archive is None):
        raise PackageError("skill-archive is only supported with an offline skillset archive")
    if archive is None:
        fetcher = fetcher or Fetcher()
    offline_receipts = []

    def download(url: str, local: Path | None) -> bytes:
        if local is None:
            assert fetcher is not None
            return fetcher.get(url, MAX_ARCHIVE)
        raw = read_archive(local)
        offline_receipts.append(
            {"sizeBytes": len(raw), "sha256": package_tools.digest(raw), "expectedUrl": url}
        )
        return raw

    detail = {}
    if source == "skillset" and archive is None:
        assert fetcher is not None
        detail = parse_json(fetcher.get(skillset_url(identifier), MAX_JSON))
        if detail.get("slug") != identifier:
            raise PackageError("upstream details identify another skillset")
    files: dict[str, bytes] = {}
    name = identifier
    description = ""
    if source == "skill":
        raw = download(skill_url(identifier), archive)
        files = {
            f"skills/{identifier}/{path}": content for path, content in skill_files(raw).items()
        }
    else:
        raw = download(skillset_url(identifier) + "/download", archive)
        bundle = parse_archive(raw)
        if "manifest.json" not in bundle:
            raise PackageError("skillset archive is missing manifest.json")
        manifest = parse_json(bundle["manifest.json"])
        if manifest.get("slug") != identifier or manifest.get("type") != "skillset":
            raise PackageError("skillset archive manifest identity/type mismatch")
        identifiers = manifest.get("skillSlugs")
        if (
            not isinstance(identifiers, list)
            or not identifiers
            or len(identifiers) > 64
            or any(not isinstance(item, str) or not SLUG.fullmatch(item) for item in identifiers)
            or len({item.casefold() for item in identifiers}) != len(identifiers)
            or identifier.casefold() in {item.casefold() for item in identifiers}
        ):
            raise PackageError("skillset must declare a complete distinct skillSlugs array")
        if detail.get("skillSlugs") is not None:
            declared_skills = detail["skillSlugs"]
            if (
                not isinstance(declared_skills, list)
                or any(not isinstance(item, str) for item in declared_skills)
                or set(declared_skills) != set(identifiers)
            ):
                raise PackageError("skillset changed between details and archive; retry the import")
        if archive is not None and set(supplied) != set(identifiers):
            raise PackageError("offline skillset requires one explicit archive per declared skill")
        declared_files = manifest.get("files")
        if declared_files is not None:
            if not isinstance(declared_files, list):
                raise PackageError("invalid skillset file manifest")
            for item in declared_files:
                if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                    raise PackageError("invalid skillset file manifest")
                content = bundle.get(item["path"])
                if (
                    content is None
                    or type(item.get("size")) is not int
                    or item["size"] != len(content)
                    or item.get("sha256") != package_tools.digest(content)
                ):
                    raise PackageError("skillset archive differs from its file manifest")
        prompt_path = f"skillsets/{identifier}.md"
        prompt = bundle.get(prompt_path, bundle.get("identify.md"))
        if not prompt or not prompt.strip():
            raise PackageError("skillset archive has no complete workflow; preview is insufficient")
        try:
            prompt.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise PackageError("skillset workflow must be UTF-8") from exc
        name = manifest.get("displayName") or detail.get("displayName") or identifier
        description = manifest.get("summary") or detail.get("summary") or ""
        workflow_root = f"skills/{identifier}"
        files[f"{workflow_root}/SKILL.md"] = prompt
        # Keep every byte of the source manifest/attachments, separately from generated metadata.
        files.update({f"{workflow_root}/source/{path}": value for path, value in bundle.items()})
        for skill in identifiers:
            data = download(skill_url(skill), supplied.get(skill))
            files.update(
                {f"skills/{skill}/{path}": content for path, content in skill_files(data).items()}
            )
            if sum(len(value) for value in files.values()) > package_tools.MAX_TOTAL:
                raise PackageError("complete skillset exceeds 16 MiB; no partial package emitted")
        if kind == "expert":
            expert_manifest = {
                "id": "skillhub-skillset-" + identifier,
                "label": {"zh": name, "en": detail.get("displayNameEn") or name},
                "description": {"zh": description, "en": detail.get("summaryEn") or description},
                "prompt_files": ["SOUL.md"],
                "source": {"type": "skillhub", "kind": "skillset", "slug": identifier},
                "skillhub": {"slug": identifier, "skill_slugs": identifiers},
            }
            files["manifest.json"] = package_tools.canonical(expert_manifest)
            files["SOUL.md"] = (
                f"# {name}\n\n{description}\n\n"
                f"遵循 `skills/{identifier}/SKILL.md` 的完整工作流，使用随包安装的配套技能。\n"
            ).encode()
    encoded = [
        {"path": path, "contentBase64": base64.b64encode(value).decode("ascii")}
        for path, value in sorted(files.items())
    ]
    provenance = {
        "sourceKind": "skillhub-archive" if archive else "skillhub-public-api",
        "gitCommit": None,
        "dirty": None,
        "contentSha256": package_tools.digest(
            package_tools.canonical(
                [
                    {"path": path, "sha256": package_tools.digest(value)}
                    for path, value in sorted(files.items())
                ]
            )
        ),
        "upstream": {"provider": "skillhub", "kind": source, "slug": identifier},
        "downloads": offline_receipts if archive else fetcher.receipts,
    }
    result = {
        "schemaVersion": 1,
        "kind": kind,
        "resourceId": resource_id or namespaced_id(source, identifier),
        "version": release_version,
        "name": name,
        "description": description,
        "dependencies": [],
        "metadata": {"provenance": provenance},
        "files": encoded,
    }
    package_tools.validate(result)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", choices=("skill", "skillset"))
    parser.add_argument("--slug", required=True, help="Exact selected upstream ID")
    parser.add_argument("--kind", choices=("expert", "skill-package"))
    parser.add_argument("--version", required=True, help="Admin stable resource version")
    parser.add_argument("--resource-id", help="Optional explicit Admin identity")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--archive", type=Path, help="Offline ZIP; disables all network requests")
    parser.add_argument(
        "--skill-archive",
        action="append",
        default=[],
        metavar="SLUG=PATH",
        help="Offline skillset only: one explicit ZIP for every manifest skillSlugs entry",
    )
    args = parser.parse_args(argv)
    try:
        skills = {}
        for entry in args.skill_archive:
            identity, separator, path = entry.partition("=")
            slug(identity)
            if not separator or not path or identity in skills:
                raise PackageError("skill-archive must be a distinct SLUG=PATH")
            skills[identity] = Path(path)
        package = build(
            source=args.source,
            identifier=args.slug,
            release_version=args.version,
            kind=args.kind or ("expert" if args.source == "skillset" else "skill-package"),
            archive=args.archive,
            skill_archives=skills,
            resource_id=args.resource_id,
        )
        package_tools.emit(args.output, package_tools.canonical(package))
        print(
            json.dumps(
                {
                    **package_tools.validate(package),
                    "output": str(args.output),
                    "publication": "not-requested",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    except (PackageError, OSError, UnicodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
