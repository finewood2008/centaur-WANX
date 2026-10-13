"""The image build must reject incomplete or invalid bundled embeddings."""

from __future__ import annotations

import os
import sys
import types

import pytest

from wanx_bridge import knowledge_bundle as bundle


@pytest.mark.parametrize(
    "vectors",
    [[], [[1.0] * 384], [[float("nan")] * 512], [[0.0] * 512], [[1.0] * 512] * 2],
)
def test_invalid_encoding_fails_the_build(monkeypatch, tmp_path, vectors):
    class FakeEmbedding:
        def __init__(self, **kwargs):
            assert kwargs["local_files_only"] is True

        def embed(self, texts):
            return vectors

    monkeypatch.setitem(
        sys.modules, "fastembed", types.SimpleNamespace(TextEmbedding=FakeEmbedding)
    )
    with pytest.raises(RuntimeError, match="Bundled knowledge model"):
        bundle.verify_model(tmp_path)


def test_valid_offline_encoding(monkeypatch, tmp_path):
    class FakeEmbedding:
        def __init__(self, **kwargs):
            assert kwargs == {
                "model_name": "BAAI/bge-small-zh-v1.5",
                "cache_dir": str(tmp_path),
                "local_files_only": True,
                "threads": 1,
            }

        def embed(self, texts):
            assert texts == ["知识库离线编码验证"]
            return [[0.25] * 512]

    monkeypatch.setitem(
        sys.modules, "fastembed", types.SimpleNamespace(TextEmbedding=FakeEmbedding)
    )
    bundle.verify_model(tmp_path)


def seed_bundle(tmp_path):
    source = tmp_path / "bundle"
    repo = source / bundle.CACHE_NAME
    repo.mkdir(parents=True)
    (repo / "weights").write_bytes(b"model")
    return source


def test_prepare_publishes_only_after_verification(monkeypatch, tmp_path):
    source = seed_bundle(tmp_path)
    data = tmp_path / "data"
    target = data / bundle.CACHE_NAME

    def verify(stage):
        assert not target.exists()
        assert (stage / bundle.CACHE_NAME / "weights").read_bytes() == b"model"

    monkeypatch.setattr(bundle, "verify_model", verify)
    bundle.prepare_model(source, data)
    assert (target / "weights").read_bytes() == b"model"
    assert list(data.iterdir()) == [target]


def test_failed_verification_leaves_no_partial_cache(monkeypatch, tmp_path):
    source = seed_bundle(tmp_path)
    data = tmp_path / "data"

    def fail(stage):
        raise RuntimeError("incomplete")

    monkeypatch.setattr(bundle, "verify_model", fail)
    with pytest.raises(RuntimeError, match="incomplete"):
        bundle.prepare_model(source, data)
    assert list(data.iterdir()) == []


def test_existing_cache_is_preserved(monkeypatch, tmp_path):
    source = seed_bundle(tmp_path)
    data = tmp_path / "data"
    existing = data / bundle.CACHE_NAME
    existing.mkdir(parents=True)
    (existing / "weights").write_bytes(b"user-model")
    bundle.prepare_model(source, data)
    assert (existing / "weights").read_bytes() == b"user-model"


@pytest.mark.skipif(os.name != "posix", reason="POSIX symlink semantics")
def test_bundle_cannot_copy_external_symlink(tmp_path):
    source = seed_bundle(tmp_path)
    secret = tmp_path / "outside"
    secret.write_bytes(b"not a model")
    (source / bundle.CACHE_NAME / "link").symlink_to(secret)
    with pytest.raises(RuntimeError, match="symbolic links"):
        bundle.prepare_model(source, tmp_path / "data")


def test_prefetch_creates_hf_cache_without_trailing_newline(monkeypatch, tmp_path):
    import httpx

    real_client = httpx.Client
    requested = []

    def download(request):
        requested.append(str(request.url))
        return httpx.Response(200, content=b"model asset")

    monkeypatch.setattr(
        httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(download))
    )

    def verify(stage):
        repo = stage / bundle.CACHE_NAME
        assert (repo / "refs" / "main").read_bytes() == b"wanx-bundle"
        assert {p.name for p in (repo / "snapshots" / "wanx-bundle").iterdir()} == set(
            bundle.MODEL_FILES
        )
        assert not (tmp_path / bundle.CACHE_NAME).exists()

    monkeypatch.setattr(bundle, "verify_model", verify)
    bundle.prefetch_model(tmp_path)
    assert requested == [f"{bundle.MODEL_SOURCE}/{name}" for name in bundle.MODEL_FILES]
    assert list(tmp_path.iterdir()) == [tmp_path / bundle.CACHE_NAME]


def test_prefetch_failure_does_not_publish_partial_download(monkeypatch, tmp_path):
    import httpx

    real_client = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: real_client(
            transport=httpx.MockTransport(lambda request: httpx.Response(404))
        ),
    )
    with pytest.raises(httpx.HTTPStatusError):
        bundle.prefetch_model(tmp_path)
    assert list(tmp_path.iterdir()) == []
