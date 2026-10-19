const scopeIdentity = scope => scope && typeof scope.accountId === "string" && scope.accountId &&
  typeof scope.deviceId === "string" && scope.deviceId ? JSON.stringify([scope.accountId, scope.deviceId]) : null;

/** Schedule a preparation pass after a ready connection, with bounded retries.
 * getScope must return null when logged out or disconnected. Call sync for
 * account/connection changes; progress notifications may also call it safely.
 * close stops scheduling and cancels work, but delivery retains its own lifecycle.
 */
export function createDefaultApplicationScheduler({
  delivery, getScope, setTimer = setTimeout, clearTimer = clearTimeout, retryMs = 60000,
} = {}) {
  if (!Number.isFinite(retryMs) || retryMs < 1000) throw new TypeError("retryMs must be at least 1000");
  let current = null, epoch = 0, timer = null, pending = null, closed = false;
  function scope() {
    try { return scopeIdentity(getScope()); } catch { return null; }
  }
  function cancelTimer() {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  function run() {
    if (closed || !current || pending) return pending;
    const generation = epoch;
    // Defer the call so pending is assigned before delivery publishes progress.
    // A synchronous onChanged -> sync must not start another pass.
    pending = Promise.resolve().then(() => {
      if (closed || generation !== epoch) return { status: "cancelled" };
      return delivery.ensureDefaultApplications();
    }).catch(() => ({ status: "pending" })).then(result => {
      if (closed || generation !== epoch) return result;
      pending = null;
      if (scope() !== current) { sync(); return result; }
      if (result?.status === "pending") {
        timer = setTimer(() => {
          timer = null;
          if (closed || generation !== epoch) return;
          if (scope() !== current) sync();
          else run();
        }, retryMs);
        timer?.unref?.();
      }
      return result;
    });
    return pending;
  }
  function sync() {
    if (closed) return;
    const next = scope();
    if (next === current) return pending;
    current = next;
    epoch++;
    cancelTimer();
    pending = null;
    delivery.invalidate();
    return next ? run() : undefined;
  }
  return Object.freeze({
    sync,
    async close() {
      if (closed) return;
      closed = true;
      epoch++;
      cancelTimer();
      const running = pending;
      pending = null;
      current = null;
      delivery.invalidate();
      await running;
    },
  });
}
