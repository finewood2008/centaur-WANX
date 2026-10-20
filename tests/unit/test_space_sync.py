"""Real transactional task handoffs, identity boundaries and acknowledgement replay."""

import hashlib
import uuid

import pytest

from octop.infra.personal_space.service import SpaceError
from octop.infra.personal_space.sync import DEFAULT_SYNC
from octop.infra.personal_space.workspaces import Workspaces


def start(service, agent, **changes):
    args = {
        "request_id": uuid.uuid4().hex,
        "title": "合成任务",
        "policy_revision": 1,
        "categories": {"context": {"status": "provided", "summary": "仅使用合成资料"}},
    }
    args.update(changes)
    return service.agent_execute(agent["token"], "task-begin", **args), args


def binding(task, **changes):
    return dict(task_id=task["task_id"], policy_revision=1, **changes)


def setup(tmp_path):
    service = Workspaces(tmp_path, 1)
    a = service.approve("a", "同名 Agent", sync_policy=DEFAULT_SYNC)
    b = service.approve("b", "同名 Agent", sync_policy=DEFAULT_SYNC)
    return service, a, b


def test_initial_context_and_persisted_ack_replay(tmp_path):
    s, a, b = setup(tmp_path)
    with pytest.raises(SpaceError, match="SPACE_CONTEXT_REQUIRED"):
        s.agent_execute(a["token"], "list")
    task, args = start(s, a)
    restarted = Workspaces(tmp_path, 1)
    assert restarted.agent_execute(a["token"], "task-begin", **args) == task
    assert len(restarted.sync_status(a["id"])["tasks"]) == 1
    assert restarted.sync_status(a["id"])["tasks"][0]["record_count"] == 1
    with pytest.raises(SpaceError, match="SPACE_SYNC_REQUEST_CONFLICT"):
        restarted.agent_execute(a["token"], "task-begin", **(args | {"title": "different"}))
    with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
        s.agent_execute(b["token"], "task-begin", **args)
    for action in ("task-records", "list", "task-checkpoint"):
        with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
            s.agent_execute(b["token"], action, **binding(task, request_id="foreign", expected=1))
    assert Workspaces(tmp_path, 2).spaces()[0]["id"] == "personal"
    with pytest.raises(SpaceError, match="SPACE_AGENT_DISCONNECTED"):
        Workspaces(tmp_path, 2).agent_execute(a["token"], "sync-status")


def test_mutation_progress_and_lost_ack_do_not_repeat_files_or_checkpoints(tmp_path):
    s, a, b = setup(tmp_path)
    task, _ = start(s, a)
    args = binding(task, name="sample", operation_id="create-one", progress="建立合成目录")
    folder = s.agent_execute(a["token"], "mkdir", **args)
    assert Workspaces(tmp_path, 1).agent_execute(a["token"], "mkdir", **args) == folder
    state = s.sync_status(a["id"])
    assert state["tasks"][0]["version"] == 2
    assert state["tasks"][0]["record_count"] == 2
    assert len(s.listing(space_id=a["space_id"])["items"]) == 1
    with pytest.raises(SpaceError, match="SPACE_SYNC_REQUEST_CONFLICT"):
        s.agent_execute(a["token"], "mkdir", **(args | {"name": "another"}))
    with pytest.raises(SpaceError, match="SPACE_PROGRESS_REQUIRED"):
        s.agent_execute(
            a["token"], "mkdir", **binding(task, name="no-progress", operation_id="bad")
        )
    assert len(s.listing(space_id=a["space_id"])["items"]) == 1
    assert s.sync_status(b["id"])["tasks"] == []


def test_policy_change_pause_and_revoke_rechecked_at_commit(tmp_path):
    s, a, _ = setup(tmp_path)
    task, _ = start(s, a)
    upload = uuid.uuid4().hex
    data = b"small synthetic file"
    args = binding(task, upload_id=upload)
    s.agent_execute(a["token"], "begin-write", **args, name="result.txt", size=len(data))
    s.agent_execute(
        a["token"], "write-chunk", **args, data=data, digest=hashlib.sha256(data).hexdigest()
    )
    commit = args | {"digest": hashlib.sha256(data).hexdigest(), "progress": "保存合成结果"}
    s.connection_action(a["id"], "pause")
    for action in ("sync-status", "task-records", "commit-write"):
        with pytest.raises(SpaceError, match="SPACE_AGENT_PAUSED"):
            s.agent_execute(a["token"], action, **commit)
    s.connection_action(a["id"], "resume")
    s.set_sync_policy(a["id"], DEFAULT_SYNC | {"outcome": False}, 1)
    with pytest.raises(SpaceError, match="SPACE_SYNC_POLICY_CHANGED"):
        s.agent_execute(a["token"], "commit-write", **commit)
    assert s.listing(space_id=a["space_id"])["items"] == []
    commit["policy_revision"] = 2
    saved = s.agent_execute(a["token"], "commit-write", **commit)
    assert s.agent_execute(a["token"], "commit-write", **commit)["id"] == saved["id"]
    assert s.sync_status(a["id"])["tasks"][0]["record_count"] == 2
    s.connection_action(a["id"], "disconnect")
    with pytest.raises(SpaceError, match="SPACE_AGENT_DISCONNECTED"):
        s.agent_execute(a["token"], "task-begin", request_id="later")


