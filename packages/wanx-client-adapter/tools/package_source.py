"""Create a local source delivery and manifest; never publish or include caches."""
from __future__ import annotations
import hashlib
import json
import zipfile
from source_state import HERE

def main() -> None:
    package = json.loads((HERE / "package.json").read_text())
    version = package["version"]
    artifacts = HERE / "artifacts"
    tarball = artifacts / f"centaurai-wanx-{version}.tgz"
    source = artifacts / f"centaurai-wanx-{version}-source.zip"
    consumer = json.loads((artifacts / "consumer-check.json").read_text())
    assert consumer["sha256"] == hashlib.sha256(tarball.read_bytes()).hexdigest()
    evidence = {"go-race.jsonl", "node-tests.tap", "js-checks.json", "native-checks.json", "consumer-check.json"}
    count = 0
    with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(HERE.rglob("*")):
            rel = path.relative_to(HERE)
            if not path.is_file() or any(part in {"node_modules", "__pycache__", ".git", ".DS_Store"} for part in rel.parts): continue
            if rel.parts[0] == "artifacts" and rel.name not in evidence: continue
            archive.write(path, "centaurai-wanx/" + rel.as_posix())
            count += 1
    with zipfile.ZipFile(source) as archive:
        assert archive.testzip() is None
    files = [{"file": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in [tarball, source]]
    result = {"name": package["name"], "version": version, "local_delivery": True, "npm_go_publication": False, "production_release": False, "source_files": count, "files": files, "consumer_check": consumer, "verification": "../verification.json"}
    (artifacts / "release-manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    (artifacts / "SHA256SUMS").write_text("\n".join(f"{r['sha256']}  {r['file']}" for r in files) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
