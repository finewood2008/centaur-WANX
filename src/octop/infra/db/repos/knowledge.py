"""Knowledge base metadata — bases and document rows."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from octop.infra.db.pool import DatabasePool
from octop.infra.db.repos._base import DbRow, bool_int, map_rows, now_ts, partial_updates
from octop.infra.knowledge.relpath import (
    ancestor_dirs,
    normalize_kb_path,
    path_basename,
    path_is_direct_child,
    path_parent,
)
from octop.infra.utils.ulid import new_short_id, new_ulid

_DIR_CONTENT_TYPE = "application/x-directory"


@dataclass(frozen=True)
class KnowledgeBaseRow:
    id: str
    pk: int
    owner_user_id: int
    name: str
    description: str
    default_open: bool
    shared: bool
    icon_name: str
    embedding_model: str
    embedding_dim: int
    doc_count: int
    max_documents: int
    created_at: int
    updated_at: int
    application_id: str = "wanx"

    @classmethod
    def from_row(cls, r: DbRow) -> KnowledgeBaseRow:
        # Schema v10 adds max_documents. Fall back to 100 for pre-v10 DBs.
        # sqlite3.Row has no __contains__; use keys() (like users.py).
        keys = frozenset(r.keys()) if hasattr(r, "keys") else frozenset()
        max_doc = int(r["max_documents"]) if "max_documents" in keys else 100
        return cls(
            id=str(r["knowledge_base_id"]),
            pk=int(r["id"]),
            owner_user_id=r["owner_user_id"],
            name=r["name"],
            description=r["description"],
            default_open=bool(r["default_open"]),
            shared=bool(r["shared"]),
            icon_name=str(r["icon_name"] or ""),
            embedding_model=r["embedding_model"],
            embedding_dim=r["embedding_dim"],
            doc_count=r["doc_count"],
            max_documents=max_doc,
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            application_id=str(r["application_id"]) if "application_id" in keys else "wanx",
        )


@dataclass(frozen=True)
class KnowledgeDocumentRow:
    id: str
    pk: int
    kb_id: str
    path: str
    filename: str
    is_dir: bool
    content_type: str
    byte_size: int
    content_hash: str
    status: str
    error_message: str
    chunk_count: int
    created_at: int
    updated_at: int

    @classmethod
    def from_row(cls, r: DbRow) -> KnowledgeDocumentRow:
        return cls(
            id=str(r["document_id"]),
            pk=int(r["id"]),
            kb_id=r["kb_id"],
            path=str(r["path"]),
            filename=str(r["filename"] or path_basename(str(r["path"]))),
            is_dir=bool(int(r["is_dir"])),
            content_type=r["content_type"],
            byte_size=r["byte_size"],
            content_hash=r["content_hash"],
            status=r["status"],
            error_message=r["error_message"],
            chunk_count=r["chunk_count"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
        )


class KnowledgeRepo:
    def __init__(self, db: DatabasePool) -> None:
        self._db = db

    def _allocate_base_id(self) -> str:
        for _ in range(16):
            kb_id = new_short_id()
            if self.get_base(kb_id, application_id=None) is None:
                return kb_id
        raise RuntimeError("failed to allocate unique knowledge base id")

    def create_base(
        self,
        *,
        owner_user_id: int,
        name: str,
        description: str = "",
        default_open: bool = False,
        shared: bool = False,
        icon_name: str = "",
        embedding_model: str = "",
        embedding_dim: int = 0,
        max_documents: int | None = None,
        application_id: str = "wanx",
        personal_archive: bool = False,
    ) -> KnowledgeBaseRow:
        kb_id = self._allocate_base_id()
        ts = now_ts()
        with self._db.transaction() as conn:
            if personal_archive and application_id == "zhijun":
                # Serialize account binding; preserve legacy rows rather than deleting data.
                if self._db.dialect == "postgresql":
                    conn.execute("SELECT pg_advisory_xact_lock(?, ?)", (72131, owner_user_id))
                existing = conn.execute(
                    "SELECT * FROM knowledge_bases WHERE owner_user_id = ? "
                    "AND application_id = 'zhijun' ORDER BY id ASC LIMIT 1",
                    (owner_user_id,),
                ).fetchone()
                if existing is not None:
                    return KnowledgeBaseRow.from_row(existing)
                default_open, shared = True, False
            if max_documents is None:
                # Rely on the column DEFAULT (100) for max_documents.
                conn.execute(
                    "INSERT INTO knowledge_bases("
                    "knowledge_base_id, owner_user_id, name, description, default_open, shared, "
                    "icon_name, embedding_model, embedding_dim, doc_count, created_at, updated_at, application_id"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
                    (
                        kb_id,
                        owner_user_id,
                        name,
                        description,
                        bool_int(default_open),
                        bool_int(shared),
                        icon_name,
                        embedding_model,
                        embedding_dim,
                        ts,
                        ts,
                        application_id,
                    ),
                )
            else:
                conn.execute(
                    "INSERT INTO knowledge_bases("
                    "knowledge_base_id, owner_user_id, name, description, default_open, shared, "
                    "icon_name, embedding_model, embedding_dim, doc_count, max_documents, "
                    "created_at, updated_at, application_id"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
                    (
                        kb_id,
                        owner_user_id,
                        name,
                        description,
                        bool_int(default_open),
                        bool_int(shared),
                        icon_name,
                        embedding_model,
                        embedding_dim,
                        max_documents,
                        ts,
                        ts,
                        application_id,
                    ),
                )
        row = self.get_base(kb_id, application_id=application_id)
        if row is None:
            raise RuntimeError(f"knowledge base insert failed: {kb_id}")
        return row

    def list_visible(self, user_id: int, application_id: str = "wanx") -> list[KnowledgeBaseRow]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT kb.* FROM knowledge_bases kb "
                "WHERE (kb.owner_user_id = ? OR (kb.shared = 1 AND kb.application_id = 'wanx')) "
                "AND kb.application_id = ? "
                "ORDER BY kb.name",
                (user_id, application_id),
            ).fetchall()
        return map_rows(rows, KnowledgeBaseRow)

    def list_all(self, application_id: str | None = "wanx") -> list[KnowledgeBaseRow]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM knowledge_bases "
                + ("WHERE application_id = ? " if application_id is not None else "")
                + "ORDER BY name",
                (application_id,) if application_id is not None else (),
            ).fetchall()
        return map_rows(rows, KnowledgeBaseRow)

    def count_bases_for_owner(self, owner_user_id: int, application_id: str = "wanx") -> int:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM knowledge_bases WHERE owner_user_id = ? AND application_id = ?",
                (owner_user_id, application_id),
            ).fetchone()
        return int(row["c"]) if row else 0

    def get_base(self, kb_id: str, application_id: str | None = "wanx") -> KnowledgeBaseRow | None:
        with self._db.connect() as conn:
            r = conn.execute(
                "SELECT * FROM knowledge_bases WHERE knowledge_base_id = ?"
                + (" AND application_id = ?" if application_id is not None else ""),
                (kb_id, application_id) if application_id is not None else (kb_id,),
            ).fetchone()
        return KnowledgeBaseRow.from_row(r) if r else None

    def update_base(
        self,
        kb_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        default_open: bool | None = None,
        shared: bool | None = None,
        icon_name: str | None = None,
        embedding_model: str | None = None,
        embedding_dim: int | None = None,
        doc_count: int | None = None,
        max_documents: int | None = None,
    ) -> None:
        fields, params = partial_updates(
            [
                ("name", name),
                ("description", description),
                ("default_open", bool_int(default_open) if default_open is not None else None),
                ("shared", bool_int(shared) if shared is not None else None),
                ("icon_name", icon_name),
                ("embedding_model", embedding_model),
                ("embedding_dim", embedding_dim),
                ("doc_count", doc_count),
                ("max_documents", max_documents),
            ]
        )
        if not fields:
            return
        fields.append("updated_at = ?")
        params.append(now_ts())
        params.append(kb_id)
        with self._db.transaction() as conn:
            conn.execute(
                f"UPDATE knowledge_bases SET {', '.join(fields)} WHERE knowledge_base_id = ?",
                params,
            )

    def delete_base(self, kb_id: str) -> None:
        with self._db.transaction() as conn:
            conn.execute("DELETE FROM knowledge_bases WHERE knowledge_base_id = ?", (kb_id,))

    def _get_document_by_path(
        self, conn: object, kb_id: str, path: str
    ) -> KnowledgeDocumentRow | None:
        r = conn.execute(  # type: ignore[attr-defined]
            "SELECT * FROM knowledge_documents WHERE kb_id = ? AND path = ?",
            (kb_id, path),
        ).fetchone()
        return KnowledgeDocumentRow.from_row(r) if r else None

    def ensure_folder(self, kb_id: str, path: str) -> KnowledgeDocumentRow:
        rel = normalize_kb_path(path)
        if not rel:
            raise ValueError("invalid knowledge folder path")
        ts = now_ts()
        with self._db.transaction() as conn:
            for folder in ancestor_dirs(rel) + [rel]:
                existing = self._get_document_by_path(conn, kb_id, folder)
                if existing is not None:
                    if not existing.is_dir:
                        raise ValueError(f"path exists and is not a folder: {folder}")
                    continue
                conn.execute(
                    "INSERT INTO knowledge_documents("
                    "document_id, kb_id, path, filename, is_dir, content_type, byte_size, "
                    "content_hash, status, error_message, chunk_count, created_at, updated_at"
                    ") VALUES (?, ?, ?, ?, 1, ?, 0, '', 'ready', '', 0, ?, ?)",
                    (new_ulid(), kb_id, folder, path_basename(folder), _DIR_CONTENT_TYPE, ts, ts),
                )
        row = self.get_document_by_path(kb_id, rel)
        if row is None:
            raise RuntimeError(f"knowledge folder insert failed: {rel}")
        return row

    def create_document(
        self,
        *,
        kb_id: str,
        filename: str,
        content_type: str,
        byte_size: int,
        content_hash: str = "",
        status: str = "pending",
        max_documents: int | None = None,
        path: str | None = None,
    ) -> KnowledgeDocumentRow:
        rel = normalize_kb_path(path or filename)
        if not rel:
            raise ValueError("invalid knowledge document path")
        name = path_basename(rel)
        for folder in ancestor_dirs(rel):
            self.ensure_folder(kb_id, folder)
        doc_id = new_ulid()
        ts = now_ts()
        # Treat both None (caller did not specify) and 0 (per-base "unlimited"
        # sentinel) as unbounded. Otherwise 0 would be enforced literally as
        # "at most 0 documents" and reject every create.
        enforce_limit = max_documents is not None and max_documents > 0
        with self._db.transaction() as conn:
            if enforce_limit:
                cursor = conn.execute(
                    "UPDATE knowledge_bases SET doc_count = doc_count + 1, updated_at = ? "
                    "WHERE knowledge_base_id = ? AND doc_count < ?",
                    (ts, kb_id, max_documents),
                )
                if cursor.rowcount != 1:
                    raise ValueError(f"knowledge bases support at most {max_documents} documents")
            conn.execute(
                "INSERT INTO knowledge_documents("
                "document_id, kb_id, path, filename, is_dir, content_type, byte_size, "
                "content_hash, status, error_message, chunk_count, created_at, updated_at"
                ") VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, '', 0, ?, ?)",
                (doc_id, kb_id, rel, name, content_type, byte_size, content_hash, status, ts, ts),
            )
            if not enforce_limit:
                conn.execute(
                    "UPDATE knowledge_bases SET doc_count = doc_count + 1, updated_at = ? "
                    "WHERE knowledge_base_id = ?",
                    (ts, kb_id),
                )
        row = self.get_document(doc_id)
        if row is None:
            raise RuntimeError(f"knowledge document insert failed: {doc_id}")
        return row

    def list_documents(self, kb_id: str) -> list[KnowledgeDocumentRow]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM knowledge_documents WHERE kb_id = ? ORDER BY is_dir DESC, path",
                (kb_id,),
            ).fetchall()
        return map_rows(rows, KnowledgeDocumentRow)

    def list_documents_page(
        self, kb_id: str, *, after_document_id: str | None = None, limit: int = 50
    ) -> list[KnowledgeDocumentRow]:
        """Keyset pagination over files; folders are not reading material."""
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM knowledge_documents WHERE kb_id = ? AND is_dir = 0 "
                "AND document_id > ? ORDER BY document_id LIMIT ?",
                (kb_id, after_document_id or "", limit),
            ).fetchall()
        return map_rows(rows, KnowledgeDocumentRow)

    def update_document_if_current(
        self,
        doc_id: str,
        *,
        expected_content_hash: str,
        expected_status: str,
        status: str,
        content_hash: str | None = None,
        error_message: str = "",
        chunk_count: int = 0,
    ) -> bool:
        """An old indexing job may not replace an edited document's state."""
        with self._db.transaction() as conn:
            result = conn.execute(
                "UPDATE knowledge_documents SET status = ?, content_hash = ?, error_message = ?, "
                "chunk_count = ?, updated_at = ? WHERE document_id = ? AND content_hash = ? "
                "AND status = ? AND is_dir = 0",
                (
                    status,
                    content_hash if content_hash is not None else expected_content_hash,
                    error_message,
                    chunk_count,
                    now_ts(),
                    doc_id,
                    expected_content_hash,
                    expected_status,
                ),
            )
        return bool(result.rowcount)

    def list_children(self, kb_id: str, prefix: str = "") -> list[KnowledgeDocumentRow]:
        parent = normalize_kb_path(prefix)
        return [row for row in self.list_documents(kb_id) if path_is_direct_child(row.path, parent)]

    def get_document(self, doc_id: str) -> KnowledgeDocumentRow | None:
        with self._db.connect() as conn:
            r = conn.execute(
                "SELECT * FROM knowledge_documents WHERE document_id = ?",
                (doc_id,),
            ).fetchone()
        return KnowledgeDocumentRow.from_row(r) if r else None

    def get_document_by_path(self, kb_id: str, path: str) -> KnowledgeDocumentRow | None:
        rel = normalize_kb_path(path)
        with self._db.connect() as conn:
            r = conn.execute(
                "SELECT * FROM knowledge_documents WHERE kb_id = ? AND path = ?",
                (kb_id, rel),
            ).fetchone()
        return KnowledgeDocumentRow.from_row(r) if r else None

    def update_document(
        self,
        doc_id: str,
        *,
        filename: str | None = None,
        content_type: str | None = None,
        byte_size: int | None = None,
        content_hash: str | None = None,
        status: str | None = None,
        error_message: str | None = None,
        chunk_count: int | None = None,
        path: str | None = None,
    ) -> None:
        fields, params = partial_updates(
            [
                ("filename", filename),
                ("path", normalize_kb_path(path) if path is not None else None),
                ("content_type", content_type),
                ("byte_size", byte_size),
                ("content_hash", content_hash),
                ("status", status),
                ("error_message", error_message),
                ("chunk_count", chunk_count),
            ]
        )
        if not fields:
            return
        fields.append("updated_at = ?")
        params.append(now_ts())
        params.append(doc_id)
        with self._db.transaction() as conn:
            conn.execute(
                f"UPDATE knowledge_documents SET {', '.join(fields)} WHERE document_id = ?",
                params,
            )

    def delete_document(self, doc_id: str) -> list[KnowledgeDocumentRow]:
        """Delete a file or a folder (and its descendants). Return removed rows."""
        ts = now_ts()
        document = self.get_document(doc_id)
        if document is None:
            return []
        with self._db.transaction() as conn:
            if document.is_dir:
                # Match descendants by a case-sensitive prefix, not ``path LIKE '<dir>/%'``:
                # ``_`` and ``%`` in a folder name are LIKE wildcards (deleting ``a_b`` also
                # matched ``axb/...``), and SQLite's LIKE is case-insensitive while PostgreSQL's
                # is not (deleting ``Docs`` also matched ``docs/...``). ``substr`` has the same
                # meaning on both backends.
                prefix = f"{document.path}/"
                rows = conn.execute(
                    "SELECT * FROM knowledge_documents WHERE kb_id = ? AND "
                    "(path = ? OR substr(path, 1, ?) = ?)",
                    (document.kb_id, document.path, len(prefix), prefix),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM knowledge_documents WHERE document_id = ?",
                    (doc_id,),
                ).fetchall()
            removed = map_rows(rows, KnowledgeDocumentRow)
            file_count = sum(1 for row in removed if not row.is_dir)
            ids = [row.id for row in removed]
            if ids:
                placeholders = ", ".join("?" * len(ids))
                conn.execute(
                    f"DELETE FROM knowledge_documents WHERE document_id IN ({placeholders})",
                    ids,
                )
            if file_count:
                conn.execute(
                    "UPDATE knowledge_bases SET doc_count = CASE "
                    "WHEN doc_count > ? THEN doc_count - ? ELSE 0 END, "
                    "updated_at = ? WHERE knowledge_base_id = ?",
                    (file_count, file_count, ts, document.kb_id),
                )
        return removed

    def count_documents(self, kb_id: str) -> int:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM knowledge_documents WHERE kb_id = ? AND is_dir = 0",
                (kb_id,),
            ).fetchone()
        return int(row["n"]) if row else 0

    def reindex_all_documents(
        self,
        embedding_model: str,
        application_id: str | None = None,
        *,
        only_outdated: bool = False,
    ) -> list[KnowledgeDocumentRow]:
        """Reset all document work after changing the shared embedding model."""
        ts = now_ts()
        filters: list[str] = []
        params: list[Any] = []
        if application_id is not None:
            filters.append("application_id = ?")
            params.append(application_id)
        if only_outdated:
            filters.append("embedding_model != ?")
            params.append(embedding_model)
        where = " WHERE " + " AND ".join(filters) if filters else ""
        with self._db.transaction() as conn:
            bases = conn.execute(
                "SELECT knowledge_base_id FROM knowledge_bases" + where, params
            ).fetchall()
            ids = [str(row["knowledge_base_id"]) for row in bases]
            if not ids:
                return []
            placeholders = ",".join("?" for _ in ids)
            conn.execute(
                "UPDATE knowledge_bases SET embedding_model = ?, embedding_dim = 0, updated_at = ? "
                f"WHERE knowledge_base_id IN ({placeholders})",
                [embedding_model, ts, *ids],
            )
            conn.execute(
                "UPDATE knowledge_documents "
                "SET status = 'pending', error_message = '', chunk_count = 0, updated_at = ? "
                f"WHERE is_dir = 0 AND kb_id IN ({placeholders})",
                [ts, *ids],
            )
            rows = conn.execute(
                "SELECT * FROM knowledge_documents WHERE status = 'pending' AND is_dir = 0 "
                f"AND kb_id IN ({placeholders}) "
                "ORDER BY kb_id, document_id",
                ids,
            ).fetchall()
        return map_rows(rows, KnowledgeDocumentRow)

    def rename_document(
        self, kb_id: str, doc_id: str, new_name: str
    ) -> KnowledgeDocumentRow | None:
        """Rename a document (file or folder), rewriting descendant paths for folders."""
        document = self.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            return None
        parent = path_parent(document.path)
        new_path = normalize_kb_path(f"{parent}/{new_name}")
        ts = now_ts()
        with self._db.transaction() as conn:
            if document.is_dir:
                # Rewrite the folder's own prefix once across all descendants.
                prefix = f"{document.path}/"
                conn.execute(
                    "UPDATE knowledge_documents SET "
                    "path = ? || substr(path, ?), updated_at = ? "
                    "WHERE kb_id = ? AND substr(path, 1, ?) = ?",
                    (new_path, len(document.path) + 1, ts, kb_id, len(prefix), prefix),
                )
            conn.execute(
                "UPDATE knowledge_documents SET "
                "filename = ?, path = ?, updated_at = ? "
                "WHERE document_id = ?",
                (new_name, new_path, ts, doc_id),
            )
        return self.get_document(doc_id)

    def resume_pending_documents(self) -> list[KnowledgeDocumentRow]:
        """Return pending work after resetting jobs interrupted while processing."""
        ts = now_ts()
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE knowledge_documents "
                "SET status = 'pending', error_message = '', updated_at = ? "
                "WHERE status = 'processing' AND is_dir = 0",
                (ts,),
            )
            rows = conn.execute(
                "SELECT * FROM knowledge_documents WHERE status = 'pending' AND is_dir = 0 "
                "ORDER BY kb_id, document_id"
            ).fetchall()
        return map_rows(rows, KnowledgeDocumentRow)
