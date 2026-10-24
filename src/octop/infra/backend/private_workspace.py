"""Protect service data even when a generic workspace resolves a local alias."""

from pathlib import Path
from typing import TYPE_CHECKING

from octop_harness.backends.workspace import BackendWorkspace

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.private_paths import (
    is_private_storage_path,
    is_relative_file_pattern,
    is_untrusted_workspace,
)

if TYPE_CHECKING:
    from deepagents.backends.protocol import GlobResult


class PrivateStorageWorkspace(BackendWorkspace):
    """A transport facade; authorized knowledge operations use their own service."""

    def __init__(
        self, workspace: BackendWorkspace, *, confined: bool, agent_id: str | None = None
    ) -> None:
        super().__init__(
            workspace.backend,
            workspace.workspace_dir,
            system_files_path=workspace.system_files_path,
        )
        self._confined = confined
        self._agent_id = agent_id

    def _check(self, value: str | Path) -> None:
        path = Path(value).expanduser().resolve()
        if is_private_storage_path(path) or (
            self._confined
            and (
                is_untrusted_workspace(self.workspace_dir, self._agent_id)
                or not path.is_relative_to(self.workspace_dir.resolve())
            )
        ):
            raise OctopError(ErrorCode.FORBIDDEN, "files require their own authorization")

    def resolve_path(self, path: str | Path | None, *, default: str | None = None) -> str:
        resolved = super().resolve_path(path, default=default)
        self._check(resolved)
        return resolved

    def _iter_materialize_candidates(
        self, path: str, *, map_system_paths: bool = True
    ) -> list[Path]:
        candidates = super()._iter_materialize_candidates(path, map_system_paths=map_system_paths)
        for candidate in candidates:
            self._check(candidate)
        return candidates

    def _backend_storage_key(
        self, path: str | Path | None, *, default: str | None = None, map_system_paths: bool = True
    ) -> str | None:
        raw = Path(path or default or ".").expanduser()
        self._check(raw if raw.is_absolute() else self.workspace_dir / raw)
        return super()._backend_storage_key(
            path, default=default, map_system_paths=map_system_paths
        )

    async def aglob(self, pattern: str, path: str = ".") -> "GlobResult | None":
        if self._confined and not is_relative_file_pattern(pattern):
            raise OctopError(ErrorCode.FORBIDDEN, "pattern must remain in the workspace")
        return await super().aglob(pattern, path)
