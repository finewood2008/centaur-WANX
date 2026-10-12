import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTimingRecorder } from "../shell/timings.mjs";

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
