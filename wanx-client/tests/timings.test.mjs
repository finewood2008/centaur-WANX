import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTimingRecorder } from "../shell/timings.mjs";
import { BOX_SESSION_ERROR_CODES } from "../octop/platform.mjs";

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
