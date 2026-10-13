// Loaded before renderer.js; the renderer owns presentation and the setup handoff.
function createDiscoverySelection({ discovery, transport, onChange, onNotice, onSelected }) {
  let candidates = [], sessionId = null, selectionPromise, retained, expiry;
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
    selectionPromise = undefined;
    transport?.cancelSelection();
    if (sessionId) discovery?.forget(sessionId);
    forgetRetained();
    candidates = [];
    sessionId = null;
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
    }, error => {
      if (disposed || expected !== generation || selectionPromise !== attempt) return;
      retain();
      if (sessionId) discovery?.cancel(sessionId);
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
