import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../local-ui/renderer/renderer.js", import.meta.url),
  "utf8",
);

function state(platformPhase, networkPhase) {
  const ready = platformPhase === "ready" && networkPhase === "ready";
  const device = {
    deviceId: "box-102",
    displayName: "CentuarAI-AMD-102",
    name: "CentuarAI-AMD-102",
    accessState: "ready",
    lifecycle: "ready",
    initialized: true,
    platformOnline: ready,
  };
  return {
    account: { phase: "authenticated", accountId: "account-1" },
    phase: "idle",
    platform: { phase: platformPhase },
    network: { phase: networkPhase },
    devices: [device],
    availableDevices: [device],
    networkReady: ready,
    connection: null,
  };
}

async function render(initial) {
  const app = { innerHTML: "", addEventListener() {} };
  let onState;
  const context = {
    document: { querySelector: (selector) => selector === "#app" ? app : null },
    window: {
      wanxClient: {
        getLocalState: async () => initial,
        onLocalState: (listener) => { onState = listener; return () => {}; },
        action: async () => ({ ok: true, state: initial }),
      },
      wanxSetup: {
        state: async () => ({ state: "idle" }),
        subscribe: () => () => {},
        onReady: () => () => {},
      },
    },
  };
  vm.runInNewContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { app, update: onState };
}

test("disables authorized device connection while the main network is preparing", async () => {
  const { app, update } = await render(state("enrolling", "checking"));
  assert.match(app.innerHTML, /disabled>网络连接中<\/button>/);
  assert.match(app.innerHTML, /网络连接中，请稍候/);
  assert.doesNotMatch(app.innerHTML, /data-action="connect"/);
  update(state("ready", "ready"));
  assert.match(app.innerHTML, /data-action="connect"/);
});

test("enables the authorized device connection after the main network is ready", async () => {
  const { app } = await render(state("ready", "ready"));
  assert.match(app.innerHTML, /data-action="connect"/);
  assert.match(app.innerHTML, />连接<\/button>/);
  assert.doesNotMatch(app.innerHTML, /disabled>网络连接中<\/button>/);
});
