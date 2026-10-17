"""Turn-scoped WANX knowledge and skill-package resources for Loops."""

from __future__ import annotations

import hashlib
from typing import Any, cast

from octop.infra.agents.application import application_id
from octop.infra.db.repos.knowledge import KnowledgeBaseRow
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.knowledge.default_open import stamp_turn_knowledge_config
from octop.infra.skills.skill_package_store import SkillPackageStore


class LoopResources:
    def __init__(self, service: Any):
        self.service = service

    def knowledge_base(self, user_id: int) -> KnowledgeBaseRow:
        svc = self.service
        user = svc.repos.user_repo.get(user_id)
        if not user or user.disabled or application_id(user) != "wanx":
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        return cast(
            KnowledgeBaseRow,
            svc.repos.knowledge_repo.create_base(
                owner_user_id=user_id,
                name="半人马环",
                loop_archive=True,
                description="所有半人马环共用的资料库",
                embedding_model=svc.repos.settings_repo.get("knowledge_embedding_model") or "",
            ),
        )

    def validate(self, user_id: int, knowledge_ids: list[str], package_ids: list[str]) -> None:
        svc = self.service
        base = self.knowledge_base(user_id)
        if any(kid != base.id for kid in knowledge_ids):
            raise OctopError.localized(ErrorCode.KNOWLEDGE_NOT_FOUND)
        if package_ids:
            svc.agents.validate_skill_package_ids(package_ids)

    def describe(
        self,
        user_id: int,
        knowledge_ids: list[str],
        package_ids: list[str],
        *,
        content: bool = False,
    ) -> dict[str, Any]:
        svc = self.service
        self.validate(user_id, knowledge_ids, package_ids)
        base = self.knowledge_base(user_id)
        bases = [base]
        knowledge_ids = [base.id]
        knowledge = [
            {"id": b.id, "name": b.name, "description": b.description}
            for b in bases
            if b.id in knowledge_ids
        ]
        packages = []
        total = 0
        if package_ids:
            store = SkillPackageStore(
                repo=svc.repos.skill_package_repo, root=svc.agents._paths.skill_packages_dir
            )
            for pid in package_ids:
                package = svc.repos.skill_package_repo.get(pid)
                if package is None:
                    raise OctopError.localized(ErrorCode.SKILL_PACKAGE_NOT_FOUND)
                skills = []
                for summary in store.list_skill_summaries(pid):
                    if summary.get("corrupt"):
                        raise OctopError.localized(ErrorCode.LOOP_INVALID)
                    path = store.package_skills_dir(pid) / summary["slug"] / "SKILL.md"
                    raw = path.read_text(encoding="utf-8")
                    total += len(raw)
                    if total > 100_000:
                        raise OctopError.localized(ErrorCode.LOOP_INVALID)
                    skills.append(
                        {
                            "name": summary["name"],
                            "description": summary["description"],
                            "sha256": hashlib.sha256(raw.encode()).hexdigest(),
                            **(
                                {"instructions": raw, "directory": str(path.parent)}
                                if content
                                else {}
                            ),
                        }
                    )
                if not skills:
                    raise OctopError.localized(ErrorCode.LOOP_INVALID)
                packages.append({"id": pid, "name": package.name, "skills": skills})
        return {"knowledge_bases": knowledge, "skill_packages": packages}

    def stamp(self, request: dict[str, Any], user_id: int, knowledge_ids: list[str]) -> None:
        svc = self.service
        user = svc.repos.user_repo.get(user_id)
        self.validate(user_id, knowledge_ids, [])
        base = self.knowledge_base(user_id)
        stamp_turn_knowledge_config(
            request,
            visible_bases=[base],
            explicit_ids=[base.id],
            owner_user_id=user_id,
            locale=user.locale if user else "zh",
        )
        # Package instructions are included in this Loop's own request. Never
        # mutate the shared expert's mounted packages or inherit unrelated skills.
        request["skills"] = []
