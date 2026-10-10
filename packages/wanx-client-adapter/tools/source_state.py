"""Stable hashes for validation receipts, excluding generated evidence and binaries."""
from __future__ import annotations
import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

def digest(paths: list[Path]) -> str:
    result = hashlib.sha256()
    for path in sorted(set(paths)):
        result.update(path.relative_to(HERE).as_posix().encode() + b"\0")
        result.update(path.read_bytes())
    return result.hexdigest()

def native_state() -> str:
    paths = [p for p in (HERE / "native").rglob("*") if p.is_file() and "bin" not in p.relative_to(HERE / "native").parts]
    result = hashlib.sha256(digest(paths).encode())
    root = HERE.parent.parent
    for base in (root / "standard-sdk/go", root / "standard-sdk/release/go-connectivity-sdk-0.2.0/core"):
        for path in sorted(p for p in base.rglob("*") if p.is_file()):
            result.update(path.relative_to(root).as_posix().encode() + b"\0")
            result.update(path.read_bytes())
    return result.hexdigest()

def js_state() -> str:
    paths = []
    for name in ("src", "test", "examples", "contracts", "api-baseline"):
        paths.extend(p for p in (HERE / name).rglob("*") if p.is_file())
    paths.extend(HERE / name for name in ("package.json", "package-lock.json", "tsconfig.json", "tsconfig.examples.json", "native/bin/manifest.json"))
    return digest(paths)
