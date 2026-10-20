import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAccount } from "../account/index.mjs";
import { createTimingRecorder } from "../shell/timings.mjs";

const credentials = { phone: "13800138000", password: "private-login-password", remember: true };
const steps = ["cleanup", "local", "request", "persist"].map((step) => `account.login.${step}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const reply = (data) => new Response(JSON.stringify({ code: 200, data }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, pauseAt) {
  const directory = await mkdtemp(join(tmpdir(), "wanx-login-timings-"));
  const filePath = join(directory, "timings.jsonl");
  const recorder = createTimingRecorder({ filePath });
  const gate = deferred();
  let clock = 0;
  let stored = null;
  let loginCount = 0;
  t.mock.method(performance, "now", () => clock);
  const account = createAccount({
    measure: recorder.run,
    store: {
      load: async () => {
        if (pauseAt === "load") await gate.promise;
        return structuredClone(stored);
      },
      save: async (value) => {
        if (pauseAt === (value.active ? "persist" : "identity")) await gate.promise;
        stored = structuredClone(value);
      },
      clear: async () => { stored = null; },
    },
    fetch: async (url, options) => {
      if (url.endsWith("/logout")) {
        if (pauseAt === "cleanup") await gate.promise;
        return reply({});
      }
      assert.ok(url.endsWith("/login"));
      loginCount++;
      if (pauseAt === "request") await gate.promise;
      const body = JSON.parse(options.body);
      return reply({
        accountId: "private-account",
        clientId: body.clientId,
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        expiresIn: 3600,
      });
    },
  });
  t.after(async () => {
    gate.resolve();
    await account.close();
    await recorder.flush();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    account,
    recorder,
    gate,
    advance: () => { clock += 250; },
    loginCount: () => loginCount,
    events: async () => {
      await recorder.flush();
      const contents = await readFile(filePath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      assert.doesNotMatch(contents, /13800138000|private-login-password|private-account|private-access-token|private-refresh-token|PRIVATE KEY/);
      return contents.trim() ? contents.trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
  };
}

for (const [pauseAt, stage] of [
  ["cleanup", "cleanup"],
  ["load", "local"],
  ["identity", "local"],
  ["request", "request"],
  ["persist", "persist"],
]) {
  test(`login timing attributes a blocked ${pauseAt} operation to ${stage}`, async (t) => {
    const h = await fixture(t, pauseAt);
    let baseline = 0;
    if (pauseAt === "cleanup") {
      await h.account.loginPassword(credentials);
      await h.account.logout();
      baseline = (await h.events()).length;
    }
    let completed = false;
    const loggingIn = h.account.loginPassword(credentials).then((result) => {
      completed = true;
      return result;
    });
    try {
      await tick();
      assert.equal(completed, false, "login must wait for the actual operation");
      if (pauseAt === "cleanup") assert.equal(h.loginCount(), 1, "cleanup must finish before a new login request");
      const waiting = (await h.events()).slice(baseline);
      assert.deepEqual(waiting.map((event) => event.step), steps.slice(0, steps.indexOf(`account.login.${stage}`)));
      h.advance();
      h.gate.resolve();
      await loggingIn;
      const events = (await h.events()).slice(baseline);
      assert.deepEqual(events.map((event) => event.step), steps);
      assert.deepEqual(events.map((event) => event.durationMs), steps.map((step) => step === `account.login.${stage}` ? 250 : 0));
      assert.ok(events.every((event) => event.outcome === "completed"));
      assert.equal(h.account.snapshot().phase, "authenticated");
      assert.deepEqual(await h.account.getRememberedLogin(), credentials);
    } finally {
      h.gate.resolve();
      await loggingIn.catch(() => {});
    }
  });
}

test("failed login requests still record their safe failure timing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wanx-login-failed-timings-"));
  const filePath = join(directory, "timings.jsonl");
  const recorder = createTimingRecorder({ filePath });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  const account = createAccount({
    measure: recorder.run,
    store: { load: async () => null, save: async () => {}, clear: async () => {} },
    fetch: async () => {
      clock = 125;
      throw new Error("private-network-error-with-password");
    },
  });
  t.after(async () => {
    await account.close();
    await recorder.flush();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(account.loginPassword(credentials), { code: "ACCOUNT_NETWORK_ERROR" });
  await recorder.flush();
  const contents = await readFile(filePath, "utf8");
  assert.doesNotMatch(contents, /13800138000|private-login-password|private-network-error-with-password/);
  const events = contents.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.step), steps.slice(0, 3));
  assert.deepEqual(events.at(-1), {
    time: events.at(-1).time,
    step: "account.login.request",
    outcome: "failed",
    durationMs: 125,
    errorCode: "ACCOUNT_NETWORK_ERROR",
  });
});
