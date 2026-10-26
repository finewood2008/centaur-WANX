"""Real schema-31/32 DB, personal-space objects and independent Studio DB."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

import pytest

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.local_data_principals import LocalDataPrincipalRepo
from octop.infra.personal_space.service import PersonalSpace
from octop.infra.users.team_migration import (
    MigrationError,
    MigrationIdentity,
    MigrationPaths,
    _canonical,
    _digest,
    apply_plan,
    build_plan,
)

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="Offline managed migration uses POSIX writer fences"
)


@pytest.fixture
def sample(tmp_path):
    home, clip, journal = (tmp_path / name for name in ("home", "clipboard", "journal"))
    home.mkdir()
    clip.mkdir()
    journal.mkdir(mode=0o700)
    pool = SqlitePool(home / "octop.db")
    run_migrations(pool)
    with pool.transaction() as db:
        source = db.execute(
            "INSERT INTO users(username,password_hash,role,disabled,created_at) VALUES ('old','not-a-real-password','admin',1,1) RETURNING id"
        ).fetchone()[0]
        other = db.execute(
            "INSERT INTO users(username,password_hash,role,disabled,created_at) VALUES ('other','synthetic','user',0,1) RETURNING id"
        ).fetchone()[0]
    thumb = _digest(b"synthetic box")
    namespace = _digest(
        _canonical(
            {
                "schemaVersion": 1,
                "purpose": "centuarai.local-data.principal",
                "boxKeyThumbprint": thumb,
                "ownershipEpoch": 1,
                "principalId": "principal-new",
            }
        )
    )
    target = LocalDataPrincipalRepo(pool).resolve(namespace, thumb, 1, "principal-new")
    with pool.transaction() as db:
        db.execute(
            "INSERT INTO agents(agent_id,user_id,name,created_at,updated_at,is_shared) VALUES ('agent-old',?,'old agent',1,1,1)",
            (source,),
        )
        db.execute(
            "INSERT INTO agents(agent_id,user_id,name,created_at,updated_at) VALUES ('agent-other',?,'other agent',1,1)",
            (other,),
        )
        db.execute(
            "INSERT INTO threads(thread_id,agent_id,user_id,channel_type,session_key,last_active,created_at) VALUES ('thread-old','agent-old',?,'dashboard',?,1,1)",
            (source, f"agent-old:dashboard:{source}:dm"),
        )
        db.execute(
            "INSERT INTO sessions(session_key,agent_id,user_id,channel_type,thread_id,updated_at,channel_subject_id) VALUES (?,'agent-old',?,'dashboard','thread-old',1,?)",
            (f"agent-old:dashboard:{source}:dm", source, str(source)),
        )
        db.execute(
            "INSERT INTO thread_messages(thread_id,seq,message_id,role,message_json,created_at) VALUES ('thread-old',1,'message-old','user',?,1)",
            (json.dumps({"content": "preserve conversation", "user_id": source}),),
        )
    space = PersonalSpace(home / ".wanx-personal-space", source)
    (space.objects / ("a" * 32)).write_bytes(b"retained original image")
    old_clip = clip / hashlib.sha256(str(source).encode()).hexdigest()
    old_clip.mkdir(mode=0o700)
    with sqlite3.connect(old_clip / "clipboard.sqlite3") as db:
        db.execute("CREATE TABLE notes(id TEXT PRIMARY KEY,content TEXT)")
        db.execute("INSERT INTO notes VALUES('shared-note','retained note')")
    studio = home / ".wanx-app-studio"
    studio.mkdir()
    with sqlite3.connect(studio / "studio.sqlite") as db:
        db.execute("CREATE TABLE projects(id TEXT PRIMARY KEY,owner TEXT,body TEXT)")
        db.execute(
            "INSERT INTO projects VALUES('project-old',?,?)",
            (
                f"wanx:{source}",
                json.dumps(
                    {"id": "project-old", "owner": f"wanx:{source}", "title": "retained app"}
                ),
            ),
        )
        db.execute(
            "INSERT INTO projects VALUES('project-other',?,?)",
            (f"wanx:{other}", json.dumps({"owner": f"wanx:{other}"})),
        )
    pool.close()
    identity = MigrationIdentity(
        "box-test", thumb, 1, "principal-new", _digest(b"member-new"), source, target, namespace
    )
    return (
        MigrationPaths(
            home.resolve(), clip.resolve(), journal.resolve(), (tmp_path / "semantica").resolve()
        ),
        identity,
        other,
    )


class Control:
    def __init__(self):
        self.checked = 0
        self.completed = False
        self.fail_after = None

    def freeze(self, request_id, plan):
        return {"requestId": request_id, "planDigest": plan["planDigest"]}

    def check(self, request_id, plan, receipt):
        assert receipt == {"requestId": request_id, "planDigest": plan["planDigest"]}
        self.checked += 1
        if self.fail_after == self.checked:
            raise MigrationError("MIGRATION_AUTHORITY_REVOKED")

    def complete(self, request_id, plan, receipt):
        self.completed = True


def test_preview_and_real_multidatabase_filesystem_migration(sample):
    paths, identity, other = sample
    before = (paths.home / "octop.db").read_bytes()
    plan = build_plan(paths, identity)
    assert plan["blockers"] == []
    assert plan["companyPublicationRequiresReview"] is True
    assert (paths.home / "octop.db").read_bytes() == before
    assert "not-a-real-password" not in json.dumps(plan)
    control = Control()
    result = apply_plan(paths, plan, _digest(b"request"), control)
    assert result["phase"] == "complete" and control.completed
    with sqlite3.connect(paths.home / "octop.db") as db:
        assert db.execute("SELECT count(*) FROM team_applications").fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM local_team_resources").fetchone()[0] == 0
        assert db.execute(
            "SELECT user_id,is_shared FROM agents WHERE agent_id='agent-old'"
        ).fetchone() == (identity.target_user_id, 0)
        assert db.execute("SELECT user_id FROM agents WHERE agent_id='agent-other'").fetchone() == (
            other,
        )
        assert db.execute(
            "SELECT password_hash,role FROM users WHERE id=?", (identity.target_user_id,)
        ).fetchone() == (None, "user")
        assert db.execute(
            "SELECT disabled FROM users WHERE id=?", (identity.source_user_id,)
        ).fetchone() == (1,)
        assert db.execute("SELECT session_key,channel_subject_id FROM sessions").fetchone() == (
            f"agent-old:dashboard:{identity.target_user_id}:dm",
            str(identity.target_user_id),
        )
        assert (
            json.loads(db.execute("SELECT message_json FROM thread_messages").fetchone()[0])[
                "content"
            ]
            == "preserve conversation"
        )
    with sqlite3.connect(paths.home / ".wanx-app-studio/studio.sqlite") as db:
        owner, body = db.execute(
            "SELECT owner,body FROM projects WHERE id='project-old'"
        ).fetchone()
        assert owner == json.loads(body)["owner"] == f"wanx:{identity.target_user_id}"
        assert db.execute("SELECT owner FROM projects WHERE id='project-other'").fetchone() == (
            f"wanx:{other}",
        )
    assert (
        paths.home / ".wanx-personal-space" / str(identity.target_user_id) / "objects" / ("a" * 32)
    ).read_bytes() == b"retained original image"
    clip = (
        paths.clipboard
        / hashlib.sha256(
            ("centuarai.local-data.clipboard.v1:" + identity.target_namespace).encode()
        ).hexdigest()
    )
    with sqlite3.connect(clip / "clipboard.sqlite3") as db:
        assert db.execute("SELECT content FROM notes").fetchone() == ("retained note",)


def test_studio_terminal_source_preserved_user_owner_untouched_worker_resume_removed(sample):
    paths, identity, _ = sample
    task_path = paths.home / ".wanx-app-studio/tasks/task-closed"
    task_path.mkdir(parents=True)
    source = json.dumps(
        {"src/app.js": "const owner = 'wanx:" + str(identity.source_user_id) + "';"}
    ).encode()
    (task_path / "sources.json").write_bytes(source)
    with sqlite3.connect(paths.home / ".wanx-app-studio/studio.sqlite") as db:
        row = json.loads(
            db.execute("SELECT body FROM projects WHERE id='project-old'").fetchone()[0]
        )
        row.update(
            {
                "messages": [{"owner": f"wanx:{identity.source_user_id}"}],
                "tasks": [
                    {"id": "task-closed", "state": "completed", "sessionId": "old-worker-session"}
                ],
            }
        )
        db.execute("UPDATE projects SET body=? WHERE id='project-old'", (json.dumps(row),))
    plan = build_plan(paths, identity)
    assert plan["blockers"] == [] and plan["studioWorkerSessionsDiscarded"] == 1
    apply_plan(paths, plan, _digest(b"studio-request"), Control())
    with sqlite3.connect(paths.home / ".wanx-app-studio/studio.sqlite") as db:
        row = json.loads(
            db.execute("SELECT body FROM projects WHERE id='project-old'").fetchone()[0]
        )
    assert row["messages"] == [{"owner": f"wanx:{identity.source_user_id}"}]
    assert "sessionId" not in row["tasks"][0]
    assert (task_path / "sources.json").read_bytes() == source


def test_studio_running_task_blocks_publication(sample):
    paths, identity, _ = sample
    with sqlite3.connect(paths.home / ".wanx-app-studio/studio.sqlite") as db:
        row = json.loads(
            db.execute("SELECT body FROM projects WHERE id='project-old'").fetchone()[0]
        )
        row["tasks"] = [{"id": "running", "state": "running", "sessionId": "old-worker"}]
        db.execute("UPDATE projects SET body=? WHERE id='project-old'", (json.dumps(row),))
    plan = build_plan(paths, identity)
    assert "unfinished-studio-task:project-old" in plan["blockers"]
    with pytest.raises(MigrationError, match="PREFLIGHT_BLOCKED"):
        apply_plan(paths, plan, _digest(b"running"), Control())


def test_legacy_application_acl_stays_disabled_and_company_publication_requires_review(sample):
    paths, identity, _ = sample
    with sqlite3.connect(paths.home / "octop.db") as db:
        db.execute(
            "INSERT INTO applications(application_id,name,created_by,created_at,updated_at) VALUES ('old-app','Old App',?,1,1)",
            (identity.source_user_id,),
        )
        db.execute(
            "INSERT INTO application_access VALUES ('old-app',?,1,1)", (identity.source_user_id,)
        )
    plan = build_plan(paths, identity)
    apply_plan(paths, plan, _digest(b"app-request"), Control())
    with sqlite3.connect(paths.home / "octop.db") as db:
        assert (
            db.execute(
                "SELECT created_by FROM applications WHERE application_id='old-app'"
            ).fetchone()[0]
            == identity.target_user_id
        )
        assert db.execute("SELECT user_id FROM application_access").fetchall() == [
            (identity.source_user_id,)
        ]
        assert db.execute("SELECT count(*) FROM team_applications").fetchone()[0] == 0


def test_real_ledger_dual_pop_permit_publication_and_private_journal_consumption(
    sample, monkeypatch
):
    # Only host stop/start and root transport are outside this integration test.
    # The cloud signature, actor/target PoPs, SQLite authority, actual native DB
    # publication and NOFOLLOW complete-journal verifier are real.
    wanx = Path(__file__).resolve().parents[3]
    monkeypatch.syspath_prepend(str(wanx / "wanx-bridge"))
    monkeypatch.syspath_prepend(str(wanx / "wanx-bridge/tests"))
    import test_local_ledger as ledger_fixture
    import test_local_team as team_fixture
    from wanx_bridge import local_authority_store as store
    from wanx_bridge import local_team_migration as migration
    from wanx_bridge.local_trust_protocol import BindingProtocolError

    paths, identity, _ = sample
    provisioned = ledger_fixture.provisioned.__wrapped__(paths.home)
    generator = ledger_fixture.ledger.__wrapped__(provisioned)
    ledger = next(generator)
    try:
        team_fixture.activate_team(ledger)
        now = team_fixture.NOW + 12
        auth = ledger.authority.get_authorization(ledger.root.binding_id, now)
        namespace = _digest(
            _canonical(
                {
                    "schemaVersion": 1,
                    "purpose": "centuarai.local-data.principal",
                    "boxKeyThumbprint": auth["boxKeyThumbprint"],
                    "ownershipEpoch": 1,
                    "principalId": auth["principalId"],
                }
            )
        )
        pool = SqlitePool(paths.home / "octop.db")
        target = LocalDataPrincipalRepo(pool).resolve(
            namespace, auth["boxKeyThumbprint"], 1, auth["principalId"]
        )
        pool.close()
        identity = replace(
            identity,
            box_id=auth["boxId"],
            box_key_thumbprint=auth["boxKeyThumbprint"],
            principal_id=auth["principalId"],
            membership_id=auth["team"]["membershipId"],
            target_namespace=namespace,
            target_user_id=target,
        )
        # Strict directory walking deliberately rejects writable /tmp parents;
        # this fixture has private worktree ancestors, then is always deleted.
        with tempfile.TemporaryDirectory(prefix=".test-team-journal-", dir=wanx) as journal:
            paths = replace(paths, journal=Path(journal).resolve())
            plan = build_plan(paths, identity)
            args = {
                "principalId": auth["principalId"],
                "membershipId": auth["team"]["membershipId"],
                "planDigest": plan["planDigest"],
                "sourceUserId": identity.source_user_id,
                "targetNamespace": namespace,
                "targetBindingId": auth["bindingId"],
                "expiresAt": now + 60,
            }
            review = ledger_fixture.prepare(ledger, "team.migration-authorize", args, now=now)
            ledger_fixture.commit(ledger, review, target=ledger.root, now=now)
            request_id = review["mutation"]["requestId"]
            monkeypatch.setattr(migration, "JOURNAL_ROOT", paths.journal)
            verify_journal = migration._journal
            monkeypatch.setattr(
                migration, "_journal", lambda digest: verify_journal(digest, owner_uid=os.geteuid())
            )

            class LedgerControl(Control):
                def check(self, request_id, plan, receipt):
                    super().check(request_id, plan, receipt)
                    with sqlite3.connect(
                        (provisioned.directory / store.DATABASE).as_uri() + "?mode=ro", uri=True
                    ) as db:
                        db.execute("BEGIN")
                        permit = migration.verify_team_migration_permit_readonly(
                            db, provisioned.bundle, request_id, plan["planDigest"], now
                        )
                    assert permit["sourceUserId"] == identity.source_user_id
                    assert permit["targetNamespace"] == namespace

                def complete(self, request_id, plan, receipt):
                    signed = ledger.authority.consume_team_migration(
                        request_id, plan["planDigest"], now
                    )
                    assert (
                        ledger_fixture.verified(ledger, signed, "migration-consumed")["planDigest"]
                        == plan["planDigest"]
                    )
                    self.completed = True

            with pytest.raises(BindingProtocolError):
                ledger.authority.consume_team_migration(request_id, plan["planDigest"], now)
            control = LedgerControl()
            result = apply_plan(paths, plan, request_id, control)
            assert result["phase"] == "complete" and control.completed
            assert apply_plan(paths, plan, request_id, control) == result
            with sqlite3.connect(paths.home / "octop.db") as db:
                assert (
                    db.execute("SELECT user_id FROM agents WHERE agent_id='agent-old'").fetchone()[
                        0
                    ]
                    == target
                )
    finally:
        generator.close()


def test_restart_after_partial_publication_requires_same_plan_and_fresh_authority(sample):
    paths, identity, _ = sample
    plan = build_plan(paths, identity)
    control = Control()
    control.fail_after = 3
    with pytest.raises(MigrationError, match="REVOKED"):
        apply_plan(paths, plan, _digest(b"request"), control)
    assert not control.completed
    control.fail_after = None
    assert apply_plan(paths, plan, _digest(b"request"), control)["phase"] == "complete"
    assert apply_plan(paths, plan, _digest(b"request"), control)["phase"] == "complete"


def test_changed_data_rejects_approved_plan_before_publication(sample):
    paths, identity, _ = sample
    plan = build_plan(paths, identity)
    with sqlite3.connect(paths.home / "octop.db") as db:
        db.execute("UPDATE agents SET name='changed' WHERE agent_id='agent-old'")
    with pytest.raises(MigrationError, match="SOURCE_CHANGED"):
        apply_plan(paths, plan, _digest(b"request"), Control())
    with sqlite3.connect(paths.home / "octop.db") as db:
        assert (
            db.execute("SELECT user_id FROM agents WHERE agent_id='agent-old'").fetchone()[0]
            == identity.source_user_id
        )


def test_interrupted_original_backup_retries_without_partial_authoritative_copy(
    sample, monkeypatch
):
    from octop.infra.users import team_migration as module

    paths, identity, _ = sample
    plan = build_plan(paths, identity)
    copy = module.shutil.copyfileobj

    def partial(source, output, length):
        output.write(source.read(128))
        output.flush()
        raise OSError("synthetic backup interruption")

    monkeypatch.setattr(module.shutil, "copyfileobj", partial)
    with pytest.raises(OSError, match="backup interruption"):
        apply_plan(paths, plan, _digest(b"partial-backup"), Control())
    assert not (paths.journal / plan["planDigest"] / "0.original").exists()
    monkeypatch.setattr(module.shutil, "copyfileobj", copy)
    result = apply_plan(paths, plan, _digest(b"partial-backup"), Control())
    assert result["phase"] == "complete"


def test_revocation_during_long_backup_prevents_first_database_rename(sample, monkeypatch):
    from octop.infra.users import team_migration as module

    paths, identity, _ = sample
    plan = build_plan(paths, identity)
    copy = module.shutil.copyfileobj

    class RevocableControl(Control):
        allowed = True

        def check(self, *args):
            super().check(*args)
            if not self.allowed:
                raise MigrationError("MIGRATION_AUTHORITY_REVOKED")

    control = RevocableControl()

    def revoke(source, output, length):
        copy(source, output, length)
        control.allowed = False

    monkeypatch.setattr(module.shutil, "copyfileobj", revoke)
    with pytest.raises(MigrationError, match="REVOKED"):
        apply_plan(paths, plan, _digest(b"during-backup"), control)
    with sqlite3.connect(paths.home / "octop.db") as db:
        assert (
            db.execute("SELECT user_id FROM agents WHERE agent_id='agent-old'").fetchone()[0]
            == identity.source_user_id
        )
    assert not control.completed


def test_unknown_reference_connector_and_external_storage_are_explicit_blockers(sample):
    paths, identity, _ = sample
    with sqlite3.connect(paths.home / "octop.db") as db:
        db.execute("CREATE TABLE future_business(id INTEGER,user_id INTEGER)")
        db.execute("INSERT INTO future_business VALUES(1,?)", (identity.source_user_id,))
        db.execute(
            "INSERT INTO connectors(instance_id,user_id,kind,display_name,mcp_server_name,created_at,updated_at) VALUES('connector',?,'test','test','test',1,1)",
            (identity.source_user_id,),
        )
    plan = build_plan(paths, identity)
    assert "unknown-identity-reference:future_business.user_id" in plan["blockers"]
    assert "reconnect-required:connectors.user_id" in plan["blockers"]
    with pytest.raises(MigrationError, match="PREFLIGHT_BLOCKED"):
        apply_plan(paths, plan, _digest(b"request"), Control())


def test_no_password_sso_or_existing_account_adoption(sample):
    paths, identity, other = sample
    with pytest.raises(MigrationError, match="TARGET_INVALID"):
        build_plan(paths, replace(identity, target_user_id=other))
    with sqlite3.connect(paths.home / "octop.db") as db:
        db.execute("UPDATE users SET password_hash='legacy' WHERE id=?", (identity.target_user_id,))
    with pytest.raises(MigrationError, match="TARGET_INVALID"):
        build_plan(paths, identity)


@pytest.mark.parametrize("first", [b"\xff", b"\xfb"])
def test_membership_accepts_canonical_digest_starting_underscore_or_hyphen(sample, first):
    _, identity, _ = sample
    membership = __import__("base64").urlsafe_b64encode(first + b"x" * 31).decode().rstrip("=")
    assert membership[0] in "_-"
    replace(identity, membership_id=membership).validate()
    for invalid in (membership + "=", membership[:-1], membership[:-1] + "B", "member-legacy"):
        with pytest.raises(MigrationError, match="IDENTITY_INVALID"):
            replace(identity, membership_id=invalid).validate()


def test_real_personal_space_link_requires_explicit_reconnect_without_moving_capability(sample):
    from octop.infra.personal_space.links import SpaceLinks

    paths, identity, _ = sample
    links = SpaceLinks(paths.home / ".wanx-personal-space", identity.source_user_id)
    folder = links.mkdir("", "linked")
    links.create_link(folder["id"])
    plan = build_plan(paths, identity)
    assert "personal-space-authority-reconnect:agent_links" in plan["blockers"]
    with pytest.raises(MigrationError, match="PREFLIGHT_BLOCKED"):
        apply_plan(paths, plan, _digest(b"old-capability"), Control())
    assert not (paths.home / ".wanx-personal-space" / str(identity.target_user_id)).exists()


@pytest.mark.parametrize("phase", ["octop.db", "studio.sqlite", "personal"])
def test_revocation_after_invisible_rename_never_completes_or_resumes(sample, monkeypatch, phase):
    from octop.infra.users import team_migration as module

    paths, identity, _ = sample
    plan = build_plan(paths, identity)

    class RevocableControl(Control):
        allowed = True

        def check(self, *args):
            super().check(*args)
            if not self.allowed:
                raise MigrationError("MIGRATION_AUTHORITY_REVOKED")

    control = RevocableControl()
    replace_file, rename = module.os.replace, module.os.rename

    def replaced(source, target):
        replace_file(source, target)
        if Path(target).name == phase:
            control.allowed = False

    def renamed(source, target):
        rename(source, target)
        if phase == "personal" and Path(target).parent.name == ".wanx-personal-space":
            control.allowed = False

    monkeypatch.setattr(module.os, "replace", replaced)
    monkeypatch.setattr(module.os, "rename", renamed)
    with pytest.raises(MigrationError, match="REVOKED"):
        apply_plan(paths, plan, _digest(phase.encode()), control)
    assert not control.completed
    journal = json.loads((paths.journal / plan["planDigest"] / "journal.json").read_bytes())
    assert journal["phase"] != "complete"


def test_symlink_in_owned_data_and_tampered_plan_rejected(sample):
    paths, identity, _ = sample
    plan = build_plan(paths, identity)
    plan["identity"]["source_user_id"] += 10
    with pytest.raises(MigrationError, match="PLAN_CHANGED"):
        apply_plan(paths, plan, _digest(b"request"), Control())
    (
        paths.home / ".wanx-personal-space" / str(identity.source_user_id) / "objects" / "linked"
    ).symlink_to(paths.home / "octop.db")
    with pytest.raises(MigrationError, match="UNSAFE_FILE"):
        build_plan(paths, identity)


def test_wal_commits_and_crash_between_sidecar_move_and_database_rename(sample, monkeypatch):
    from octop.infra.users import team_migration

    paths, identity, _ = sample
    subprocess.run(
        [
            sys.executable,
            "-c",
            "import os,sqlite3,sys; "
            "db=sqlite3.connect(sys.argv[1]); db.execute('PRAGMA journal_mode=WAL'); "
            "db.execute('PRAGMA wal_autocheckpoint=0'); "
            "db.execute(\"UPDATE agents SET name='committed in WAL' WHERE agent_id='agent-old'\"); "
            "db.commit(); os._exit(0)",
            str(paths.home / "octop.db"),
        ],
        check=True,
    )
    plan = build_plan(paths, identity)
    original_replace = team_migration.os.replace
    failed = False

    def crash(source, target):
        nonlocal failed
        if not failed and str(source).endswith("0.sqlite") and target == paths.home / "octop.db":
            failed = True
            raise OSError("synthetic power loss before main DB rename")
        return original_replace(source, target)

    monkeypatch.setattr(team_migration.os, "replace", crash)
    control = Control()
    with pytest.raises(OSError, match="synthetic power loss"):
        apply_plan(paths, plan, _digest(b"request"), control)
    assert not control.completed
    assert apply_plan(paths, plan, _digest(b"request"), control)["phase"] == "complete"
    with sqlite3.connect(paths.home / "octop.db") as db:
        assert db.execute(
            "SELECT name,user_id FROM agents WHERE agent_id='agent-old'"
        ).fetchone() == (
            "committed in WAL",
            identity.target_user_id,
        )


def test_completed_exact_replay_does_not_overwrite_new_business_writes(sample):
    paths, identity, _ = sample
    plan = build_plan(paths, identity)
    control = Control()
    apply_plan(paths, plan, _digest(b"request"), control)
    with sqlite3.connect(paths.home / "octop.db") as db:
        db.execute("UPDATE agents SET name='new work after restart' WHERE agent_id='agent-old'")
    apply_plan(paths, plan, _digest(b"request"), control)
    with sqlite3.connect(paths.home / "octop.db") as db:
        assert (
            db.execute("SELECT name FROM agents WHERE agent_id='agent-old'").fetchone()[0]
            == "new work after restart"
        )
