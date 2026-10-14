import {
  createElectronBluetoothSelectionEndpoint,
  createElectronGattTransportEndpoint,
  createElectronGattTransportFactory,
  type BluetoothNavigatorLike,
  type ElectronBluetoothSelectionEndpoint,
  type ElectronGattTransportEndpoint,
  type ReassemblyClock,
  type SelectedDiscoveryCandidate,
} from "@nexusaos/local-provisioning-electron-ble";
import type {
  SetupTransportBridge,
  SetupTransportRequest,
} from "./deviceSetupBridge";

const failure = (code: string) => Object.assign(new Error(code), { code });
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
const responseTypes = new Set([
  "device.info.result",
  "hello.result",
  "status.result",
  "pairing.start.result",
  "pairing.challenge.result",
  "pairing.token.result",
  "pairing.cancel.result",
  "wifi.scan.result",
  "wifi.apply.result",
  "job.status.result",
]);
function frameBytes(value: unknown, max: number): Uint8Array {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  )
    throw failure("PROTOCOL_CHANGED");
  return Uint8Array.from(value);
}
function outputBytes(value: Uint8Array, max: number): number[] {
  if (!(value instanceof Uint8Array) || !value.length || value.length > max)
    throw failure("PROTOCOL_CHANGED");
  return Array.from(value);
}
function candidate(value: unknown): SelectedDiscoveryCandidate {
  if (
    !object(value) ||
    Object.keys(value).length !== 8 ||
    value.transport !== "ble-gatt" ||
    !identifier(value.candidateId) ||
    !identifier(value.transportHandle) ||
    !identifier(value.selectionLeaseId) ||
    typeof value.advertisedName !== "string" ||
    value.advertisedName.length > 64 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value.advertisedName) ||
    !(
      value.rssi === null ||
      (typeof value.rssi === "number" &&
        Number.isFinite(value.rssi) &&
        value.rssi <= 0)
    ) ||
    typeof value.firstSeenMonotonicMs !== "number" ||
    !Number.isFinite(value.firstSeenMonotonicMs) ||
    value.firstSeenMonotonicMs < 0 ||
    typeof value.lastSeenMonotonicMs !== "number" ||
    !Number.isFinite(value.lastSeenMonotonicMs) ||
    value.lastSeenMonotonicMs < value.firstSeenMonotonicMs
  )
    throw failure("INVALID_REQUEST");
  return { ...value } as unknown as SelectedDiscoveryCandidate;
}

export interface DeviceSetupTransport {
  requestDeviceFromUserGesture(): Promise<SelectedDiscoveryCandidate>;
  cancelSelection(): void;
  dispose(): Promise<void>;
}

