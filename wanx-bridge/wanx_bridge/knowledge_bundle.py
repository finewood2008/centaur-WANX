"""Prepare WANX's default embedding assets without importing or patching Octop."""

from __future__ import annotations

import argparse
import math
import os
import shutil
import tempfile
from pathlib import Path

import httpx

DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
DEFAULT_DIMENSIONS = 512
CACHE_NAME = "models--Qdrant--bge-small-zh-v1.5"
MODEL_SOURCE = (
    "https://octop-1258344699.cos.ap-guangzhou.myqcloud.com/models/embedding/BAAI/bge-small-zh-v1.5"
)
MODEL_FILES = (
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.txt",
    "model_optimized.onnx",
)


def verify_model(cache_dir: Path) -> None:
    """Fail the build for missing weights or unusable vectors, using local files only."""
    from fastembed import TextEmbedding

    model = TextEmbedding(
        model_name=DEFAULT_MODEL,
        cache_dir=str(cache_dir),
        local_files_only=True,
        threads=1,
    )
    vectors = list(model.embed(["知识库离线编码验证"]))
    if len(vectors) != 1 or len(vectors[0]) != DEFAULT_DIMENSIONS:
        raise RuntimeError("Bundled knowledge model returned an invalid vector shape")
    if not all(math.isfinite(float(value)) for value in vectors[0]):
        raise RuntimeError("Bundled knowledge model returned non-finite values")
    if not any(float(value) != 0 for value in vectors[0]):
        raise RuntimeError("Bundled knowledge model returned an empty vector")


def _readable_tree(root: Path) -> None:
    if os.name == "posix":
        for path in [root, *root.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)


def prefetch_model(cache_dir: Path) -> None:
    """Download the fixed default model into a standard Hugging Face cache layout."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / CACHE_NAME
    if target.exists():
        verify_model(cache_dir)
        return
    with tempfile.TemporaryDirectory(prefix=".wanx-embedding-", dir=cache_dir) as staging:
        stage = Path(staging)
        repo = stage / CACHE_NAME
        snapshot = repo / "snapshots" / "wanx-bundle"
        snapshot.mkdir(parents=True)
        with httpx.Client(timeout=httpx.Timeout(120, connect=20)) as client:
            for filename in MODEL_FILES:
                with client.stream("GET", f"{MODEL_SOURCE}/{filename}") as response:
                    response.raise_for_status()
                    with (snapshot / filename).open("wb") as output:
                        for chunk in response.iter_bytes():
                            output.write(chunk)
        (repo / "refs").mkdir()
        # HF reads the ref verbatim: a trailing newline breaks offline resolution.
        (repo / "refs" / "main").write_text("wanx-bundle", encoding="utf-8")
        verify_model(stage)
        _readable_tree(repo)
        repo.rename(target)
    if os.name == "posix":
        cache_dir.chmod(0o755)


def prepare_model(cache_dir: Path, data_dir: Path) -> None:
    """Atomically seed Octop's normal writable cache, preserving existing models."""
    source = cache_dir / CACHE_NAME
    target = data_dir / CACHE_NAME
    if target.exists() or target.is_symlink():
        return
    if not source.is_dir() or source.is_symlink():
        raise RuntimeError("Bundled knowledge model directory is missing or unsafe")
    # WANX's bundle contains regular files. Reject links before copying so no
    # unexpected image assets can escape this one model's directory.
    if any(path.is_symlink() for path in source.rglob("*")):
        raise RuntimeError("Bundled knowledge model contains symbolic links")
    data_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".wanx-embedding-", dir=data_dir) as staging:
        stage = Path(staging)
        shutil.copytree(source, stage / CACHE_NAME)
        _readable_tree(stage / CACHE_NAME)
        verify_model(stage)
        (stage / CACHE_NAME).rename(target)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prefetch", "verify", "prepare"))
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args()
    if args.action == "prepare":
        if args.data_dir is None:
            parser.error("prepare requires --data-dir")
        prepare_model(args.cache_dir, args.data_dir)
    elif args.action == "prefetch":
        prefetch_model(args.cache_dir)
    else:
        verify_model(args.cache_dir)
    print(f"Knowledge model {args.action} complete: {DEFAULT_MODEL}")


if __name__ == "__main__":
    main()
