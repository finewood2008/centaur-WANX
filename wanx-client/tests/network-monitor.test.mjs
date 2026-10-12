import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  networkFingerprint,
  monitorNetworkChanges,
  watchSystemNetworkPath,
} from "../shell/network-monitor.mjs";
const address = (ip) => ({ address: ip, family: "IPv4", internal: false });
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("network fingerprint ignores ordering, loopback, and tunnel churn", () => {
  const a = { en0: [address("192.0.2.1")], utun7: [address("100.64.0.1")] };
  const b = {
    lo0: [{ ...address("127.0.0.1"), internal: true }],
    en0: [address("192.0.2.1")],
  };
  assert.equal(networkFingerprint(a), networkFingerprint(b));
  assert.notEqual(
    networkFingerprint(a),
    networkFingerprint({ en0: [address("192.0.2.2")] }),
  );
});

test("address changes and resume coalesce; stopping removes all future notifications", async (t) => {
  const power = new EventEmitter();
  let interfaces = { en0: [address("192.0.2.1")] },
    changes = 0;
  const stop = monitorNetworkChanges({
    watchPath: () => () => {},
    powerMonitor: power,
    readInterfaces: () => interfaces,
    pollMs: 2,
    debounceMs: 5,
    onChange: () => {
      changes++;
    },
  });
  t.after(stop);
  await wait();
  assert.equal(changes, 0);
  interfaces = { en0: [address("192.0.2.2")] };
  power.emit("resume");
  power.emit("resume");
  await wait();
  assert.equal(changes, 1);
  stop();
  power.emit("resume");
  interfaces = { en0: [address("192.0.2.3")] };
  await wait();
  assert.equal(changes, 1);
  assert.equal(power.listenerCount("resume"), 0);
});

test("network monitor never overlaps recovery jobs", async (t) => {
  const power = new EventEmitter();
  let active = 0,
    maximum = 0,
    count = 0,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const stop = monitorNetworkChanges({
    watchPath: () => () => {},
    powerMonitor: power,
    readInterfaces: () => ({}),
    pollMs: 10,
    debounceMs: 2,
    async onChange() {
      active++;
      count++;
      maximum = Math.max(maximum, active);
      if (count === 1) await held;
      active--;
    },
  });
  t.after(stop);
  power.emit("resume");
  await wait();
  power.emit("resume");
  await wait();
  assert.equal(count, 1);
  release();
  await wait();
  assert.equal(count, 2);
  assert.equal(maximum, 1);
});

test("macOS path notifications cover unchanged IP and stop with the app", () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  let script = "",
    killed = false,
    changes = 0;
  child.stdin.write = (value) => {
    script = value;
  };
  child.stdin.destroy = () => {};
  child.kill = () => {
    killed = true;
  };
  const stop = watchSystemNetworkPath(() => changes++, {
    platform: "darwin",
    spawnProcess: (binary, args) => {
      assert.equal(binary, "/usr/sbin/scutil");
      assert.deepEqual(args, []);
      return child;
    },
  });
  assert.match(script, /Global\/IPv4/);
  assert.match(script, /AirPort\|Link/);
  child.stdout.emit("data", Buffer.from("> > >"));
  assert.equal(changes, 0);
  child.stdout.emit(
    "data",
    Buffer.from("notification: State:/Network/Interface/en0/AirPort"),
  );
  assert.equal(changes, 1);
  stop();
  child.stdout.emit("data", Buffer.from("notification"));
  assert.equal(changes, 1);
  assert.equal(killed, true);
});
