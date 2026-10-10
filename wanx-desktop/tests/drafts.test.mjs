import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDraftStore } from "../shell/drafts.mjs";
import { createDesktopSession } from "../shell/session.mjs";

test("product drafts survive restart, stay scoped and reject nested credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wanx-drafts-"));
  const file = join(directory, "drafts.json");
  const scope = { boxId: "box-a", userId: 1, applicationId: "product-a" };
  try {
    await createDraftStore(file).put(scope, {
      name: "Synthetic product",
      agent_template: {},
    });
    const restored = createDraftStore(file);
    assert.equal((await restored.get(scope)).product.name, "Synthetic product");
    for (const patch of [
      { boxId: "box-b" },
      { userId: 2 },
      { applicationId: "product-b" },
    ])
      assert.equal(await restored.get({ ...scope, ...patch }), null);
    await assert.rejects(
      restored.put(scope, {
        agent_template: '{"config":{"api_key":"synthetic-secret"}}',
      }),
      /草稿不能/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("draft writes revalidate box permissions and reject replies after disconnect", async () => {
  let grant = 200,
    resolvePermission,
    writes = 0;
  const client = {
    modules: {
      auth: {
        me: async () => ({ status: 200, body: { id: 1, role: "admin" } }),
      },
    },
    applications: {
      list: async () =>
        resolvePermission
          ? new Promise((done) => {
              resolvePermission = done;
            })
          : { status: grant },
    },
    close: async () => {},
  };
  const hostFactory = async () => ({
    connection: { onStatus: () => {}, connect: async () => client },
    devices: { list: async () => [{ deviceId: "uuid-a", online: true }] },
    dispose: async () => {},
  });
  const service = createDesktopSession({
    deployment: {
      trustedGatewayHosts: ["gateway.example.invalid"],
      trustedICEHosts: ["ice.example.invalid"],
    },
    hostFactory,
    draftStore: {
      put: async () => {
        writes++;
      },
      get: async () => null,
    },
  });
  try {
    const state = await service.action("connection.connect", {
      deviceId: "uuid-a",
    });
    grant = 403;
    await assert.rejects(
      service.action("draft.put", { sessionId: state.sessionId, value: {} }),
      /DRAFT_PERMISSION_DENIED/,
    );
    assert.equal(writes, 0);
    resolvePermission = true;
    const pending = service.action("draft.put", {
      sessionId: state.sessionId,
      value: {},
    });
    await service.disconnect();
    resolvePermission({ status: 200 });
    await assert.rejects(pending, /SESSION_CLOSED/);
    assert.equal(writes, 0);
  } finally {
    await service.close();
  }
});