def test_finish_conflicts_disabled_categories_and_independent_tasks(tmp_path):
    s, a, _ = setup(tmp_path)
    task, _ = start(s, a)
    other, _ = start(s, a)
    with pytest.raises(SpaceError, match="SPACE_SYNC_CATEGORY_DISABLED"):
        start(s, a, categories={"user_memory": {"status": "provided", "summary": "not selected"}})
    with pytest.raises(SpaceError, match="SPACE_OUTCOME_REQUIRED"):
        s.agent_execute(
            a["token"], "task-finish", **binding(task, expected=1, request_id="missing")
        )
    args = binding(
        task,
        expected=1,
        request_id="finish",
        categories={"outcome": {"status": "provided", "summary": "完成，内容仅为合成样本"}},
    )
    result = s.agent_execute(a["token"], "task-finish", **args)
    assert s.agent_execute(a["token"], "task-finish", **args) == result
    with pytest.raises(SpaceError, match="SPACE_SYNC_TASK_FINISHED"):
        s.agent_execute(a["token"], "list", **binding(task))
    assert s.agent_execute(a["token"], "list", **binding(other))["items"] == []
    assert len(s.sync_status(a["id"])["tasks"]) == 2


def test_context_storage_migration_usage_and_owner_cleanup(tmp_path):
    s, a, _ = setup(tmp_path)
    task, _ = start(s, a)
    size = s.sync_status(a["id"])["bytes"]
    assert size > 0
    assert next(space for space in s.spaces() if space["id"] == a["space_id"])["sync_bytes"] == size
    destination = tmp_path / "volume"
    destination.mkdir()
    assert s.storage_location(a["space_id"], str(destination))["migrated_objects"] == 1
    assert (
        s.sync_records(a["id"], task["task_id"])["items"][0]["content"]["categories"]["context"][
            "summary"
        ]
        == "仅使用合成资料"
    )
    assert s.storage_location(a["space_id"], "")["migrated_objects"] == 1
    with pytest.raises(SpaceError, match="SPACE_NOT_FOUND"):
        s.sync_records("unknown", task["task_id"])
    s.delete_sync_task(a["id"], task["task_id"])
    assert s.sync_status(a["id"])["bytes"] == 0
    assert not list(s.objects.iterdir())
    assert s.overview()["syncBytes"] == 0


def test_memory_availability_and_reconnection_never_claim_full_export(tmp_path):
    s, a, _ = setup(tmp_path)
    with pytest.raises(SpaceError, match="SPACE_SYNC_PROJECT_REQUIRED"):
        s.set_sync_policy(a["id"], DEFAULT_SYNC | {"project_memory": True}, 1)
    policy = DEFAULT_SYNC | {"project_memory": True, "project_scope": "synthetic"}
    s.set_sync_policy(a["id"], policy, 1)
    task, _ = start(
        s,
        a,
        policy_revision=2,
        categories={
            "context": {"status": "provided", "summary": "test"},
            "project_memory": {"status": "unsupported", "reason": "host has no export"},
        },
    )
    item = s.sync_status(a["id"])["tasks"][0]
    assert item["categories"]["project_memory"]["status"] == "unsupported"
    assert item["state"] == "active"
    legacy = s.approve("legacy", "Legacy")
    assert not s.sync_status(legacy["id"])["policy"]["configured"]
    assert s.agent_execute(legacy["token"], "list")["items"] == []
    assert task["saved"]


def test_saved_file_ack_never_extends_scope_after_owner_moves_resource(tmp_path):
    s, a, _ = setup(tmp_path)
    task, _ = start(s, a)
    folder = s.mkdir("", "granted")
    grant = s.grant(a["id"], folder["id"])
    args = binding(task, name="child", operation_id="granted-create", progress="synthetic")
    child = s.agent_execute(a["token"], "mkdir", grant["id"], **args)
    s.move(child["id"], "", child["name"])
    with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
        s.agent_execute(a["token"], "mkdir", grant["id"], **args)
    with pytest.raises(SpaceError, match="SPACE_LINK_SCOPE"):
        s.agent_execute(a["token"], "task-records", grant["id"], task_id=task["task_id"])


def test_invalid_sync_data_returns_a_domain_error_without_partial_records(tmp_path):
    s, a, _ = setup(tmp_path)
    for status in ({}, [], None):
        with pytest.raises(SpaceError, match="SPACE_SYNC_CONTENT_INVALID"):
            start(s, a, categories={"context": {"status": status}})
    assert s.sync_status(a["id"])["tasks"] == []
