import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTimingRecorder } from "../shell/timings.mjs";
import { BOX_SESSION_ERROR_CODES } from "../octop/platform.mjs";

test("grant response correlation accepts only UUID and numeric timings", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wanx-grant-response-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "connection.jsonl");
  const recorder = createTimingRecorder({ filePath });
  const requestId = "c7e65752-bde8-48cf-82cb-c4c1d04ac3a9";
  await recorder.run("box.connect", async () => {
    recorder.grantResponse({ requestId, serverDurationMs: 123.4, httpStatus: 200, token: "SECRET" });
    recorder.grantResponse({ requestId: "SECRET", serverDurationMs: -1, httpStatus: "SECRET" });
    recorder.grantResponse({ serverDurationMs: Infinity, headers: "SECRET" });
  });
  await recorder.flush();
  const contents = await readFile(filePath, "utf8");
  const rows = contents.trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].step, "account.grant.response");
  assert.equal(rows[0].requestId, requestId);
  assert.equal(rows[0].serverDurationMs, 123.4);
  assert.equal(rows[0].httpStatus, 200);
  assert.equal(rows[0].connectionId, rows.at(-1).connectionId);
  assert.ok(rows.slice(1, 3).every(row => !Object.hasOwn(row, "requestId") && !Object.hasOwn(row, "serverDurationMs") && !Object.hasOwn(row, "httpStatus")));
  assert.doesNotMatch(contents, /SECRET|Infinity|headers|token/);
});

test("connection spans correlate concurrent attempts without tagging later renewals", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wanx-connect-spans-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "connection.jsonl");
  const recorder = createTimingRecorder({ filePath });
  let releaseFirst, releaseRenewal, renewal;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const renewalGate = new Promise(resolve => { releaseRenewal = resolve; });
  const first = recorder.run("box.connect", async () => {
    renewal = renewalGate.then(() => recorder.run("box.grant", async () => {}));
    await firstGate;
    await recorder.run("box.challenge", async () => "SECRET");
  });
  await recorder.run("box.connect", async () => {
    await recorder.run("box.health", async () => {});
  });
  releaseFirst();
  await first;
  releaseRenewal();
  await renewal;
  await recorder.flush();
  const contents = await readFile(filePath, "utf8");
  const rows = contents.trim().split("\n").map(JSON.parse);
  const roots = rows.filter(row => row.step === "box.connect");
  assert.equal(roots.length, 2);
  for (const row of roots) assert.match(row.connectionId, /^[a-f0-9-]{36}$/);
  assert.notEqual(roots[0].connectionId, roots[1].connectionId);
  assert.equal(rows.find(row => row.step === "box.health").connectionId, roots[0].connectionId);
  assert.equal(rows.find(row => row.step === "box.challenge").connectionId, roots[1].connectionId);
  assert.equal(Object.hasOwn(rows.find(row => row.step === "box.grant"), "connectionId"), false);
  assert.doesNotMatch(contents, /SECRET/);
});

test("timings persist phase and elapsed time, never results or error details, and rotate", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wanx-timings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "connection.jsonl");
  const recorder = createTimingRecorder({ filePath, maxBytes: 1 });
  assert.equal(
    await recorder.run("account.restore", async () => "SECRET-TOKEN"),
    "SECRET-TOKEN",
  );
  await assert.rejects(
    recorder.run("network.recover", async () => {
      throw Error("SECRET-TOKEN");
    }),
  );
  await recorder.run("https://secret.example/token", async () => {});
  await recorder.flush();
  const current = await readFile(filePath, "utf8");
  const previous = await readFile(`${filePath}.previous`, "utf8");
  assert.doesNotMatch(current + previous, /SECRET|secret.example/);
  assert.equal(JSON.parse(current).outcome, "failed");
  assert.equal(JSON.parse(previous).step, "account.restore");
  assert.equal(typeof JSON.parse(current).durationMs, "number");
});

test("failure diagnostics allow only known codes and HTTP status, never free-form errors", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wanx-errors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "connection.jsonl");
  const recorder = createTimingRecorder({ filePath });
  for (const code of ["ACCOUNT_NETWORK_ERROR", "engine_timeout", "SECRET_TOKEN", "https://secret.example/token"]) {
    await assert.rejects(recorder.run("network.restore", async () => {
      throw Object.assign(new Error("SECRET phone=13800138000 token=private"), {
        code, status: 503, headers: { authorization: "Bearer SECRET" }, body: "SECRET",
      });
    }));
  }
  await recorder.flush();
  const contents = await readFile(filePath, "utf8");
  assert.doesNotMatch(contents, /SECRET|13800138000|private|secret.example|authorization|body/);
  const rows = contents.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.errorCode), ["ACCOUNT_NETWORK_ERROR", "engine_timeout", "UNKNOWN_ERROR", "UNKNOWN_ERROR"]);
  assert.ok(rows.every(row => row.httpStatus === 503));
});

