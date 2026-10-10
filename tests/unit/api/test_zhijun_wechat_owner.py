"""Synthetic identities only; no live WeChat sends or personal data writes."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from tests.unit.api.test_zhijun_role_ontology import Registry

from octop.infra.agents import personal_ontology as p
from octop.infra.agents import role_ontology as r
from octop.infra.agents import role_ontology_flow as flow
from octop.infra.agents.ontology_admission import admitted
from octop.infra.errors import OctopError
from octop.infra.gateway.channels import zhijun_weixin as w


class Tests(unittest.IsolatedAsyncioTestCase):
    def message(self, **kw):
        fields = {
            "tenant_id": "personal",
            "channel_type": "weixin",
            "channel_subject": NS(subject_id="owner", chat_type="dm"),
            "metadata": {},
        }
        return NS(**{**fields, **kw})

    def broker(self):
        rows = []

        async def create(spec):
            row = NS(
                channel_id=spec.channel_id,
                agent_id=spec.agent_id,
                kind=spec.kind,
                config_json=json.dumps(spec.config),
            )
            rows.append(row)
            return row

        gw = NS(
            _repos=NS(channel_repo=NS(list_all=lambda: rows)),
            create_channel=AsyncMock(side_effect=create),
        )
        return w.ZhijunWeixinBindings(gw), gw, rows

    def login(self, **kw):
        result = NS(
            **dict(
                connected=True,
                bot_token="test-token",
                account_id="bot",
                user_id="owner",
                base_url="https://ilinkai.weixin.qq.com",
                **kw,
            )
        )
        return NS(
            fetch_qr_code=AsyncMock(
                return_value=NS(qrcode="provider-qr", qrcode_img_content="https://example.test/qr")
            ),
            wait_for_login=AsyncMock(return_value=result),
        )

    async def test_binding_is_owner_role_scoped_and_credentials_stay_server_side(self):
        b, g, rows = self.broker()
        q = await b.generate("personal", 1, self.login())
        self.assertNotEqual(q["qrcode_token"], "provider-qr")
        for aid, uid in [("work", 1), ("personal", 2)]:
            with self.assertRaises(OctopError):
                await b.poll(q["qrcode_token"], aid, uid)
        result = await b.poll(q["qrcode_token"], "personal", 1)
        self.assertEqual(await b.poll(q["qrcode_token"], "personal", 1), result)
        self.assertEqual(g.create_channel.await_count, 1)
        self.assertNotIn("token", result)
        self.assertEqual(json.loads(rows[0].config_json)["owner_weixin_user_id"], "owner")

    async def test_missing_provider_owner_and_bad_hosts_are_rejected(self):
        for attr, value in [
            ("user_id", None),
            ("base_url", "https://evil.test"),
            ("bot_token", ""),
        ]:
            b, g, _ = self.broker()
            login = self.login()
            setattr(login.wait_for_login.return_value, attr, value)
            q = await b.generate("personal", 1, login)
            with self.assertRaises(OctopError):
                await b.poll(q["qrcode_token"], "personal", 1)
            g.create_channel.assert_not_awaited()

    async def test_regenerated_qr_invalidates_previous_and_expired_nonce(self):
        b, g, _ = self.broker()
        a = await b.generate("personal", 1, self.login())
        q = await b.generate("personal", 1, self.login())
        with self.assertRaises(OctopError):
            await b.poll(a["qrcode_token"], "personal", 1)
        b.sessions[q["qrcode_token"]].expires = 0
        with self.assertRaises(OctopError):
            await b.poll(q["qrcode_token"], "personal", 1)
        g.create_channel.assert_not_awaited()

    async def test_same_bot_cannot_be_bound_to_two_roles_even_concurrently(self):
        b, g, _ = self.broker()
        a = await b.generate("personal", 1, self.login())
        z = await b.generate("work", 1, self.login())
        results = await asyncio.gather(
            b.poll(a["qrcode_token"], "personal", 1),
            b.poll(z["qrcode_token"], "work", 1),
            return_exceptions=True,
        )
        self.assertEqual(sum(isinstance(x, OctopError) for x in results), 1)
        self.assertEqual(g.create_channel.await_count, 1)

    async def test_nonowner_group_wrong_role_never_reaches_processing(self):
        seen = []

        async def process(m):
            seen.append(m)
            yield "ok"

        guarded = w.private_weixin_processor(process, agent_id="personal", owner_id="owner")
        for msg in [
            self.message(channel_subject=NS(subject_id="other", chat_type="dm")),
            self.message(tenant_id="work"),
            self.message(metadata={"is_group": True}),
            self.message(channel_subject=NS(subject_id="owner", chat_type="group")),
        ]:
            self.assertEqual([x async for x in guarded(msg)], [])
        self.assertEqual(seen, [])
        self.assertEqual([x async for x in guarded(self.message())], ["ok"])
        with self.assertRaises(OctopError):
            w.private_weixin_processor(process, agent_id="personal", owner_id="")

    async def test_rebinding_or_pausing_blocks_inflight_old_connection(self):
        enabled = True

        async def process(m):
            yield "ok"

        guarded = w.private_weixin_processor(
            process, agent_id="personal", owner_id="owner", binding_check=lambda m: enabled
        )
        enabled = False
        self.assertEqual([x async for x in guarded(self.message())], [])

    def test_recipient_account_and_private_role_detection(self):
        for aid in ["zhijun-lan-user-1", "zhijun-lan-user-1-abc123", "zhijun-role-1-work"]:
            self.assertTrue(w.owner_only_agent(NS(agent_id=aid, user_id=1, application_id="wanx")))
        self.assertFalse(w.owner_only_agent(NS(agent_id="main", user_id=1, application_id="wanx")))
        cfg = {"owner_weixin_user_id": "owner", "accounts": [{"account_id": "bot"}]}
        for sid, account, origin, kind in [
            ("other", "bot", "owner", "dm"),
            ("owner", "wrong", "owner", "dm"),
            ("owner", "bot", "other", "dm"),
            ("owner", "bot", "owner", "group"),
        ]:
            with self.assertRaises(OctopError):
                w.assert_private_weixin_recipient(
                    cfg,
                    NS(
                        subject_id=sid,
                        chat_type=kind,
                        metadata={"account_id": account, "from_user_id": origin},
                    ),
                )
        w.assert_private_weixin_recipient(
            cfg,
            NS(
                subject_id="owner",
                chat_type="dm",
                metadata={"account_id": "bot", "from_user_id": "owner"},
            ),
        )

    async def test_role_channel_api_requires_broker_and_disallows_credential_rewrite(self):
        from octop.api.routers import channels as c

        row = NS(agent_id="zhijun-lan-user-1", user_id=1, is_shared=False, application_id="wanx")
        binding = NS(
            generate=AsyncMock(return_value={"qrcode_token": "scoped", "qrcode_url": "qr"}),
            poll=AsyncMock(return_value={"status": "success", "channel_id": "bound"}),
        )
        channel = NS(agent_id=row.agent_id, kind="weixin")
        gateway = NS(
            zhijun_weixin=binding,
            get_channel=lambda cid: channel,
            update_channel=AsyncMock(),
            create_channel=AsyncMock(),
        )
        server = NS(app_runtime=NS(gateway=gateway, agent_registry=NS(get_row=lambda aid: row)))
        user = NS(id=1, application_id="wanx")
        with (
            patch.object(c, "_require_agent_access", return_value=row),
            patch.object(c, "_get_weixin_qr_login", return_value=lambda: object()),
        ):
            q = await c.weixin_qrcode_generate(row.agent_id, None, user, server)
            self.assertEqual(q["qrcode_token"], "scoped")
            self.assertEqual(
                (await c.weixin_qrcode_poll(row.agent_id, None, "scoped", user, server))[
                    "channel_id"
                ],
                "bound",
            )
            with self.assertRaises(OctopError):
                await c.create_channel(
                    row.agent_id,
                    c.ChannelCreateBody(
                        kind="weixin", name="x", config={"owner_weixin_user_id": "forged"}
                    ),
                    None,
                    None,
                    user,
                    server,
                )
            with self.assertRaises(OctopError):
                await c.patch_channel(
                    row.agent_id,
                    "bound",
                    c.ChannelPatchBody(config={"owner_weixin_user_id": "forged"}),
                    None,
                    None,
                    user,
                    server,
                )
            gateway.create_channel.assert_not_awaited()
            gateway.update_channel.assert_not_awaited()
            user.id = 2
            with self.assertRaises(OctopError):
                await c.weixin_qrcode_generate(row.agent_id, None, user, server)

    async def test_guarded_owner_capture_uses_real_memory_store_and_scoped_ontology(self):
        from octop_memory import Memory, MemoryService

        from octop.infra.gateway.process.message_keys import resolve_user_id_for_message

        with tempfile.TemporaryDirectory() as directory:
            memories = {
                role: Memory(
                    namespace=role,
                    backend_config={"db_path": str(Path(directory) / (role + ".sqlite"))},
                )
                for role in ["personal", "work"]
            }
            services = {role: MemoryService(memory) for role, memory in memories.items()}
            registry = Registry()
            history = []

            async def process(msg):
                uid = resolve_user_id_for_message(msg, agent_owner_id=1)
                history.append((msg.tenant_id, uid))
                services[msg.tenant_id].capture_turn(
                    user="我是一个注重诚信的设计师，我希望在工作中坚持诚信。",
                    thread_id="wechat-test",
                    session_id="wechat-test",
                    user_id=str(uid),
                )
                with r.agent_scope(registry, uid, msg.tenant_id):
                    result = await flow.capture_declaration(
                        registry,
                        uid,
                        msg.tenant_id,
                        "wechat-test",
                        "turn-1",
                        "请纳入本体：我是一个注重诚信的设计师",
                    )
                yield result

            guard = w.private_weixin_processor(process, agent_id="personal", owner_id="owner")
            self.assertEqual(
                [
                    x
                    async for x in guard(
                        self.message(channel_subject=NS(subject_id="stranger", chat_type="dm"))
                    )
                ],
                [],
            )
            self.assertEqual(history, [])
            self.assertEqual(memories["personal"].list_raw(), [])
            result = [x async for x in guard(self.message())]
            self.assertEqual(result[0]["status"], "admitted")
            self.assertEqual(history, [("personal", 1)])
            raw = memories["personal"].list_raw()
            self.assertEqual(len(raw), 1)
            self.assertEqual(raw[0].user, "1")
            self.assertEqual(raw[0].thread_id, "wechat-test")
            self.assertEqual(memories["work"].list_raw(), [])
            self.assertTrue(
                admitted((await p._read(registry.agents["personal"].workspace)).claims[0])
            )
            self.assertFalse((await p._read(registry.agents["work"].workspace)).claims)


if __name__ == "__main__":
    unittest.main()
