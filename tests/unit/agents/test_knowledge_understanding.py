"""Historical documents enter owned, revisable dialogue without becoming personal facts."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from octop.infra.agents import knowledge_understanding as understanding
from octop.infra.agents.understanding_types import UnderstandingLibrary, UnderstandingSettings
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.knowledge import KnowledgeRepo
from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.db.repos.users import UserRepo
from octop.infra.knowledge import jobs
from octop.infra.knowledge import service as service_module
from octop.infra.knowledge.service import KnowledgeService


class Workspace:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}

    async def aread_text(self, path: str) -> str | None:
        return self.files.get(path)

    async def aupload_bytes(self, path: str, content: bytes) -> None:
        self.files[path] = content.decode()


@pytest.fixture
def reading_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "home"))
    pool = SqlitePool(tmp_path / "test.db")
    run_migrations(pool)
    services = SimpleNamespace(
        knowledge_repo=KnowledgeRepo(pool),
        settings_repo=SettingsRepo(pool),
        user_repo=UserRepo(pool),
    )
    uid = services.user_repo.create(username="owner", password_hash="h", role="user")
    monkeypatch.setattr(service_module, "assert_knowledge_usable", lambda *_a, **_k: None)
    monkeypatch.setattr(jobs, "assert_knowledge_usable", lambda *_a, **_k: None)
    monkeypatch.setattr(
        jobs, "embed_knowledge_texts", lambda _s, texts, **_k: [[1.0, 0.0] for _ in texts]
    )
    knowledge = KnowledgeService(services, application_id="zhijun")
    base = knowledge.create_base(owner_user_id=uid, name="Past records")
    workspace = Workspace()
    harness = SimpleNamespace(
        workspace=workspace,
        _memory_runtime=SimpleNamespace(memory=None),
        config=SimpleNamespace(
            pick_default_model_ref=lambda: "own/default",
            resolve_model_ref=lambda _ref: (
                SimpleNamespace(base_url="http://127.0.0.1:11434"),
                "local",
            ),
        ),
        model_factory=SimpleNamespace(get=Mock(return_value=object())),
    )
    row = SimpleNamespace(agent_id="profile", user_id=uid, application_id="zhijun")
    registry = SimpleNamespace(
        get_application_profile=lambda user, _app: row if user == uid else None,
        get_agent=lambda _aid: harness,
        _repos=services,
    )
    monkeypatch.setattr(understanding, "_knowledge", lambda _registry: knowledge)
    model = AsyncMock(return_value='{"invitations": []}')
    monkeypatch.setattr(understanding, "ainvoke_text", model)
    yield SimpleNamespace(
        registry=registry,
        harness=harness,
        workspace=workspace,
        uid=uid,
        knowledge=knowledge,
        base=base,
        model=model,
        services=services,
    )
    pool.close()


def upload(env, text: str, *, base=None, filename="history.md"):
    target = base or env.base
    document = env.knowledge.upload_document(
        target.id,
        actor_user_id=env.uid,
        filename=filename,
        content_type="text/markdown",
        content=text.encode(),
    )
    jobs.process_document(env.services, target.id, document.id)
    return document


async def enable(env, role="personal", *, libraries=None):
    current = await understanding.read_understanding(env.registry, env.uid)
    return await understanding.update_understanding(
        env.registry,
        env.uid,
        UnderstandingSettings(
            revision=current.revision,
            enabled=True,
            libraries=libraries
            or [UnderstandingLibrary(kb_id=env.base.id, selected=True, role=role)],
        ),
    )


def proposal(quote="当时我希望先看分工落实，再决定投入。"):
    return json.dumps(
        {
            "invitations": [
                {
                    "title": "分工与投入",
                    "question": "这段经历对你现在的判断还有什么影响？",
                    "summary": "资料写到先观察分工再投入，实际含义需要本人核对。",
                    "quote": quote,
                    "suggested_statement": "合作时，我希望责任与决定权相配。",
                    "kind": "principle",
                }
            ]
        },
        ensure_ascii=False,
    )


async def test_no_model_before_start_and_no_change_means_no_extra_model(reading_env):
    env = reading_env
    document = upload(env, "原始资料")
    await understanding.read_understanding(env.registry, env.uid)
    await understanding.process_understanding_batch(env.registry, env.uid)
    env.model.assert_not_awaited()
    await enable(env)
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert state.documents[document.id].status == "complete"
    assert state.progress.characters_read == len("原始资料")
    assert env.harness._memory_runtime.memory is None
    await understanding.process_understanding_batch(env.registry, env.uid)
    assert env.model.await_count == 1
    assert "zhijun/personal-ontology.json" not in env.workspace.files


async def test_large_document_restart_resumes_exact_offset_and_complete_coverage(reading_env):
    env = reading_env
    content = "甲乙丙🙂。" * 44_000
    document = upload(env, content)
    await enable(env)
    await understanding.process_understanding_batch(env.registry, env.uid)
    first = await understanding.read_understanding(env.registry, env.uid)
    assert first.documents[document.id].offset == 12_000
    # Drop runtime locks while retaining the same server-owned workspace.
    env.registry = SimpleNamespace(
        get_application_profile=env.registry.get_application_profile,
        get_agent=env.registry.get_agent,
        _repos=env.services,
    )
    for _ in range(30):
        await understanding.process_understanding_batch(env.registry, env.uid)
        state = await understanding.read_understanding(env.registry, env.uid)
        if state.progress.status == "complete":
            break
    assert state.progress.characters_read == state.progress.characters_total == len(content)
    assert state.documents[document.id].offset == len(content)
    starts = [
        json.loads(call.args[1][1].content)["supplied_page"]["start"]
        for call in env.model.await_args_list
    ]
    assert starts == list(range(0, len(content), 12_000))


async def test_commit_rereads_source_after_model_and_rejects_changed_version(reading_env):
    env = reading_env
    text = "当时我希望先看分工落实，再决定投入。"
    document = upload(env, text)
    await enable(env)

    async def edited_during_model(*_args, **_kwargs):
        env.knowledge.update_text_document(
            env.base.id, document.id, actor_user_id=env.uid, content="后来我改变了看法。"
        )
        jobs.process_document(env.services, env.base.id, document.id)
        return proposal(text)

    env.model.side_effect = edited_during_model
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert state.invitations == []
    assert state.documents[document.id].offset == 0


async def test_pause_or_role_edit_while_model_running_wins_over_result(reading_env):
    env = reading_env
    upload(env, "当时我希望先看分工落实，再决定投入。")
    await enable(env)
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow(*_args, **_kwargs):
        entered.set()
        await release.wait()
        return proposal()

    env.model.side_effect = slow
    running = asyncio.create_task(understanding.process_understanding_batch(env.registry, env.uid))
    await entered.wait()
    current = await understanding.read_understanding(env.registry, env.uid)
    await understanding.update_understanding(
        env.registry,
        env.uid,
        UnderstandingSettings(
            revision=current.revision,
            enabled=False,
            libraries=[UnderstandingLibrary(kb_id=env.base.id, selected=True, role="reference")],
        ),
    )
    release.set()
    await running
    state = await understanding.read_understanding(env.registry, env.uid)
    assert not state.enabled and state.progress.status == "paused"
    assert not state.invitations
    assert state.libraries[0].role == "reference"


async def test_model_failure_is_visible_bounded_and_explicit_start_retries(reading_env):
    env = reading_env
    document = upload(env, "原始经历")
    await enable(env)
    env.model.side_effect = RuntimeError("synthetic model unavailable")
    for _ in range(4):
        await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert state.progress.status == "failed"
    assert state.documents[document.id].status == "failed"
    assert env.model.await_count == 3 and not state.invitations
    env.model.side_effect = None
    await understanding.set_understanding_running(
        env.registry, env.uid, state.revision, enabled=True
    )
    await understanding.process_understanding_batch(env.registry, env.uid)
    restored = await understanding.read_understanding(env.registry, env.uid)
    assert restored.progress.status == "complete" and env.model.await_count == 4


async def test_reference_material_cannot_automatically_form_personal_statement(reading_env):
    env = reading_env
    upload(env, "当时我希望先看分工落实，再决定投入。")
    await enable(env, role="reference")
    env.model.return_value = proposal()
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert len(state.invitations) == 1
    invitation = state.invitations[0]
    assert invitation.role == "reference" and invitation.suggested_statement == ""
    source = await understanding.resolve_invitation(env.registry, env.uid, invitation.id)
    assert source["source"]["end"] - source["source"]["start"] == len(invitation.quote)
    assert "zhijun/personal-ontology.json" not in env.workspace.files


async def test_same_second_edit_still_reads_new_source_version(reading_env):
    env = reading_env
    document = upload(env, "原来的经历")
    await enable(env)
    await understanding.process_understanding_batch(env.registry, env.uid)
    previous = await understanding.read_understanding(env.registry, env.uid)
    timestamp = int(previous.documents[document.id].updated_at)
    env.knowledge.update_text_document(
        env.base.id, document.id, actor_user_id=env.uid, content="改变后的经历"
    )
    jobs.process_document(env.services, env.base.id, document.id)
    # Make the regression deterministic: the native DB uses second resolution.
    with env.services.knowledge_repo._db.transaction() as conn:
        conn.execute(
            "UPDATE knowledge_documents SET updated_at = ? WHERE document_id = ?",
            (timestamp, document.id),
        )
    await understanding.process_understanding_batch(env.registry, env.uid)
    latest = await understanding.read_understanding(env.registry, env.uid)
    assert env.model.await_count == 2
    assert (
        latest.documents[document.id].source_version
        != previous.documents[document.id].source_version
    )


async def test_temporary_reindex_does_not_permanently_invalidate_invitation(reading_env):
    env = reading_env
    document = upload(env, "当时我希望先看分工落实，再决定投入。")
    await enable(env)
    env.model.return_value = proposal()
    await understanding.process_understanding_batch(env.registry, env.uid)
    old = await understanding.read_understanding(env.registry, env.uid)
    invitation_id = old.invitations[0].id
    env.knowledge.reindex_document(env.base.id, document.id, actor_user_id=env.uid)
    await understanding.process_understanding_batch(env.registry, env.uid)
    jobs.process_document(env.services, env.base.id, document.id)
    await understanding.process_understanding_batch(env.registry, env.uid)
    restored = await understanding.read_understanding(env.registry, env.uid)
    assert env.model.await_count == 1
    assert restored.invitations[0].id == invitation_id
    assert restored.invitations[0].status == "pending"
    assert (await understanding.resolve_invitation(env.registry, env.uid, invitation_id))["quote"]


async def test_same_canonical_body_with_different_newlines_is_not_independent_reading(reading_env):
    env = reading_env
    upload(env, "当时我希望先看分工落实，再决定投入。\n下一行", filename="first.md")
    upload(env, "当时我希望先看分工落实，再决定投入。\r\n下一行", filename="second.md")
    await enable(env)
    env.model.return_value = proposal()
    await understanding.process_understanding_batch(env.registry, env.uid)
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert state.progress.documents_read == 2
    assert env.model.await_count == 1 and len(state.invitations) == 1


async def test_native_processing_failure_is_visible_and_ready_recovery_is_read(reading_env):
    env = reading_env
    document = env.knowledge.upload_document(
        env.base.id,
        actor_user_id=env.uid,
        filename="empty.md",
        content_type="text/markdown",
        content=b" ",
    )
    with pytest.raises(ValueError, match="no extractable text"):
        jobs.process_document(env.services, env.base.id, document.id)
    await enable(env)
    await understanding.process_understanding_batch(env.registry, env.uid)
    failed = await understanding.read_understanding(env.registry, env.uid)
    assert failed.progress.failed_documents == 1 and env.model.await_count == 0
    env.knowledge.update_text_document(
        env.base.id, document.id, actor_user_id=env.uid, content="补齐资料"
    )
    jobs.process_document(env.services, env.base.id, document.id)
    await understanding.process_understanding_batch(env.registry, env.uid)
    recovered = await understanding.read_understanding(env.registry, env.uid)
    assert recovered.progress.documents_read == 1 and env.model.await_count == 1


async def test_declared_personal_copy_does_not_lose_role_to_completed_reference_copy(
    reading_env, monkeypatch
):
    env = reading_env
    personal = env.knowledge.create_base(owner_user_id=env.uid, name="My writing")
    text = "当时我希望先看分工落实，再决定投入。"
    upload(env, text, filename="reference.md")
    upload(env, text, base=personal, filename="personal.md")
    monkeypatch.setattr(env.knowledge, "list_visible_bases", lambda **_kwargs: [env.base, personal])
    await enable(
        env,
        libraries=[
            UnderstandingLibrary(kb_id=env.base.id, selected=True, role="reference"),
            UnderstandingLibrary(kb_id=personal.id, selected=True, role="personal"),
        ],
    )
    env.model.return_value = proposal()
    await understanding.process_understanding_batch(env.registry, env.uid)
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert state.progress.documents_read == 2
    assert any(
        invitation.role == "personal" and invitation.suggested_statement
        for invitation in state.invitations
    )
    assert all(
        not invitation.suggested_statement
        for invitation in state.invitations
        if invitation.role == "reference"
    )


async def test_changed_extraction_same_original_and_clock_is_reprocessed(reading_env, monkeypatch):
    env = reading_env
    document = upload(env, "original source")
    await enable(env)
    await understanding.process_understanding_batch(env.registry, env.uid)
    previous = await understanding.read_understanding(env.registry, env.uid)
    reading = previous.documents[document.id]
    env.knowledge.reindex_document(env.base.id, document.id, actor_user_id=env.uid)
    monkeypatch.setattr(jobs, "parse_document", lambda *_a, **_k: "improved source extraction")
    jobs.process_document(env.services, env.base.id, document.id)
    with env.services.knowledge_repo._db.transaction() as conn:
        conn.execute(
            "UPDATE knowledge_documents SET updated_at = ? WHERE document_id = ?",
            (int(reading.updated_at), document.id),
        )
    manifest = env.knowledge.list_documents_page(env.base.id, actor_user_id=env.uid)["items"][0]
    assert manifest["content_hash"] == reading.content_hash
    assert manifest["source_version"] != reading.source_version
    await understanding.process_understanding_batch(env.registry, env.uid)
    latest = await understanding.read_understanding(env.registry, env.uid)
    assert latest.documents[document.id].source_version == manifest["source_version"]
    assert env.model.await_count == 2


async def test_one_bad_suggestion_does_not_discard_another_verified_question(reading_env):
    env = reading_env
    upload(env, "当时我希望先看分工落实，再决定投入。")
    await enable(env)
    payload = json.loads(proposal())
    invalid = {**payload["invitations"][0], "title": "无依据", "quote": "并未出现在资料里的话"}
    payload["invitations"].append(invalid)
    env.model.return_value = json.dumps(payload, ensure_ascii=False)
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert state.progress.status == "complete"
    assert len(state.invitations) == 1
    assert state.invitations[0].title == "分工与投入"


async def test_resolved_invitation_cannot_read_a_library_removed_during_the_same_turn(reading_env):
    from octop.infra.errors import OctopError

    env = reading_env
    upload(env, "当时我希望先看分工落实，再决定投入。")
    await enable(env)
    env.model.return_value = proposal()
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    invitation = state.invitations[0]
    recognized = await understanding.record_understanding_response(
        env.registry,
        env.uid,
        invitation.id,
        quote="这段确实是我的经历",
        turn_id="actual-turn",
        action="recognize",
        revision=state.revision,
    )
    assert (
        await understanding.resolve_invitation(
            env.registry, env.uid, invitation.id, reviewed_turn="actual-turn"
        )
    )["quote"] == invitation.quote
    await understanding.update_understanding(
        env.registry,
        env.uid,
        UnderstandingSettings(
            revision=recognized.revision,
            libraries=[UnderstandingLibrary(kb_id=env.base.id, selected=False, role="personal")],
        ),
    )
    with pytest.raises(OctopError):
        await understanding.resolve_invitation(
            env.registry, env.uid, invitation.id, reviewed_turn="actual-turn"
        )
