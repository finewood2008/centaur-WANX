"""Per-knowledge-base SQLite sidecar vector index."""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import struct
from collections.abc import Collection, Sequence
from dataclasses import dataclass
from pathlib import Path

from octop.infra.utils.paths import PathLayout


@dataclass(frozen=True)
class Hit:
    chunk_id: str
    doc_id: str
    ordinal: int
    text: str
    score: float
    metadata: dict[str, object]


@dataclass(frozen=True)
class DocumentSnapshot:
    """Canonical extracted text, versioned independently of vector settings."""

    text: str
    content_hash: str
    extracted_hash: str
    source_version: str

    @classmethod
    def from_text(cls, text: str, content_hash: str) -> DocumentSnapshot:
        # SQLite text substr treats NUL as a terminator; expose a visible replacement
        # in canonical extraction so a valid range can never stall before the end.
        canonical = text.replace("\x00", "\ufffd").strip()
        extracted_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        version = hashlib.sha256(f"{content_hash}:{extracted_hash}".encode()).hexdigest()
        return cls(canonical, content_hash, extracted_hash, version)


@dataclass(frozen=True)
class SnapshotPage:
    text: str
    total_chars: int
    content_hash: str
    extracted_hash: str
    source_version: str


@dataclass(frozen=True)
class SnapshotHeader:
    source_version: str
    extracted_hash: str
    total_chars: int
    content_hash: str


class KnowledgeIndex:
    """Store chunk embeddings in one local SQLite database per knowledge base."""

    def __init__(self, kb_id: str) -> None:
        self._path = PathLayout.from_env().knowledge_dir / kb_id / "index.sqlite"
        self._initialize()

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self._path)

    def _initialize(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS chunks (
                    chunk_id TEXT PRIMARY KEY,
                    doc_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    embedding BLOB NOT NULL,
                    meta_json TEXT NOT NULL DEFAULT '{}'
                );
                CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
                CREATE TABLE IF NOT EXISTS document_snapshots (
                    doc_id TEXT PRIMARY KEY,
                    text TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    extracted_hash TEXT NOT NULL,
                    source_version TEXT NOT NULL,
                    total_chars INTEGER NOT NULL
                );
                """
            )
            columns = {row[1] for row in conn.execute("PRAGMA table_info(document_snapshots)")}
            if "total_chars" not in columns:
                # An older sidecar is repaired through native extraction, not a full corpus scan.
                conn.execute(
                    "ALTER TABLE document_snapshots ADD COLUMN total_chars INTEGER NOT NULL DEFAULT 0"
                )

    def replace_doc_chunks(
        self,
        doc_id: str,
        texts: Sequence[str],
        embeddings: Sequence[Sequence[float]],
        *,
        metadata: Sequence[dict[str, object]] | None = None,
        snapshot: DocumentSnapshot | None = None,
    ) -> None:
        """Atomically replace all chunks belonging to one document."""
        if len(texts) != len(embeddings):
            raise ValueError("texts and embeddings must have the same length")
        if metadata is not None and len(metadata) != len(texts):
            raise ValueError("metadata and texts must have the same length")
        rows: list[tuple[str, str, int, str, bytes, str]] = []
        for ordinal, (text, embedding) in enumerate(zip(texts, embeddings, strict=True)):
            vector = [float(value) for value in embedding]
            if not vector:
                raise ValueError("embedding cannot be empty")
            meta = metadata[ordinal] if metadata is not None else {}
            rows.append(
                (
                    f"{doc_id}:{ordinal}",
                    doc_id,
                    ordinal,
                    text,
                    struct.pack(f"<{len(vector)}f", *vector),
                    json.dumps(meta, ensure_ascii=False, separators=(",", ":")),
                )
            )
        with self._connect() as conn:
            conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            conn.executemany(
                "INSERT INTO chunks(chunk_id, doc_id, ordinal, text, embedding, meta_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )
            if snapshot is not None:
                conn.execute(
                    "INSERT INTO document_snapshots(doc_id, text, content_hash, extracted_hash, "
                    "source_version, total_chars) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET "
                    "text = excluded.text, content_hash = excluded.content_hash, "
                    "extracted_hash = excluded.extracted_hash, source_version = excluded.source_version, total_chars = excluded.total_chars",
                    (
                        doc_id,
                        snapshot.text,
                        snapshot.content_hash,
                        snapshot.extracted_hash,
                        snapshot.source_version,
                        len(snapshot.text),
                    ),
                )

    def read_snapshot_page(self, doc_id: str, *, start: int, limit: int) -> SnapshotPage | None:
        """Read a character range without loading a large document into Python."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT substr(text, ?, ?), total_chars, content_hash, extracted_hash, "
                "source_version FROM document_snapshots WHERE doc_id = ?",
                (start + 1, limit, doc_id),
            ).fetchone()
        return SnapshotPage(*row) if row is not None and row[1] > 0 else None

    def snapshot_headers(self, document_ids: Collection[str]) -> dict[str, SnapshotHeader]:
        """Read only metadata for one bounded manifest page; never materialize source bodies."""
        if not document_ids:
            return {}
        placeholders = ",".join("?" for _ in document_ids)
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT doc_id, source_version, extracted_hash, total_chars, content_hash "
                f"FROM document_snapshots WHERE doc_id IN ({placeholders}) AND total_chars > 0",
                tuple(document_ids),
            ).fetchall()
        return {row[0]: SnapshotHeader(*row[1:]) for row in rows}

    def delete_doc(self, doc_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            conn.execute("DELETE FROM document_snapshots WHERE doc_id = ?", (doc_id,))

    def search(
        self,
        query_vec: Sequence[float],
        k: int,
        *,
        embedding_model: str | None = None,
        document_ids: Collection[str] | None = None,
    ) -> list[Hit]:
        """Return the ``k`` best chunk hits using in-process cosine similarity."""
        if k <= 0:
            return []
        query = [float(value) for value in query_vec]
        if not query:
            raise ValueError("query vector cannot be empty")
        query_norm = math.sqrt(sum(value * value for value in query))
        if query_norm == 0:
            raise ValueError("query vector cannot be zero")
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT chunk_id, doc_id, ordinal, text, embedding, meta_json FROM chunks"
            ).fetchall()
        hits: list[Hit] = []
        for chunk_id, doc_id, ordinal, text, blob, meta_json in rows:
            if document_ids is not None and doc_id not in document_ids:
                continue
            decoded = json.loads(meta_json)
            metadata = decoded if isinstance(decoded, dict) else {}
            if (
                embedding_model is not None
                and metadata.get("embedding_model", embedding_model) != embedding_model
            ):
                continue
            embedding = struct.unpack(f"<{len(blob) // 4}f", blob)
            if len(embedding) != len(query):
                continue
            norm = math.sqrt(sum(value * value for value in embedding))
            score = (
                0.0
                if norm == 0
                else sum(a * b for a, b in zip(query, embedding, strict=True)) / (query_norm * norm)
            )
            hits.append(
                Hit(
                    chunk_id=chunk_id,
                    doc_id=doc_id,
                    ordinal=ordinal,
                    text=text,
                    score=score,
                    metadata=metadata,
                )
            )
        return sorted(hits, key=lambda hit: hit.score, reverse=True)[:k]