/** Renderer owns GATT handles; Main supplies only bounded protocol frames. */
export function createDeviceSetupTransport(options: {
  bridge: SetupTransportBridge;
  bluetooth: BluetoothNavigatorLike;
  selectionTimeoutMs?: number;
  clock?: ReassemblyClock;
  /** Integration seams for transport lifecycle tests. */
  selectionFactory?: (input: {
    bluetooth: BluetoothNavigatorLike;
    clock: ReassemblyClock;
  }) => ElectronBluetoothSelectionEndpoint;
  endpointFactory?: (
    selection: ElectronBluetoothSelectionEndpoint,
    clock: ReassemblyClock,
  ) => ElectronGattTransportEndpoint;
}): DeviceSetupTransport {
  const clock = options.clock ?? { monotonicMs: () => performance.now() };
  const makeSelection = () =>
    (options.selectionFactory ?? createElectronBluetoothSelectionEndpoint)({
      bluetooth: options.bluetooth,
      clock,
    });
  const makeEndpoint = (
    currentSelection: ElectronBluetoothSelectionEndpoint,
  ) =>
    options.endpointFactory
      ? options.endpointFactory(currentSelection, clock)
      : createElectronGattTransportEndpoint({
          factory: createElectronGattTransportFactory({
            consumeSelectionLease: (selected) =>
              selection.consumeSelectionLease(selected),
            clock,
          }),
        });
  let selection = makeSelection(),
    endpoint = makeEndpoint(selection);
  let epoch = 0,
    selectionEpoch = 0,
    disposed = false,
    disposing: Promise<void> | undefined;
  let selectionCancel: (() => void) | undefined;
  const flights = new Map<
    string,
    { abort: AbortController; connectionId?: string }
  >();
  const subscriptions = new Map<string, () => Promise<void>>();
  const abortFlights = (connectionId?: string) => {
    for (const flight of flights.values())
      if (connectionId === undefined || flight.connectionId === connectionId)
        flight.abort.abort();
  };
  const unsubscribeStatus = async (id: string) => {
    const unsubscribe = subscriptions.get(id);
    subscriptions.delete(id);
    await unsubscribe?.();
  };
  function cancelSelection() {
    selectionCancel?.();
    ++selectionEpoch;
    selection.cancelSelection();
    // A cancelled Chromium chooser may resolve later; isolate its one-use lease.
    selection = makeSelection();
  }
  async function closeAll() {
    ++epoch;
    abortFlights();
    cancelSelection();
    const previous = endpoint;
    endpoint = makeEndpoint(selection);
    const clears = [...subscriptions.keys()].map(unsubscribeStatus);
    await Promise.allSettled([...clears, previous.closeAll()]);
  }
  async function handle(input: SetupTransportRequest) {
    if (disposed || !object(input) || !identifier(input.requestId)) return;
    const requestId = input.requestId;
    if (flights.has(requestId)) return;
    const allowed = [
      "connect",
      "readDeviceInfo",
      "request",
      "subscribeStatus",
      "close",
      "closeAll",
    ];
    if (
      !allowed.includes(input.operation) ||
      !Array.isArray(input.args) ||
      input.args.length > 3 ||
      Object.keys(input).some(
        (key) => !["requestId", "operation", "args"].includes(key),
      )
    ) {
      options.bridge.reply({ requestId, ok: false, code: "INVALID_REQUEST" });
      return;
    }
    if (input.operation === "closeAll") {
      if (input.args.length) {
        options.bridge.reply({ requestId, ok: false, code: "INVALID_REQUEST" });
        return;
      }
      await closeAll();
      if (!disposed) options.bridge.reply({ requestId, ok: true });
      return;
    }
    if (flights.size >= 16) {
      options.bridge.reply({
        requestId,
        ok: false,
        code: "RESOURCE_EXHAUSTED",
      });
      return;
    }
    const expected = epoch,
      current = endpoint,
      abort = new AbortController();
    const flight: { abort: AbortController; connectionId?: string } = { abort };
    flights.set(requestId, flight);
    const active = () => {
      if (disposed || epoch !== expected || abort.signal.aborted)
        throw failure("LOCAL_TRANSPORT_DISCONNECTED");
    };
    try {
      let value: unknown;
      if (input.operation === "connect") {
        if (input.args.length !== 1) throw failure("INVALID_REQUEST");
        const selected = candidate(input.args[0]);
        const id = await current.connect(selected, abort.signal);
        if (disposed || epoch !== expected || abort.signal.aborted) {
          await current.close(id).catch(() => undefined);
          active();
        }
        if (!identifier(id)) {
          await current.close(id).catch(() => undefined);
          throw failure("PROTOCOL_CHANGED");
        }
        value = id;
      } else {
        const id = input.args[0];
        if (
          !identifier(id) ||
          input.args.length !== (input.operation === "request" ? 3 : 1)
        )
          throw failure("INVALID_REQUEST");
        flight.connectionId = id;
        if (input.operation === "readDeviceInfo")
          value = outputBytes(
            await current.readDeviceInfo(id, abort.signal),
            512,
          );
        else if (input.operation === "request") {
          const frame = frameBytes(input.args[1], 2048),
            match = input.args[2];
          if (
            !object(match) ||
            Object.keys(match).length !== 2 ||
            !uuid(match.requestId) ||
            typeof match.responseMessageType !== "string" ||
            !responseTypes.has(match.responseMessageType)
          )
            throw failure("INVALID_REQUEST");
          value = outputBytes(
            await current.request(
              id,
              frame,
              {
                requestId: match.requestId,
                responseMessageType: match.responseMessageType,
              },
              abort.signal,
            ),
            2048,
          );
        } else if (input.operation === "subscribeStatus") {
          await unsubscribeStatus(id);
          active();
          let subscribed = true;
          const unsubscribe = await current.subscribeStatus(
            id,
            (frame) => {
              if (
                !subscribed ||
                disposed ||
                epoch !== expected ||
                abort.signal.aborted
              )
                return;
              try {
                options.bridge.status(id, outputBytes(frame, 2048));
              } catch {
                abort.abort();
                void current.close(id).catch(() => undefined);
              }
            },
            abort.signal,
          );
          if (disposed || epoch !== expected || abort.signal.aborted) {
            await unsubscribe();
            active();
          }
          subscriptions.set(id, async () => {
            subscribed = false;
            await unsubscribe();
          });
        } else if (input.operation === "close") {
          abortFlights(id);
          await unsubscribeStatus(id);
          await current.close(id);
          value = undefined;
          // This operation deliberately aborts its own per-connection flight.
          if (disposed || epoch !== expected)
            throw failure("LOCAL_TRANSPORT_DISCONNECTED");
          if (!disposed) options.bridge.reply({ requestId, ok: true });
          return;
        }
      }
      active();
      options.bridge.reply({
        requestId,
        ok: true,
        ...(value === undefined ? {} : { value }),
      });
    } catch (error) {
      if (!disposed) {
        const code = (error as { code?: unknown })?.code;
        options.bridge.reply({
          requestId,
          ok: false,
          code:
            typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code)
              ? code
              : "LOCAL_TRANSPORT_DISCONNECTED",
        });
      }
    } finally {
      flights.delete(requestId);
    }
  }
  const unsubscribe = options.bridge.subscribe((request) => {
    void handle(request);
  });
  return {
    requestDeviceFromUserGesture(): Promise<SelectedDiscoveryCandidate> {
      if (disposed)
        return Promise.reject(failure("LOCAL_TRANSPORT_DISCONNECTED"));
      const expected = selectionEpoch,
        current = selection;
      // Settle cancellation locally even if Chromium never resolves its chooser.
      // The SDK request must remain synchronous within this user gesture.
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (
          error?: unknown,
          selected?: SelectedDiscoveryCandidate,
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (selectionCancel === cancel) selectionCancel = undefined;
          if (error) reject(error);
          else resolve(selected!);
        };
        const cancel = () => finish(failure("LOCAL_SELECTION_LEASE_INVALID"));
        const timer = setTimeout(() => {
          finish(failure("LOCAL_SELECTION_TIMEOUT"));
          cancelSelection();
        }, options.selectionTimeoutMs ?? 12000);
        selectionCancel = cancel;
        try {
          void current.requestDeviceFromUserGesture().then(
            (selected) => {
              if (disposed || expected !== selectionEpoch || settled) {
                current.cancelSelection();
                finish(failure("LOCAL_SELECTION_LEASE_INVALID"));
                return;
              }
              finish(undefined, selected);
            },
            (error) => finish(error),
          );
        } catch (error) {
          finish(error);
        }
      });
    },
    cancelSelection,
    dispose(): Promise<void> {
      if (disposing) return disposing;
      disposed = true;
      unsubscribe();
      disposing = closeAll();
      return disposing;
    },
  };
}
