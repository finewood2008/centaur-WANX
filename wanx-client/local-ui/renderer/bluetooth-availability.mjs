// Web Bluetooth only checks adapter presence. The desktop probe also checks
// radio power; a false Web Bluetooth result is not proof of permission denial.
export function createBluetoothAvailability(bluetooth, readRadioState) {
  let state = { status: bluetooth?.getAvailability ? "checking" : "unsupported" };
  let generation = 0, disposed = false;
  const listeners = new Set();
  const snapshot = () => ({ ...state });
  const publish = (status) => {
    if (disposed || state.status === status) return;
    state = { status };
    for (const listener of listeners) listener(snapshot());
  };
  const reportError = (error) => {
    if (["NotAllowedError", "SecurityError"].includes(error?.name)) {
      ++generation;
      publish("permission-denied");
    }
  };
  async function refresh() {
    if (disposed || !bluetooth?.getAvailability) return snapshot();
    const expected = ++generation;
    publish("checking");
    try {
      const [available, radio] = await Promise.all([
        bluetooth.getAvailability(),
        readRadioState ? readRadioState() : Promise.resolve({ status: "available" }),
      ]);
      if (expected === generation) publish(radio?.status === "permission-denied" ? "permission-denied" :
        !available ? "unavailable" :
          ["available", "unavailable", "unsupported", "error"].includes(radio?.status) ? radio.status : "error");
    } catch (error) {
      if (expected === generation) {
        if (["NotAllowedError", "SecurityError"].includes(error?.name)) reportError(error);
        else publish("error");
      }
    }
    return snapshot();
  }
  const changed = (event) => {
    ++generation;
    if (!event.value) publish("unavailable");
    else if (readRadioState) void refresh();
    else publish("available");
  };
  bluetooth?.addEventListener?.("availabilitychanged", changed);
  return {
    snapshot, refresh, reportError,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      ++generation;
      listeners.clear();
      bluetooth?.removeEventListener?.("availabilitychanged", changed);
    },
  };
}
