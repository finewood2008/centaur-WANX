"""A shared workspace stays inside its original storage and one exact space ID."""

from __future__ import annotations

import contextlib
import re
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from .local_scope import _scoped
from .service import SpaceError
from .workspaces import Workspaces


def create_team_space(
    root: Path, user_id: int, space_id: str, name: str, live: Callable[[], None]
) -> None:
    """Create a blank shareable workspace, never convert the personal root."""
    if re.fullmatch(r"[a-f0-9]{32}", space_id) is None:
        raise SpaceError("SPACE_LINK_SCOPE", 403)
    space = Workspaces(root, user_id)
    live()
    with space._db() as db:
        existing = db.execute("SELECT * FROM spaces WHERE id=?", (space_id,)).fetchone()
        if existing is not None:
            if existing["trashed"] is not None:
                raise SpaceError("SPACE_LINK_SCOPE", 403)
            return
        folder = uuid.uuid4().hex
        label = space._name(db, "", name or space_id)
        db.execute(
            "INSERT INTO spaces VALUES(?,?,?,?,NULL)", (space_id, label, folder, time.time())
        )
        db.execute(
            "INSERT INTO entries(id,parent,name,kind,modified,space_id) VALUES(?,'',?,'folder',?,?)",
            (folder, label, time.time(), space_id),
        )
        live()


class TeamSpace(Workspaces):
    def __init__(
        self, root: Path, user_id: int, *, space_id: str, live: Callable[[], None]
    ) -> None:
        self.space_id, self.live = space_id, live
        super().__init__(root, user_id)

    @contextlib.contextmanager
    def _db(self) -> Iterator[Any]:
        self.live()
        with super()._db() as db:
            yield db
            self.live()

    def _space(self, db: Any, space_id: str) -> Any:
        if space_id != self.space_id:
            raise SpaceError("SPACE_LINK_SCOPE", 403)
        return super()._space(db, space_id)

    def _entry(self, db: Any, item_id: str, *, trash: bool = False) -> Any:
        row = super()._entry(db, item_id, trash=trash)
        if row["space_id"] != self.space_id:
            raise SpaceError("SPACE_LINK_SCOPE", 403)
        return row

    def _check_scope(
        self, db: Any, name: str, args: tuple[Any, ...], kwargs: dict[str, Any]
    ) -> None:
        if name.startswith("upload_") and name != "upload_create":
            row = db.execute("SELECT space_id FROM uploads WHERE id=?", (args[0],)).fetchone()
            if row is None or row["space_id"] != self.space_id:
                raise SpaceError("SPACE_LINK_SCOPE", 403)
        if name == "upload_create" and (len(args) < 5 or args[4] != self.space_id):
            raise SpaceError("SPACE_LINK_SCOPE", 403)

    upload_create = _scoped("upload_create")
    upload_status = _scoped("upload_status")
    upload_chunk = _scoped("upload_chunk")
    upload_complete = _scoped("upload_complete")
    upload_cancel = _scoped("upload_cancel")

    def spaces(self) -> list[dict[str, Any]]:
        return [row for row in super().spaces() if row["id"] == self.space_id]
