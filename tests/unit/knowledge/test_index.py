"""Unit tests for per-knowledge-base sidecar indexes."""

from __future__ import annotations

from octop.infra.knowledge.index import KnowledgeIndex


def test_index_replaces_document_chunks_and_returns_cosine_top_k(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path))
    index = KnowledgeIndex("kb-1")

    index.replace_doc_chunks(
        "doc-1",
        ["first", "second"],
        [[1.0, 0.0], [0.0, 1.0]],
        metadata=[{"page": 1}, {"page": 2}],
    )
    index.replace_doc_chunks("doc-2", ["third"], [[0.8, 0.2]])

    hits = index.search([1.0, 0.0], k=2)

    assert [hit.text for hit in hits] == ["first", "third"]
    assert hits[0].doc_id == "doc-1"
    assert hits[0].ordinal == 0
    assert hits[0].metadata == {"page": 1}

    index.replace_doc_chunks("doc-1", ["replacement"], [[0.0, 1.0]])
    assert [hit.text for hit in index.search([1.0, 0.0], k=5)] == ["third", "replacement"]

    index.delete_doc("doc-2")
    assert [hit.doc_id for hit in index.search([1.0, 0.0], k=5)] == ["doc-1"]


def test_old_model_and_pending_document_do_not_displace_current_top_hit(tmp_path, monkeypatch):
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path))
    index = KnowledgeIndex("kb-1")
    index.replace_doc_chunks(
        "old", ["old model"], [[1.0, 0.0]], metadata=[{"embedding_model": "old"}]
    )
    index.replace_doc_chunks(
        "pending", ["not ready"], [[1.0, 0.0]], metadata=[{"embedding_model": "new"}]
    )
    index.replace_doc_chunks(
        "ready", ["current source"], [[0.8, 0.2]], metadata=[{"embedding_model": "new"}]
    )
    hits = index.search([1.0, 0.0], k=1, embedding_model="new", document_ids={"old", "ready"})
    assert [hit.text for hit in hits] == ["current source"]
