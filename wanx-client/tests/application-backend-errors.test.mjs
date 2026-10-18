import test from "node:test";
import assert from "node:assert/strict";
import { createApplicationBackend } from "../applications/backend.mjs";

const manifest = {
  applicationId: "centaurai.wanx.fixture", protocolVersion: 2,
  compatibility: { backendProductId: "wanx" },
};

function backend(response, afterRequest = () => {}) {
  const state = { phase: "ready", connection: { deviceId: "box-fixture" } };
  const identity = { accountId: "account-fixture" };
  const requests = [];
  async function request(input) {
    requests.push(input);
    afterRequest({ state, identity });
    return { ...response, body: Buffer.from(response.body) };
  }
  const adapter = createApplicationBackend({
    clientVersion: "0.1.4", account: { getIdentity: () => identity },
    client: {
      snapshot: () => state,
      applicationRequest: request,
      applicationConnection: async () => ({ request, context: () => ({
        accountId: identity.accountId, clientId: "client-fixture", boxId: state.connection.deviceId, connection: "ready",
      }) }),
    },
  });
  return { ...adapter, requests };
}

test("legacy readiness preserves structured authorization and configuration failures without retrying", async t => {
  for (const [status, code] of [[403, "APP_ENTITLEMENT_REQUIRED"], [503, "RESOURCE_SERVICE_NOT_CONFIGURED"]]) {
    await t.test(code, async () => {
      const adapter = backend({ status, body: JSON.stringify({ code, detail: "private upstream detail" }) });
      await assert.rejects(adapter.getCompatibilityContext({ manifest, phase: "launch" }), { code, message: code });
      assert.equal(adapter.requests.length, 1);
      assert.equal(adapter.requests[0].path, "/api/platform/applications/readiness");
      assert.equal(adapter.requests[0].method, "POST");
    });
  }
});

test("legacy readiness classifies unstructured HTTP failures without exposing upstream bodies", async t => {
  for (const [status, body, code] of [
    [401, "", "APP_AUTHORIZATION_UNVERIFIED"],
    [403, '{"detail":"private permission detail"}', "APP_AUTHORIZATION_UNVERIFIED"],
    [404, "<html>private proxy details</html>", "BACKEND_CONTRACT_INCOMPATIBLE"],
    [502, "<html>private proxy details</html>", "APPLICATION_PREPARATION_UNAVAILABLE"],
    [503, '{"code":"private upstream error"}', "APPLICATION_PREPARATION_UNAVAILABLE"],
    [503, '{"code":{"message":"private upstream error"}}', "APPLICATION_PREPARATION_UNAVAILABLE"],
    [503, JSON.stringify({ code: "A".repeat(82) }), "APPLICATION_PREPARATION_UNAVAILABLE"],
  ]) {
    await t.test(`${status}: ${body}`, async () => {
      const adapter = backend({ status, body });
      await assert.rejects(adapter.getCompatibilityContext({ manifest, phase: "launch" }), { code, message: code });
      assert.equal(adapter.requests.length, 1);
    });
  }
});

test("HTTP authentication failures do not imply a missing application entitlement in either protocol", async t => {
  for (const protocolVersion of [2, 3]) {
    for (const [status, body] of [
      [401, ""],
      [403, ""],
      [401, '{"error":{"code":"AUTH_FAILED","message":"private authentication detail"}}'],
      [401, '{"code":"AUTH_FAILED"}'],
      [403, '{"code":"FORBIDDEN"}'],
    ]) {
      await t.test(`v${protocolVersion}: ${status} ${body}`, async () => {
        const adapter = backend({ status, body });
        await assert.rejects(adapter.getCompatibilityContext({ manifest: { ...manifest, protocolVersion }, phase: "rollback" }), {
          code: "APP_AUTHORIZATION_UNVERIFIED", message: "APP_AUTHORIZATION_UNVERIFIED",
        });
        assert.equal(adapter.requests.length, 1);
      });
    }
  }
});

test("a legacy readiness response from a replaced account or box cannot override the session guard", async t => {
  for (const change of ["account", "box"]) {
    await t.test(change, async () => {
      const adapter = backend({ status: 503, body: '{"code":"RESOURCE_SERVICE_NOT_CONFIGURED"}' }, ({ state, identity }) => {
        if (change === "account") identity.accountId = "another-account";
        else state.connection.deviceId = "another-box";
      });
      await assert.rejects(adapter.getCompatibilityContext({ manifest, phase: "launch" }), { code: "UPDATE_SESSION_CHANGED" });
      assert.equal(adapter.requests.length, 1);
    });
  }
});

test("successful legacy readiness is preserved and invalid JSON is reported safely", async () => {
  const observed = { schemaVersion: 1, productId: "wanx", deviceId: "box-fixture", status: "ready" };
  const adapter = backend({ status: 200, body: JSON.stringify(observed) });
  const context = await adapter.getCompatibilityContext({ manifest, phase: "launch" });
  assert.deepEqual(context.backend, observed);
  assert.equal(context.expectedDeviceId, "box-fixture");

  const malformed = backend({ status: 200, body: "private non-JSON upstream body" });
  await assert.rejects(malformed.getCompatibilityContext({ manifest, phase: "launch" }), {
    code: "APPLICATION_PREPARATION_INVALID", message: "APPLICATION_PREPARATION_INVALID",
  });
});
