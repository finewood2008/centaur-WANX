"""Knowledge-base ownership checks and document upload orchestration.

Visibility is owner or instance-wide ``shared``.
"""

from __future__ import annotations

import hashlib
from dataclasses import asdict
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

from octop.config import DEFAULT_MAX_UPLOAD_MB, upload_mb_to_bytes
from octop.infra.db.repos.knowledge import KnowledgeBaseRow, KnowledgeDocumentRow
from octop.infra.knowledge.files import (
    delete_document_file,
    delete_knowledge_base_files,
    document_path,
    write_document,
)
from octop.infra.knowledge.gate import assert_knowledge_usable
from octop.infra.knowledge.index import KnowledgeIndex
from octop.infra.knowledge.jobs import request_document_reprocessing
from octop.infra.knowledge.ocr import (
    OCR_IMAGE_SUFFIXES,
    load_ocr_config,
    optional_ocr_extractor,
)
from octop.infra.knowledge.parse import parse_document
from octop.infra.knowledge.relpath import normalize_kb_path, path_basename, path_parent

MAX_DOCS_PER_KB = 100
MAX_BASES_PER_OWNER = 20
MAX_DOCUMENT_BYTES = upload_mb_to_bytes(DEFAULT_MAX_UPLOAD_MB)
# Upper bound for the per-base max_documents field. Mirrors Field(le=10000).
MAX_KB_MAX_DOCUMENTS = 10_000
_MAX_PREVIEW_CHARS = 200_000
_EXT_TO_CONTENT_TYPE = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".rst": "text/x-rst",
    ".html": "text/html",
    ".htm": "text/html",
    ".json": "application/json",
    ".jsonl": "application/jsonl",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
_ALLOWED_CONTENT_TYPES = set(_EXT_TO_CONTENT_TYPE.values())
_TEXT_CONTENT_TYPES = {"text/plain", "text/markdown"}
_TEXT_FORMAT_TO_EXT = {"md": ".md", "txt": ".txt"}
_TEXT_FORMAT_TO_CONTENT_TYPE = {"md": "text/markdown", "txt": "text/plain"}


class KnowledgeDocumentPage(TypedDict):
    items: list[dict[str, Any]]
    total: int
    has_more: bool
    next_cursor: str | None


class KnowledgeTextPage(TypedDict):
    kb_id: str
    document_id: str
    filename: str
    text: str
    start: int
    end: int
    total_chars: int
    source_version: str
    content_hash: str
    extracted_hash: str
    has_more: bool
    next_start: int | None
    status: Literal["ready", "unavailable", "stale"]


def _resolve_content_type(filename: str, content_type: str) -> str:
    suffix = Path(filename).suffix.lower()
    mapped = _EXT_TO_CONTENT_TYPE.get(suffix)
    if mapped is not None:
        return mapped
    ct = (content_type or "").strip().lower()
    if ct in _ALLOWED_CONTENT_TYPES:
        return ct
    if ct in {"", "application/octet-stream"}:
        return ct
    return ct


