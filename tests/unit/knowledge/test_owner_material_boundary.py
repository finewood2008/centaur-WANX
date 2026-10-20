"""Exercise owner-material authorization against real temporary knowledge files/indexes."""

from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest
from tests.unit.agents.test_role_ontology import Registry
from tests.unit.knowledge.test_source_pages import materials as materials

from octop.infra.agents import role_ontology as r
from octop.infra.agents import zhijun_owner_documents as m
from octop.infra.errors import OctopError
from octop.infra.knowledge import jobs
from octop.infra.knowledge.files import document_path


async def test_canonical_version_and_actual_kb_owner_are_checked(materials, monkeypatch):
    service, _, owner, other = materials
    service.application_id = "wanx"
    base = service.create_base(owner_user_id=owner, name="isolated material")
    text = "我希望合作时坦诚沟通。"
    doc = service.upload_document(
        base.id,
        actor_user_id=owner,
        filename="synthetic.md",
        content_type="text/markdown",
        content=text.encode(),
    )
    jobs.process_document(service._services, base.id, doc.id)
    registry = Registry()
    registry.rows["personal"].user_id = owner
    harness = registry.get_agent("personal")
    harness.config = NS(pick_default_model_ref=lambda: "synthetic/model")
    harness.model_factory = NS(get=lambda _: object())
    monkeypatch.setattr(m, "_knowledge", lambda _: service)
    monkeypatch.setattr(
        m,
        "ainvoke_text",
        AsyncMock(
            return_value='{"claims":[{"kind":"response","statement":"我希望合作时坦诚沟通。","quote":"我希望合作时坦诚沟通。"}]}'
        ),
    )
    with r.agent_scope(registry, owner, "personal"):
        view = await m.read_material(registry, owner, base.id, doc.id)
        assert view.text == text and view.ready
        for action in ["mark", "generate"]:
            view = await m.material_command(
                registry,
                owner,
                base.id,
                doc.id,
                m.MaterialCommand(
                    action=action,
                    expected_version=view.record.version,
                    request_id=action,
                    source_version=view.source_version,
                    model_ref=view.model_ref,
                ),
            )
        assert (await r.read_role_ontology(registry, owner)).claims[0].evidence_valid
        original = document_path(base.id, doc.id, doc.filename)
        assert original.read_text() == text
        original.write_text("原文已在隔离环境中修改")
        assert not (await r.read_role_ontology(registry, owner)).claims[0].evidence_valid
        foreign = service.create_base(owner_user_id=other, name="other owner")
        with pytest.raises(OctopError):
            await m.read_material(registry, owner, foreign.id, doc.id)
