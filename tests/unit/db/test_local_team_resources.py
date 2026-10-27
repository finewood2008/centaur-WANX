"""Publication is explicit and cannot adopt a private object by knowing its ID."""

import pytest

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.knowledge import KnowledgeRepo
from octop.infra.db.repos.local_team_resources import LocalTeamResourceRepo
from octop.infra.db.repos.users import UserRepo


@pytest.fixture
def resources(tmp_path):
    db = SqlitePool(tmp_path / "resources.sqlite")
    run_migrations(db)
    users = UserRepo(db)
    owner = users.create(username="owner", password_hash=None, role="user")
    other = users.create(username="other", password_hash=None, role="user")
    kb = KnowledgeRepo(db).create_base(owner_user_id=owner, name="Private")
    yield LocalTeamResourceRepo(db), owner, other, kb
    db.close()


def args(owner, kb):
    return {
        "box_id": "box:one",
        "epoch": 1,
        "resource_id": "team:knowledge:" + kb.id,
        "kind": "knowledge",
        "object_id": kb.id,
        "owner_user_id": owner,
        "before_commit": lambda: None,
    }


def test_knowledge_identifier_does_not_authorize_publication(resources):
    repo, owner, other, kb = resources
    with pytest.raises(ValueError):
        repo.publish(**args(other, kb))
    assert repo.list("box:one", 1) == []
    record = repo.publish(**args(owner, kb))
    assert record == repo.publish(**args(owner, kb))
    assert repo.get("box:one", 2, record["resource_id"]) is None
    for changes in ({"box_id": "box:two"}, {"epoch": 2}):
        with pytest.raises(ValueError):
            repo.publish(**{**args(owner, kb), **changes})


def test_authority_failure_before_publication_commit_rolls_back(resources):
    repo, owner, _, kb = resources

    def revoked():
        raise RuntimeError("synthetic revoke")

    with pytest.raises(RuntimeError):
        repo.publish(**{**args(owner, kb), "before_commit": revoked})
    assert repo.list("box:one", 1) == []
