// Loaded before renderer.js; the renderer owns presentation and the setup handoff.
function createDiscoverySelection({ discovery, transport, onChange, onNotice, onSelected }) {
  let candidates = [], sessionId = null, selectionPromise, retained, expiry, cancelSettlementWait;
  let generation = 0, disposed = false;

  function changed() {
    onChange({
      selecting: Boolean(selectionPromise),
      retained: Boolean(retained),
      candidates: (retained?.candidates || candidates).map(candidate => ({ ...candidate })),
    });
  }
  function forgetRetained() {
    clearTimeout(expiry);
    expiry = undefined;
    if (retained) discovery?.forget(retained.sessionId);
    retained = undefined;
  }
  function clearSelection() {
    ++generation;
    cancelSettlementWait?.();
    selectionPromise = undefined;
    transport?.cancelSelection();
    if (sessionId) discovery?.forget(sessionId);
    forgetRetained();
    candidates = [];
    sessionId = null;
  }
  function waitForCancellation(promise) {
    return new Promise(resolve => {
      let settled = false;
      const finish = ready => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cancelSettlementWait === cancel) cancelSettlementWait = undefined;
        resolve(ready);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, 2000);
      cancelSettlementWait = cancel;
      Promise.resolve(promise).then(() => finish(true), cancel);
    });
  }
  function retain() {
    if (retained || !sessionId || !candidates.length) return;
    const result = { sessionId, candidates: [...candidates] };
    retained = result;
    expiry = setTimeout(() => {
      if (disposed || retained !== result) return;
      clearSelection();
      onNotice({ kind: "expired" });
      changed();
    }, 120000);
  }
  function start(candidateId) {
    if (disposed || selectionPromise) return;
    if (!transport) {
      onNotice({ kind: "unavailable" });
      changed();
      return;
    }
    const previous = candidateId && retained;
    if (candidateId && !previous?.candidates.some(candidate => candidate.candidateId === candidateId)) return;
    if (!previous) clearSelection();
    onNotice(null);
    candidates = [];
    sessionId = null;
    const expected = ++generation;
    // Do not yield or notify observers between reselect and the browser gesture call.
    if (previous) discovery.reselect(previous.sessionId, candidateId);
    selectionPromise = transport.requestDeviceFromUserGesture();
    const attempt = selectionPromise;
    changed();
    attempt.then(candidate => {
      if (disposed || expected !== generation || selectionPromise !== attempt) return;
      selectionPromise = undefined;
      forgetRetained();
      candidates = [];
      sessionId = null;
      changed();
      if (!disposed && expected === generation) onSelected(candidate);
    }, async error => {
      if (disposed || expected !== generation || selectionPromise !== attempt) return;
      retain();
      if (sessionId) discovery?.cancel(sessionId);
      const cancellation = transport.cancelSelection();
      if (cancellation && typeof cancellation.then === "function") {
        // Keep retained cards disabled until the old Chromium chooser has
        // actually closed, not merely until our local timeout has fired.
        changed();
        const ready = await waitForCancellation(cancellation);
        if (disposed || expected !== generation || selectionPromise !== attempt) return;
        if (!ready) {
          clearSelection();
          onNotice({ kind: "selection_cancel_failed" });
          changed();
          return;
        }
      }
      selectionPromise = undefined;
      candidates = [];
      sessionId = null;
      onNotice(previous ? { kind: "reselect_failed" } : retained ? null :
        error.name === "NotFoundError" || error.code === "LOCAL_SELECTION_TIMEOUT"
          ? { kind: "empty" } : { kind: "error", message: error.message });
      changed();
    });
  }
  const unsubscribe = discovery?.subscribe(payload => {
    if (disposed || !selectionPromise || !payload || typeof payload.sessionId !== "string") return;
    sessionId = payload.sessionId;
    candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    changed();
  }, payload => {
    if (!disposed && selectionPromise && payload?.sessionId === sessionId && payload.cancelled) {
      retain();
      changed();
    }
  });
  return Object.freeze({
    start: () => start(),
    choose(candidateId) {
      if (disposed) return;
      if (retained && !selectionPromise) start(candidateId);
      else if (sessionId && !retained) discovery?.select(sessionId, candidateId);
    },
    reset() {
      if (disposed) return;
      clearSelection();
      changed();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearSelection();
      unsubscribe?.();
    },
  });
}