class KnowledgeService:
    """Apply ownership while keeping control-plane rows and files synchronized."""

    def __init__(self, services: Any, application_id: str = "wanx") -> None:
        self._services = services
        self.application_id = application_id

    def _require_usable(self) -> None:
        if self.application_id == "zhijun":
            assert_knowledge_usable(self._services.settings_repo.get, application_id="zhijun")
        else:
            assert_knowledge_usable(
                self._services.settings_repo.get, getattr(self._services, "provider_repo", None)
            )

    def _max_document_bytes(self) -> int:
        config = getattr(self._services, "config", None)
        limit = getattr(config, "max_upload_bytes", None)
        if isinstance(limit, int) and limit > 0:
            return limit
        return MAX_DOCUMENT_BYTES

    @property
    def _repo(self) -> Any:
        return self._services.knowledge_repo

    def create_base(
        self,
        *,
        owner_user_id: int,
        name: str,
        description: str = "",
        default_open: bool = False,
        shared: bool = False,
        icon_name: str = "",
        max_documents: int = MAX_DOCS_PER_KB,
    ) -> KnowledgeBaseRow:
        self._require_usable()
        if max_documents < 0 or max_documents > MAX_KB_MAX_DOCUMENTS:
            raise ValueError(f"max_documents must be between 0 and {MAX_KB_MAX_DOCUMENTS}")
        owned = self._repo.count_bases_for_owner(owner_user_id, application_id=self.application_id)
        if owned >= MAX_BASES_PER_OWNER:
            raise ValueError(f"a user can own at most {MAX_BASES_PER_OWNER} knowledge bases")
        if self.application_id != "wanx" and shared:
            raise PermissionError("Zhijun knowledge bases are private")
        model = (self._services.settings_repo.get("knowledge_embedding_model") or "").strip()
        return cast(
            KnowledgeBaseRow,
            self._repo.create_base(
                owner_user_id=owner_user_id,
                application_id=self.application_id,
                name=name,
                description=description,
                default_open=default_open,
                shared=shared,
                icon_name=icon_name,
                embedding_model=model,
                max_documents=max_documents,
            ),
        )

    def personal_base(self, *, owner_user_id: int) -> KnowledgeBaseRow:
        """Bind one owner-private archive without requiring the processing runtime."""
        if self.application_id != "zhijun":
            raise PermissionError("Personal archives are only available to Zhijun accounts")
        return cast(
            KnowledgeBaseRow,
            self._repo.create_base(
                owner_user_id=owner_user_id,
                application_id="zhijun",
                personal_archive=True,
                name="我的资料",
                default_open=True,
                shared=False,
                embedding_model=(
                    self._services.settings_repo.get("knowledge_embedding_model") or ""
                ).strip(),
                max_documents=MAX_DOCS_PER_KB,
            ),
        )

    def list_visible_bases(
        self, *, actor_user_id: int, is_admin: bool = False
    ) -> list[KnowledgeBaseRow]:
        if is_admin and self.application_id == "wanx":
            return cast(
                list[KnowledgeBaseRow], self._repo.list_all(application_id=self.application_id)
            )
        return cast(
            list[KnowledgeBaseRow],
            self._repo.list_visible(actor_user_id, application_id=self.application_id),
        )

    def update_base(
        self,
        kb_id: str,
        *,
        actor_user_id: int,
        name: str | None = None,
        description: str | None = None,
        default_open: bool | None = None,
        shared: bool | None = None,
        icon_name: str | None = None,
        max_documents: int | None = None,
        is_admin: bool = False,
    ) -> KnowledgeBaseRow:
        self.require_owner(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        if self.application_id != "wanx" and shared:
            raise PermissionError("Zhijun knowledge bases are private")
        if max_documents is not None and (
            max_documents < 0 or max_documents > MAX_KB_MAX_DOCUMENTS
        ):
            raise ValueError(f"max_documents must be between 0 and {MAX_KB_MAX_DOCUMENTS}")
        self._repo.update_base(
            kb_id,
            name=name,
            description=description,
            default_open=default_open,
            shared=shared,
            icon_name=icon_name,
            max_documents=max_documents,
        )
        return self._require_base(kb_id)

    def list_documents(
        self, kb_id: str, *, actor_user_id: int, is_admin: bool = False, prefix: str | None = None
    ) -> list[KnowledgeDocumentRow]:
        self.get_readable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        if prefix is None:
            return cast(list[KnowledgeDocumentRow], self._repo.list_documents(kb_id))
        return cast(list[KnowledgeDocumentRow], self._repo.list_children(kb_id, prefix))

    def list_documents_page(
        self,
        kb_id: str,
        *,
        actor_user_id: int,
        is_admin: bool = False,
        cursor: str | None = None,
        limit: int = 50,
    ) -> KnowledgeDocumentPage:
        """Read files in stable ID order, checking the library on every page."""
        self.get_readable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        if not 1 <= limit <= 200:
            raise ValueError("document page limit must be between 1 and 200")
        rows = cast(
            list[KnowledgeDocumentRow],
            self._repo.list_documents_page(
                kb_id,
                after_document_id=cursor,
                limit=limit + 1,
            ),
        )
        more = len(rows) > limit
        headers = KnowledgeIndex(kb_id).snapshot_headers(
            [row.id for row in rows[:limit] if row.status == "ready"]
        )
        items: list[dict[str, Any]] = []
        for row in rows[:limit]:
            header = headers.get(row.id)
            valid = header is not None and header.content_hash == row.content_hash
            items.append(
                {
                    **asdict(row),
                    "document_id": row.id,
                    "source_version": header.source_version if valid and header is not None else "",
                    "extracted_hash": header.extracted_hash if valid and header is not None else "",
                    "total_chars": header.total_chars if valid and header is not None else 0,
                }
            )
        return {
            "items": items,
            "total": self._repo.count_documents(kb_id),
            "has_more": more,
            "next_cursor": rows[limit - 1].id if more else None,
        }

    def read_document_text_page(
        self,
        kb_id: str,
        doc_id: str,
        *,
        actor_user_id: int,
        is_admin: bool = False,
        start: int = 0,
        limit: int = 12_000,
        source_version: str | None = None,
    ) -> KnowledgeTextPage:
        """Read a versioned canonical range; no preview truncation or implicit reparse."""
        self.get_readable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        if start < 0 or not 1 <= limit <= 12_000:
            raise ValueError("text range requires start >= 0 and limit between 1 and 12000")
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id or document.is_dir:
            raise LookupError("knowledge document not found")
        result: KnowledgeTextPage = {
            "kb_id": kb_id,
            "document_id": doc_id,
            "filename": document.filename,
            "text": "",
            "start": start,
            "end": start,
            "total_chars": 0,
            "source_version": "",
            "content_hash": document.content_hash,
            "extracted_hash": "",
            "has_more": False,
            "next_start": None,
            "status": "unavailable",
        }
        if document.status != "ready":
            return result
        snapshot = KnowledgeIndex(kb_id).read_snapshot_page(doc_id, start=start, limit=limit)
        try:
            original_hash = hashlib.sha256(
                document_path(kb_id, doc_id, document.filename).read_bytes()
            ).hexdigest()
        except FileNotFoundError:
            return result
        if (
            snapshot is None
            or original_hash != document.content_hash
            or (snapshot.content_hash != document.content_hash)
        ):
            if self._repo.update_document_if_current(
                doc_id,
                expected_content_hash=document.content_hash,
                expected_status="ready",
                status="pending",
                content_hash=original_hash,
            ):
                request_document_reprocessing(self._services, kb_id, doc_id)
            if source_version is not None and snapshot is not None:
                result["status"] = "stale"
            return result
        result.update(
            {
                "source_version": snapshot.source_version,
                "extracted_hash": snapshot.extracted_hash,
                "total_chars": snapshot.total_chars,
            }
        )
        if source_version is not None and source_version != snapshot.source_version:
            result["status"] = "stale"
            return result
        # An edit or access revocation during the range read may not return old text as current.
        self.get_readable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        fresh = self._repo.get_document(doc_id)
        if fresh is None or fresh.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        if fresh.status != "ready" or fresh.content_hash != document.content_hash:
            result["status"] = "stale"
            return result
        actual_start = min(start, snapshot.total_chars)
        end = actual_start + len(snapshot.text)
        more = end < snapshot.total_chars
        result.update(
            {
                "status": "ready",
                "text": snapshot.text,
                "start": actual_start,
                "end": end,
                "has_more": more,
                "next_start": end if more else None,
            }
        )
        return result

    def create_folder(
        self, kb_id: str, *, actor_user_id: int, path: str, is_admin: bool = False
    ) -> KnowledgeDocumentRow:
        self.get_writable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        return cast(KnowledgeDocumentRow, self._repo.ensure_folder(kb_id, path))

    def preview_document(
        self, kb_id: str, doc_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> dict[str, str]:
        """Return extracted plain text for a readable knowledge document."""
        self.get_readable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        if document.is_dir:
            raise LookupError("knowledge document not found")
        path = document_path(kb_id, doc_id, document.filename)
        text = parse_document(
            path, ocr=optional_ocr_extractor(self._services, application_id=self.application_id)
        )
        if len(text) > _MAX_PREVIEW_CHARS:
            text = text[:_MAX_PREVIEW_CHARS]
        return {
            "id": document.id,
            "kb_id": kb_id,
            "application_id": self.application_id,
            "filename": document.filename,
            "text": text,
        }

    def resolve_document_file(
        self, kb_id: str, doc_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> tuple[Path, str, str]:
        """Return ``(path, filename, content_type)`` for the on-disk original.

        Raises ``LookupError`` when the document row is missing and
        ``FileNotFoundError`` when the original bytes are gone from disk.
        """
        self.get_readable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        if document.is_dir:
            raise LookupError("knowledge document not found")
        path = document_path(kb_id, doc_id, document.filename)
        if not path.is_file():
            raise FileNotFoundError("knowledge document original file not found")
        return path, document.filename, document.content_type

    def document_has_original(self, document: KnowledgeDocumentRow) -> bool:
        """True when the uploaded original still exists on disk."""
        if document.is_dir:
            return False
        return document_path(document.kb_id, document.id, document.filename).is_file()

    def read_text_document(
        self, kb_id: str, doc_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> dict[str, str]:
        """Return raw UTF-8 text for an editable md/txt knowledge document."""
        self.get_readable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        if document.is_dir:
            raise LookupError("knowledge document not found")
        if document.content_type not in _TEXT_CONTENT_TYPES:
            raise ValueError("unsupported knowledge document content type: not editable text")
        raw = document_path(kb_id, doc_id, document.filename).read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError("knowledge document is not valid UTF-8 text") from exc
        return {
            "id": document.id,
            "filename": document.filename,
            "content_type": document.content_type,
            "text": text,
        }

    def create_text_document(
        self,
        kb_id: str,
        *,
        actor_user_id: int,
        name: str,
        format: str,
        content: str = "",
        is_admin: bool = False,
        path: str | None = None,
    ) -> KnowledgeDocumentRow:
        """Create a markdown or plain-text document with optional draft content."""
        fmt = (format or "").strip().lower().lstrip(".")
        if fmt not in _TEXT_FORMAT_TO_EXT:
            raise ValueError(f"unsupported knowledge document content type: {format}")
        cleaned_name = (name or "").strip()
        if not cleaned_name:
            raise ValueError("invalid knowledge document filename")
        ext = _TEXT_FORMAT_TO_EXT[fmt]
        stem = Path(cleaned_name).name
        if Path(stem).suffix.lower() not in {".md", ".txt"}:
            stem = f"{stem}{ext}"
        elif Path(stem).suffix.lower() != ext:
            stem = f"{Path(stem).stem}{ext}"
        relative = f"{normalize_kb_path(path)}/{stem}" if path else stem
        relative = normalize_kb_path(relative)
        encoded = content.encode("utf-8")
        return self.upload_document(
            kb_id,
            actor_user_id=actor_user_id,
            filename=stem,
            content_type=_TEXT_FORMAT_TO_CONTENT_TYPE[fmt],
            content=encoded,
            is_admin=is_admin,
            path=relative,
        )

    def update_text_document(
        self,
        kb_id: str,
        doc_id: str,
        *,
        actor_user_id: int,
        content: str,
        is_admin: bool = False,
    ) -> KnowledgeDocumentRow:
        """Overwrite md/txt content and mark the document pending for reindex."""
        self.get_writable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        self._require_usable()
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        if document.is_dir:
            raise LookupError("knowledge document not found")
        if document.content_type not in _TEXT_CONTENT_TYPES:
            raise ValueError("unsupported knowledge document content type: not editable text")
        encoded = content.encode("utf-8")
        limit = self._max_document_bytes()
        if len(encoded) > limit:
            raise ValueError(f"knowledge document size exceeds maximum of {limit} bytes")
        write_document(kb_id, document.id, document.filename, encoded)
        self._repo.update_document(
            doc_id,
            byte_size=len(encoded),
            content_hash=hashlib.sha256(encoded).hexdigest(),
            status="pending",
            error_message="",
            chunk_count=0,
        )
        refreshed = self._repo.get_document(doc_id)
        if refreshed is None:
            raise LookupError("knowledge document not found")
        return cast(KnowledgeDocumentRow, refreshed)

    def get_readable_base(
        self, kb_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> KnowledgeBaseRow:
        base = self._require_base(kb_id)
        if (
            (is_admin and self.application_id == "wanx")
            or base.owner_user_id == actor_user_id
            or (base.shared and self.application_id == "wanx")
        ):
            return base
        raise PermissionError("knowledge base read access is required")

    def get_writable_base(
        self, kb_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> KnowledgeBaseRow:
        base = self._require_base(kb_id)
        if (is_admin and self.application_id == "wanx") or base.owner_user_id == actor_user_id:
            return base
        raise PermissionError("knowledge base write access is required")

    def require_owner(
        self, kb_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> KnowledgeBaseRow:
        base = self._require_base(kb_id)
        if (is_admin and self.application_id == "wanx") or base.owner_user_id == actor_user_id:
            return base
        raise PermissionError("knowledge base owner access is required")

    def upload_document(
        self,
        kb_id: str,
        *,
        actor_user_id: int,
        filename: str,
        content_type: str,
        content: bytes,
        is_admin: bool = False,
        path: str | None = None,
    ) -> KnowledgeDocumentRow:
        base = self.get_writable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        self._require_usable()
        limit = self._max_document_bytes()
        if len(content) > limit:
            raise ValueError(f"knowledge document size exceeds maximum of {limit} bytes")
        rel = normalize_kb_path(path or filename)
        name = path_basename(rel)
        if not name:
            raise ValueError("invalid knowledge document filename")
        if (
            Path(name).suffix.lower() in OCR_IMAGE_SUFFIXES
            and not load_ocr_config(
                self._services.settings_repo.get, application_id=self.application_id
            ).enabled
        ):
            raise ValueError("knowledge OCR must be enabled for image documents")
        resolved_type = _resolve_content_type(name, content_type)
        if resolved_type not in _ALLOWED_CONTENT_TYPES:
            raise ValueError(f"unsupported knowledge document content type: {content_type}")
        # The per-base limit lives on the KB row (schema v10). 0 = unlimited.
        document = self._repo.create_document(
            kb_id=kb_id,
            filename=name,
            path=rel,
            content_type=resolved_type,
            byte_size=len(content),
            content_hash=hashlib.sha256(content).hexdigest(),
            max_documents=base.max_documents,
        )
        try:
            write_document(kb_id, document.id, name, content)
        except Exception:
            self._repo.delete_document(document.id)
            raise
        return cast(KnowledgeDocumentRow, document)

    def delete_document(
        self, kb_id: str, doc_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> None:
        self.get_writable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        removed = self._repo.delete_document(doc_id)
        for row in removed:
            if row.is_dir:
                continue
            KnowledgeIndex(kb_id).delete_doc(row.id)
            delete_document_file(kb_id, row.id, row.filename)

    def reindex_document(
        self, kb_id: str, doc_id: str, *, actor_user_id: int, is_admin: bool = False
    ) -> KnowledgeDocumentRow:
        self.get_writable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        self._require_usable()
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        if document.is_dir:
            raise ValueError("folders cannot be reindexed")
        self._repo.update_document(doc_id, status="pending", error_message="", chunk_count=0)
        refreshed = self._repo.get_document(doc_id)
        if refreshed is None:
            raise LookupError("knowledge document not found")
        return cast(KnowledgeDocumentRow, refreshed)

    def rename_document(
        self,
        kb_id: str,
        doc_id: str,
        *,
        new_name: str,
        actor_user_id: int,
        is_admin: bool = False,
    ) -> KnowledgeDocumentRow:
        """Rename a document (file or folder), rewriting descendant paths for folders."""
        self.get_writable_base(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        document = self._repo.get_document(doc_id)
        if document is None or document.kb_id != kb_id:
            raise LookupError("knowledge document not found")
        cleaned = (new_name or "").strip()
        if not cleaned or "/" in cleaned or "\\" in cleaned:
            raise ValueError("invalid knowledge document name")
        new_path = normalize_kb_path(f"{path_parent(document.path)}/{cleaned}")
        if new_path == document.path:
            return cast(KnowledgeDocumentRow, document)
        if self._repo.get_document_by_path(kb_id, new_path) is not None:
            raise ValueError("a knowledge document with this name already exists")
        result = self._repo.rename_document(kb_id, doc_id, cleaned)
        if result is None:
            raise LookupError("knowledge document not found")
        return cast(KnowledgeDocumentRow, result)

    def delete_base(self, kb_id: str, *, actor_user_id: int, is_admin: bool = False) -> None:
        self.require_owner(kb_id, actor_user_id=actor_user_id, is_admin=is_admin)
        self._repo.delete_base(kb_id)
        delete_knowledge_base_files(kb_id)

    def _require_base(self, kb_id: str) -> KnowledgeBaseRow:
        base = self._repo.get_base(kb_id, application_id=self.application_id)
        if base is None:
            raise LookupError("knowledge base not found")
        return cast(KnowledgeBaseRow, base)
