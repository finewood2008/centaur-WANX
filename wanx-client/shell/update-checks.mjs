const busyPhases = new Set(["checking", "downloading", "downloaded", "installing"]);

// Checking is automatic; downloading and restarting remain explicit user actions.
export function createUpdateChecks({
  updates, getAccount, enabled = true, intervalMs = 60 * 60 * 1000,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
}) {
  let identity = null, timer = null, pending = null, closed = false, lastCheck = null, serverRefreshIdentity = null;
  function scope() {
    const account = getAccount(), state = updates.snapshot();
    return enabled && state.current?.packaged && state.current.distributionClass === "formal" &&
      !["development", "unavailable"].includes(state.phase) && account.phase === "authenticated" && account.accountId
      ? JSON.stringify([account.accountId, account.clientId]) : null;
  }
  function cancelTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  function schedule(delay) {
    cancelTimer();
    timer = setTimer(() => { timer = null; void run(); }, delay);
    timer?.unref?.();
  }
  function run() {
    if (closed || !identity || pending) return pending;
    const startedIdentity = identity;
    pending = Promise.resolve().then(() => {
      if (closed || identity !== startedIdentity || scope() !== startedIdentity) return;
      const phase = updates.snapshot().phase;
      if (!busyPhases.has(phase) || phase === "downloaded" && serverRefreshIdentity === identity) {
        serverRefreshIdentity = null;
        lastCheck = { identity, at: now() };
        return updates.check();
      }
    }).catch(() => {
      // The update service publishes failures; retry only at the next interval.
    }).finally(() => {
      pending = null;
      if (closed) return;
      const next = scope();
      if (next !== identity) { identity = next; serverRefreshIdentity = null; cancelTimer(); }
      if (!identity) return;
      if (identity !== startedIdentity) { void run(); return; }
      schedule(intervalMs);
    });
    return pending;
  }
  return Object.freeze({
    sync() {
      if (closed) return;
      const next = scope();
      if (next === identity) return pending;
      identity = next;
      serverRefreshIdentity = null;
      cancelTimer();
      return identity ? run() : pending;
    },
    checkNow() {
      if (closed) return;
      const next = scope();
      if (next !== identity) { identity = next; serverRefreshIdentity = null; cancelTimer(); }
      if (!identity) return pending;
      // A server requirement can supersede a downloaded optional release.
      // Retain that intent across both the cooldown and a queued ordinary check.
      serverRefreshIdentity = identity;
      if (pending) return pending;
      // Concurrent business failures can all report 426. Coalesce those hints
      // into a bounded retry without waiting for the normal hourly check.
      const wait = lastCheck?.identity === identity ? 60000 - (now() - lastCheck.at) : 0;
      if (wait > 0) { schedule(wait); return; }
      cancelTimer();
      return run();
    },
    close() { closed = true; identity = null; serverRefreshIdentity = null; cancelTimer(); },
  });
}