test("connection diagnostics record only sanitized state changes, including recovery and lease expiry", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wanx-states-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "connection.jsonl");
  const recorder = createTimingRecorder({ filePath });
  const state = { phase: "unavailable", reason: "engine_timeout", enabled: true,
    peers: [{ ip: "100.80.1.2", name: "SECRET-DEVICE" }], token: "SECRET" };
  recorder.state("network", state);
  recorder.state("network", { ...state, token: "CHANGED-SECRET" });
  recorder.state("network", { phase: "ready", reason: null, enabled: true });
  recorder.state("platform", { phase: "unavailable", reason: "NETWORK_LEASE_EXPIRED" });
  recorder.state("network", { phase: "SECRET-PHASE", reason: "SECRET_CODE", enabled: "SECRET" });
  recorder.state("SECRET-COMPONENT", state);
  await recorder.flush();
  const contents = await readFile(filePath, "utf8");
  assert.doesNotMatch(contents, /SECRET|100.80|peers|token/);
  const rows = contents.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.phase), ["unavailable", "ready", "unavailable", "unknown"]);
  assert.deepEqual(rows.map(row => row.reason), ["engine_timeout", null, "NETWORK_LEASE_EXPIRED", "UNKNOWN_ERROR"]);
  assert.equal(rows[0].enabled, true);
  assert.equal(Object.hasOwn(rows[3], "enabled"), false);
});

test("box exchange failures retain fixed diagnostic codes and HTTP status", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wanx-box-errors-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "connection.jsonl");
  const recorder = createTimingRecorder({ filePath });
  for (const code of BOX_SESSION_ERROR_CODES) {
    await assert.rejects(recorder.run("box.exchange", async () => {
      throw Object.assign(new Error("SECRET backend detail"), { code, status: 503 });
    }));
  }
  await recorder.flush();
  const contents = await readFile(filePath, "utf8");
  const rows = contents.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.errorCode), BOX_SESSION_ERROR_CODES);
  assert.ok(rows.every(row => row.step === "box.exchange" && row.httpStatus === 503));
  assert.doesNotMatch(contents, /SECRET|backend detail/);
});

test('transfer diagnostics retain correlation and retry evidence without paths or credentials', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wanx-transfer-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'connection.jsonl'), recorder = createTimingRecorder({ filePath });
  recorder.transfer({ action: 'interrupted', taskId: 'a'.repeat(32), batchId: 'b'.repeat(32), phase: 'retrying', offset: 512, size: 1024, attempt: 2, errorCode: 'ECONNRESET', name: 'SECRET.txt', localPath: '/SECRET', token: 'SECRET' });
  recorder.transfer({ action: 'request', stage: 'chunk', durationMs: 180, errorCode: 'SECRET', taskId: 'SECRET' });
  recorder.transfer({ action: 'SECRET' }); await recorder.flush();
  const contents = await readFile(filePath, 'utf8'); assert.doesNotMatch(contents, /SECRET/);
  const rows = contents.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2); assert.equal(rows[0].taskId, 'a'.repeat(32)); assert.equal(rows[0].errorCode, 'ECONNRESET');
  assert.equal(rows[1].durationMs, 180); assert.equal(rows[1].errorCode, 'UNKNOWN_ERROR');
});

test('payment diagnostics retain only safe stage timing and QR readiness', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wanx-payment-timings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'connection.jsonl'), recorder = createTimingRecorder({ filePath });
  recorder.creditPayment({ stage: 'confirm', durationMs: 42, outcome: 'completed', qrReady: true, payload: 'secret' });
  recorder.creditPayment({ stage: 'qr', durationMs: 7, ready: true, payload: 'secret' });
  recorder.creditPayment({ stage: 'unknown', durationMs: 9, payload: 'secret' });
  await recorder.flush();
  const rows = (await readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.step), ['credit.payment.confirm', 'credit.payment.qr']);
  assert.equal(rows[0].durationMs, 42); assert.equal(rows[0].qrReady, true);
  assert.doesNotMatch(JSON.stringify(rows), /secret|payload/);
});
