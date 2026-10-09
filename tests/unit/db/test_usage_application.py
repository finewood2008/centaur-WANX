"""Usage aggregations preserve the signed application scope."""

from pathlib import Path

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.agents import AgentRepo
from octop.infra.db.repos.audit import AuditRepo
from octop.infra.db.repos.usage import UsageRepo
from octop.infra.db.repos.users import UserRepo


def test_usage_and_audit_application_filter(tmp_path: Path) -> None:
    pool = SqlitePool(tmp_path / "usage.db")
    run_migrations(pool)
    uid = UserRepo(pool).create(username="synthetic", password_hash="x", role="user")
    agents = AgentRepo(pool)
    agents.create(agent_id="wanx-test", user_id=uid, name="same name")
    agents.create(agent_id="zhijun-test", user_id=uid, name="same name", application_id="zhijun")
    usage = UsageRepo(pool)
    for aid, count in (("wanx-test", 10), ("zhijun-test", 20)):
        usage.record(agent_id=aid, user_id=uid, input_tokens=count, output_tokens=0)
    assert usage.summary(application_id="wanx", window="all")["total_tokens"] == 10
    assert usage.summary(application_id="zhijun", window="all")["total_tokens"] == 20
    assert {row.agent_id for row in usage.list_detail(application_id="wanx", window="all")} == {
        "wanx-test"
    }
    assert [row.agent_id for row in usage.list_detail(application_id="zhijun", window="all")] == [
        "zhijun-test"
    ]
    audit = AuditRepo(pool)
    for aid in ("wanx-test", "zhijun-test"):
        audit.system_event("agent.create", target=aid, payload="private profile title")
    assert [row.target for row in audit.query(application_id="wanx")] == ["wanx-test"]
    assert [row.target for row in audit.query(application_id="zhijun")] == ["zhijun-test"]
