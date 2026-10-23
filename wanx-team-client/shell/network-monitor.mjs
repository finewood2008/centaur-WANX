import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";

// SystemConfiguration also reports Wi-Fi/link/router changes that retain the
// same local address. Only notification presence is consumed, never its data.
export function watchSystemNetworkPath(
  onChange,
  { platform = process.platform, spawnProcess = spawn } = {},
) {
  if (platform !== "darwin") return () => {};
  let processHandle,
    stopped = false;
  try {
    processHandle = spawnProcess("/usr/sbin/scutil", [], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    processHandle.on("error", () => {}); // Address polling remains available.
    processHandle.stdin.on("error", () => {});
    processHandle.stdout.on("data", (data) => {
      if (!stopped && /notification|State:\/Network\//.test(data.toString()))
        onChange();
    });
    processHandle.stdin.write(
      "n.add State:/Network/Global/IPv4\nn.add State:/Network/Global/IPv6\n" +
        "n.add State:/Network/Interface/.*/(AirPort|Link) pattern\nn.watch\n",
    );
  } catch {
    /* Unsupported environment: keep portable address polling. */
  }
  return () => {
    stopped = true;
    processHandle?.stdin.destroy();
    processHandle?.kill();
  };
}

// Observe physical address changes without collecting SSIDs or sending probes.
// The userspace network's own interfaces must not trigger a reconnect loop.
export function networkFingerprint(interfaces) {
  return JSON.stringify(
    Object.entries(interfaces)
      .flatMap(([name, addresses]) =>
        /^(utun|tun|tap|wg|netbird|lo\d*)/i.test(name)
          ? []
          : (addresses || [])
              .filter((address) => !address.internal)
              .map(
                (address) =>
                  `${name}:${address.family}:${address.address}:${
                    address.scopeid || 0
                  }`,
              ),
      )
      .sort(),
  );
}

export function monitorNetworkChanges({
  powerMonitor,
  onChange,
  onError = () => {},
  readInterfaces = networkInterfaces,
  pollMs = 1000,
  debounceMs = 500,
  watchPath = watchSystemNetworkPath,
}) {
  let stopped = false,
    timer,
    running = false,
    pending = false;
  let fingerprint = networkFingerprint(readInterfaces());
  async function flush() {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await onChange();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (pending && !stopped) {
        pending = false;
        schedule();
      }
    }
  }
  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    timer.unref?.();
  }
  function check() {
    try {
      const next = networkFingerprint(readInterfaces());
      if (next !== fingerprint) {
        fingerprint = next;
        schedule();
      }
    } catch (error) {
      onError(error);
    }
  }
  const interval = setInterval(check, pollMs);
  interval.unref?.();
  const resume = () => {
    check();
    schedule();
  };
  powerMonitor?.on("resume", resume);
  const stopPathWatch = watchPath(schedule);
  return () => {
    stopped = true;
    clearInterval(interval);
    clearTimeout(timer);
    powerMonitor?.removeListener("resume", resume);
    stopPathWatch();
  };
}
