"""Dashboard chat attachments — stored in agent workspace ``inbound/``."""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import BaseModel, Field

from octop.api.common.agent import require_agent_owner_row, require_agent_row
from octop.api.common.attachments import (
    StoredAttachment,
    dashboard_inbound_preview_url,
    save_attachment,
)
from octop.api.common.upload_limit import read_upload_capped
from octop.api.common.workspace import require_agent_workspace, require_running_workspace
from octop.api.deps import current_user, get_server
from octop.config import DEFAULT_MAX_UPLOAD_MB, upload_mb_to_bytes
from octop.infra.agents.application import application_id
from octop.infra.agents.attachment_sources import (
    SOURCE_READ_LIMIT,
    SOURCE_TEXT_LIMIT,
    initialize_attachment_source,
    read_attachment_source,
)
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.media.attachment_hints import sniff_image_media_type
from octop.infra.gateway.media.inbound_store import INBOUND_EXTENSION_MEDIA_TYPES

router = APIRouter()


class UploadedAttachmentResponse(BaseModel):
    path: str = Field(description="Stored original upload's workspace-relative inbound path.")
    workspace_path: str = Field(description="Exact path to send in a native chat file/image block.")
    url: str = Field(description="Same protected source/preview URL as access_url.")
    access_url: str = Field(
        description="Zhijun returns the owner-only upload/source JSON text endpoint, not original file bytes. WANX retains native preview/download URLs."
    )
    filename: str
    media_type: str
    extraction_status: Literal["ready", "empty", "unsupported", "failed"] | None = Field(
        default=None,
        description="Zhijun local extraction result; upload alone does not imply readable text or completed memory extraction.",
    )
    extraction_truncated: bool | None = Field(
        default=None,
        description=f"True when extracted text exceeded the {SOURCE_TEXT_LIMIT}-character retention cap.",
    )
    extraction_characters: int | None = Field(
        default=None,
        description="Full locally extracted text length before the retention cap, in characters.",
    )
    extraction_error: str | None = Field(
        default=None,
        description="Localized explanation for unavailable/failed text extraction; original upload remains retained.",
    )


class AttachmentSourceResponse(BaseModel):
    ok: bool = Field(description="True only when local extraction produced readable text.")
    path: str = Field(description="Original uploaded file path in this agent's inbound area.")
    filename: str
    media_type: str
    content: str = Field(description="Extracted reference text; render as plain text.")
    status: Literal["ready", "empty", "unsupported", "failed"] = Field(
        description="Actual local extraction state; only ready has readable text."
    )
    truncated: bool = Field(description="Original extraction exceeded the retained text cap.")
    total_chars: int = Field(
        description="Full locally extracted text length before the retention cap."
    )
    stored_chars: int = Field(
        description=f"Retained text length, at most {SOURCE_TEXT_LIMIT} characters."
    )
    has_more: bool = Field(description="More retained text can be read by increasing offset.")
    offset: int = Field(
        description="Zero-based character offset into retained text, not a byte offset."
    )
    limit: int = Field(description=f"Requested page size, at most {SOURCE_READ_LIMIT} characters.")
    error: str | None = Field(
        default=None, description="Localized extraction limitation or failure, if any."
    )


def _resolve_media_type(filename: str, content_type: str | None, data: bytes = b"") -> str:
    raw = (content_type or "").split(";", 1)[0].strip().lower()
    if raw and raw != "application/octet-stream":
        return raw
    ext = Path(filename or "").suffix.lower()
    if ext in INBOUND_EXTENSION_MEDIA_TYPES:
        return INBOUND_EXTENSION_MEDIA_TYPES[ext]
    guessed, _ = mimetypes.guess_type(filename or "")
    if guessed:
        return guessed.lower()
    sniffed = sniff_image_media_type(data)
    if sniffed:
        return sniffed
    return "application/octet-stream"


def _attachment_payload(agent_id: str, stored: StoredAttachment) -> dict[str, str]:
    path = stored.data_path
    preview_url = dashboard_inbound_preview_url(
        agent_id,
        path,
        media_type=stored.media_type,
    )
    return {
        "path": path,
        "workspace_path": path,
        "url": preview_url,
        "access_url": preview_url,
        "filename": stored.filename,
        "media_type": stored.media_type,
    }


@router.post(
    "/agents/{agent_id}/upload",
    summary="Upload a chat attachment",
    description="Store in the selected agent's inbound area. Zhijun extracts bounded reference text locally; unavailable OCR and extraction failures are reported without remote OCR calls.",
    response_model=UploadedAttachmentResponse,
    response_model_exclude_none=True,
)
async def upload_attachment(
    agent_id: str,
    file: UploadFile = File(...),  # noqa: B008
    as_user: int | None = None,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = require_agent_row(agent_id, user=user, as_user=as_user, server=server)
    if application_id(row) != "wanx":
        require_agent_owner_row(agent_id, user=user, as_user=as_user, server=server)
    ws = await require_running_workspace(agent_id, user=user, as_user=as_user, server=server)
    max_bytes = (
        int(server.services.config.max_upload_bytes) if server.services is not None else None
    )
    fallback = upload_mb_to_bytes(DEFAULT_MAX_UPLOAD_MB)
    data = await read_upload_capped(file, max_bytes=max_bytes or fallback)
    filename = file.filename or "upload.bin"
    media_type = _resolve_media_type(filename, file.content_type, data)
    stored = await save_attachment(
        ws,
        owner_id=user.id,
        filename=filename,
        media_type=media_type,
        data=data,
        max_bytes=max_bytes,
    )
    payload: dict[str, Any] = _attachment_payload(agent_id, stored)
    if application_id(row) == "zhijun":
        source = await initialize_attachment_source(
            ws,
            path=stored.data_path,
            filename=stored.filename,
            media_type=stored.media_type,
            data=data,
            services=server.services,
        )
        result = source.result(locale=getattr(user, "locale", None) or "zh")
        source_url = f"/api/agents/{quote(agent_id, safe='')}/upload/source?path={quote(stored.data_path, safe='')}"
        payload.update(
            url=source_url,
            access_url=source_url,
            extraction_status=source.status,
            extraction_truncated=source.truncated,
            extraction_characters=source.total_chars,
            extraction_error=result["error"],
        )
    return payload


@router.get(
    "/agents/{agent_id}/upload/source",
    summary="Read a Zhijun uploaded source",
    description=f"Owner-only plain extracted text from a registered upload in this profile. The signed application must be Zhijun. Does not expose workspace files or arbitrary original bytes. Each page reads at most {SOURCE_READ_LIMIT} characters from at most {SOURCE_TEXT_LIMIT} retained characters. Read subsequent pages using offset; has_more=false does not mean a truncated original was fully read.",
    response_model=AttachmentSourceResponse,
)
async def uploaded_source(
    agent_id: str,
    path: str = Query(..., description="Exact inbound path returned by upload."),
    offset: int = Query(
        0, ge=0, description="Zero-based character offset into retained extraction text."
    ),
    limit: int = Query(
        SOURCE_READ_LIMIT,
        ge=1,
        le=SOURCE_READ_LIMIT,
        description="Maximum extracted text characters in this page.",
    ),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = require_agent_owner_row(agent_id, user=user, as_user=None, server=server)
    if application_id(row) != "zhijun":
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    workspace = await require_agent_workspace(agent_id, user=user, server=server, owner_only=True)
    source = await read_attachment_source(workspace, path)
    return source.result(offset=offset, limit=limit, locale=getattr(user, "locale", None) or "zh")
