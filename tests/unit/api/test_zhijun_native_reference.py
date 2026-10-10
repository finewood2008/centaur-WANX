"""Run with WANX bundled Python; use only synthetic in-memory uploads."""

import io
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import UploadFile

from octop.api.routers import uploads
from octop.api.routers.chat.models import UserTurnWsFrame
from octop.api.routers.chat.turn import content_parts_from_dashboard_turn
from octop.infra.agents.attachment_sources import attachment_turn_content
from octop.infra.errors import OctopError


class Workspace:
    def __init__(self):
        self.files = {}

    async def aexists(self, path):
        return path in self.files

    async def aupload_bytes(self, path, data):
        self.files[path] = data

    async def adownload_bytes(self, path):
        return self.files.get(path)


class References(unittest.IsolatedAsyncioTestCase):
    async def test_owner_opt_in_uses_native_parser_and_reference_text(self):
        ws = Workspace()
        path = "inbound/1720000000000_reference.txt"
        text = "Synthetic reference marker ZJ-REF-7429"
        ws.files[path] = text.encode()
        stored = SimpleNamespace(data_path=path, filename="reference.txt", media_type="text/plain")
        server = SimpleNamespace(
            services=SimpleNamespace(config=SimpleNamespace(max_upload_bytes=10 * 1024 * 1024))
        )
        user = SimpleNamespace(id=4, locale="zh")
        row = SimpleNamespace(application_id="wanx")
        with (
            patch.object(uploads, "require_agent_row", return_value=row),
            patch.object(uploads, "require_agent_owner_row") as owner,
            patch.object(uploads, "require_running_workspace", new=AsyncMock(return_value=ws)),
            patch.object(uploads, "save_attachment", new=AsyncMock(return_value=stored)),
        ):
            result = await uploads.upload_attachment(
                "mine",
                UploadFile(filename="reference.txt", file=io.BytesIO(text.encode())),
                extract_text=True,
                user=user,
                server=server,
                as_user=None,
            )
            self.assertEqual(result["extraction_status"], "ready")
            owner.assert_called_once()
            turn = UserTurnWsFrame.model_validate(
                {
                    "type": "user_turn",
                    "thread_id": "t1",
                    "text": "summarize",
                    "extract_references": True,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "summarize"},
                                {
                                    "type": "file",
                                    "workspace_path": path,
                                    "filename": "reference.txt",
                                    "media_type": "text/plain",
                                },
                            ],
                        }
                    ],
                }
            ).to_turn_body()
            self.assertTrue(turn.extract_references)
            parts = content_parts_from_dashboard_turn(turn, strict_upload_paths=True)
            resolved = await attachment_turn_content(ws, parts, locale="zh")
            self.assertIn("ZJ-REF-7429", "\n".join(p.text for p in resolved))
            self.assertTrue(all(p.type == "text" for p in resolved))

    async def test_existing_wanx_uploads_keep_their_original_non_extraction_flow(self):
        ws = Workspace()
        stored = SimpleNamespace(
            data_path="inbound/1720000000000_reference.txt",
            filename="reference.txt",
            media_type="text/plain",
        )
        server = SimpleNamespace(
            services=SimpleNamespace(config=SimpleNamespace(max_upload_bytes=10000))
        )
        with (
            patch.object(
                uploads, "require_agent_row", return_value=SimpleNamespace(application_id="wanx")
            ),
            patch.object(uploads, "require_agent_owner_row") as owner,
            patch.object(uploads, "require_running_workspace", new=AsyncMock(return_value=ws)),
            patch.object(uploads, "save_attachment", new=AsyncMock(return_value=stored)),
            patch.object(uploads, "initialize_attachment_source", new=AsyncMock()) as extract,
        ):
            result = await uploads.upload_attachment(
                "mine",
                UploadFile(filename="reference.txt", file=io.BytesIO(b"fixture")),
                extract_text=False,
                user=SimpleNamespace(id=4),
                server=server,
                as_user=None,
            )
            self.assertNotIn("extraction_status", result)
            owner.assert_not_called()
            extract.assert_not_awaited()

    def test_reference_flag_is_explicit_and_strict_paths_reject_arbitrary_workspace_files(self):
        frame = UserTurnWsFrame.model_validate({"type": "user_turn", "text": "hello"})
        self.assertFalse(frame.to_turn_body().extract_references)
        turn = UserTurnWsFrame.model_validate(
            {
                "type": "user_turn",
                "text": "hello",
                "extract_references": True,
                "messages": [
                    {"role": "user", "content": [{"type": "file", "workspace_path": "AGENTS.md"}]}
                ],
            }
        ).to_turn_body()
        with self.assertRaises(OctopError):
            content_parts_from_dashboard_turn(turn, strict_upload_paths=True)


if __name__ == "__main__":
    unittest.main()
