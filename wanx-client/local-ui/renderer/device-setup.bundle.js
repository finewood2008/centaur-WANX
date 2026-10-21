(() => {
  // node_modules/@nexusaos/local-provisioning-contracts/dist/index.js
  var PROVISIONING_SERVICE_UUID = "f6c7b7a0-5a0f-4b7f-9f3f-4d3f7b5a1000";
  var DEVICE_INFO_UUID = "f6c7b7a1-5a0f-4b7f-9f3f-4d3f7b5a1000";
  var COMMAND_UUID = "f6c7b7a2-5a0f-4b7f-9f3f-4d3f7b5a1000";
  var STATUS_UUID = "f6c7b7a3-5a0f-4b7f-9f3f-4d3f7b5a1000";
  var SETUP_NAME_PREFIX = "CentaurOS-Setup-";
  var GATT_HEADER_BYTES = 8;
  var GATT_PAYLOAD_BYTES = 12;
  var GATT_MAX_LOGICAL_BYTES = 2048;
  var GATT_MAX_FRAGMENTS = 171;
  var RETRYABLE = /* @__PURE__ */ new Set([
    "LOCAL_CONNECT_TIMEOUT",
    "GATT_FRAGMENT_INCOMPLETE",
    "LOCAL_TRANSPORT_DISCONNECTED"
  ]);
  var LocalProvisioningFailure = class extends Error {
    code;
    name = "LocalProvisioningFailure";
    retryable;
    constructor(code) {
      super(code);
      this.code = code;
      this.retryable = RETRYABLE.has(code);
    }
  };

  // node_modules/@nexusaos/local-provisioning-electron-ble/dist/index.js
  var GATT_FLAG_START = 1;
  var GATT_FLAG_END = 2;
  var protocol = () => {
    throw new LocalProvisioningFailure("GATT_FRAGMENT_PROTOCOL_ERROR");
  };
  function fragmentLogicalFrame(frame, messageId) {
    if (!(frame instanceof Uint8Array) || frame.length < 2 || frame.length > GATT_MAX_LOGICAL_BYTES || frame[frame.length - 1] !== 10 || !Number.isInteger(messageId) || messageId < 1 || messageId > 65535)
      protocol();
    const count = Math.ceil(frame.length / GATT_PAYLOAD_BYTES);
    if (count < 1 || count > GATT_MAX_FRAGMENTS)
      protocol();
    const output = [];
    for (let index = 0; index < count; index++) {
      const payload = frame.slice(index * GATT_PAYLOAD_BYTES, (index + 1) * GATT_PAYLOAD_BYTES);
      const value = new Uint8Array(GATT_HEADER_BYTES + payload.length);
      const view = new DataView(value.buffer);
      value[0] = 2;
      value[1] = (index === 0 ? GATT_FLAG_START : 0) | (index === count - 1 ? GATT_FLAG_END : 0);
      view.setUint16(2, messageId);
      view.setUint16(4, index);
      view.setUint16(6, count);
      value.set(payload, 8);
      output.push(value);
    }
    return output;
  }
  function createGattReassembler(clock, timeoutMs = 5e3) {
    let id = 0, count = 0, next = 0, started = 0, lastAt = 0, total = 0, chunks = [];
    const reset = () => {
      id = count = next = started = lastAt = total = 0;
      chunks = [];
    };
    const timeout = () => {
      const now = clock.monotonicMs();
      if (next > 0 && (now - lastAt >= timeoutMs || now - started >= 3e4)) {
        reset();
        throw new LocalProvisioningFailure("GATT_FRAGMENT_INCOMPLETE");
      }
    };
    return {
      get pending() {
        return next > 0;
      },
      reset,
      checkTimeout: timeout,
      push(fragment) {
        timeout();
        if (!(fragment instanceof Uint8Array) || fragment.length < GATT_HEADER_BYTES || fragment.length > 20)
          protocol();
        const view = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength);
        const version = fragment[0], flags = fragment[1], messageId = view.getUint16(2), index = view.getUint16(4), fragmentCount = view.getUint16(6);
        if (version !== 2 || (flags & ~3) !== 0 || messageId < 1 || fragmentCount < 1 || fragmentCount > GATT_MAX_FRAGMENTS || index >= fragmentCount || fragment.length === 8)
          protocol();
        if (next === 0) {
          if (index !== 0 || (flags & GATT_FLAG_START) === 0) {
            protocol();
          }
          id = messageId;
          count = fragmentCount;
          started = lastAt = clock.monotonicMs();
        } else if (messageId !== id || fragmentCount !== count || index !== next || (flags & GATT_FLAG_START) !== 0)
          protocol();
        const last = index === fragmentCount - 1;
        if (last !== Boolean(flags & GATT_FLAG_END) || !last && fragment.length !== 20)
          protocol();
        const payload = fragment.slice(8);
        total += payload.length;
        if (total > GATT_MAX_LOGICAL_BYTES)
          protocol();
        chunks.push(payload);
        next++;
        lastAt = clock.monotonicMs();
        if (!last)
          return void 0;
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        reset();
        if (result[result.length - 1] !== 10)
          protocol();
        return result;
      }
    };
  }
  function createMessageIdAllocator() {
    let cursor = 0;
    const pending = /* @__PURE__ */ new Set();
    const recent = /* @__PURE__ */ new Map();
    return {
      next(now) {
        for (const [id, at] of recent)
          if (now - at >= 3e4)
            recent.delete(id);
        for (let tries = 0; tries < 65535; tries++) {
          cursor = cursor === 65535 ? 1 : cursor + 1;
          if (!pending.has(cursor) && !recent.has(cursor))
            return cursor;
        }
        return protocol();
      },
      markPending(id) {
        if (!Number.isInteger(id) || id < 1 || id > 65535 || pending.has(id) || recent.has(id))
          protocol();
        pending.add(id);
      },
      release(id, now) {
        if (!pending.delete(id))
          protocol();
        recent.set(id, now);
      },
      clear() {
        pending.clear();
        recent.clear();
        cursor = 0;
      }
    };
  }
  var ELECTRON_GATT_V2_PROFILE = Object.freeze({
    serviceUuid: PROVISIONING_SERVICE_UUID,
    deviceInfoUuid: DEVICE_INFO_UUID,
    commandUuid: COMMAND_UUID,
    statusUuid: STATUS_UUID,
    namePrefix: SETUP_NAME_PREFIX,
    deviceInfoMaxBytes: 512,
    logicalFrameMaxBytes: GATT_MAX_LOGICAL_BYTES,
    attributeMaxBytes: 20,
    writeMode: "with-response",
    statusMode: "notify-only"
  });
  function createElectronBluetoothSelectionEndpoint(input) {
    const randomId = input.randomId ?? (() => crypto.randomUUID());
    const leaseMs = input.leaseMs ?? 6e4;
    let selected;
    return {
      async requestDeviceFromUserGesture() {
        selected = void 0;
        const device = await input.bluetooth.requestDevice({
          filters: [
            {
              services: [PROVISIONING_SERVICE_UUID]
            }
          ],
          optionalServices: [PROVISIONING_SERVICE_UUID]
        });
        const advertisedName = device.name ?? "";
        if (typeof advertisedName !== "string" || advertisedName.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(advertisedName))
          throw new LocalProvisioningFailure("LOCAL_SELECTION_LEASE_INVALID");
        const now = input.clock.monotonicMs(), handle = randomId(), lease = randomId();
        const candidate2 = {
          candidateId: handle,
          transport: "ble-gatt",
          transportHandle: handle,
          advertisedName,
          rssi: null,
          firstSeenMonotonicMs: now,
          lastSeenMonotonicMs: now,
          selectionLeaseId: lease
        };
        selected = { candidate: candidate2, device, expiresAt: now + leaseMs };
        return candidate2;
      },
      async consumeSelectionLease(candidate2) {
        const current = selected;
        selected = void 0;
        if (!current || input.clock.monotonicMs() > current.expiresAt || candidate2.transport !== "ble-gatt" || candidate2.selectionLeaseId !== current.candidate.selectionLeaseId || candidate2.transportHandle !== current.candidate.transportHandle || candidate2.candidateId !== current.candidate.candidateId)
          throw new LocalProvisioningFailure("LOCAL_SELECTION_LEASE_INVALID");
        return current.device;
      },
      cancelSelection() {
        selected = void 0;
      }
    };
  }
  var bytes = (view) => new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  var route = (frame) => {
    if (frame.length < 2 || frame[frame.length - 1] !== 10)
      protocol();
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, -1)));
    } catch {
      protocol();
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      protocol();
    const envelope = value;
    if (typeof envelope.request_id !== "string" || typeof envelope.message_type !== "string")
      protocol();
    return {
      requestId: envelope.request_id,
      messageType: envelope.message_type
    };
  };
  function createElectronGattTransportFactory(input) {
    let selected;
    return {
      async connect(candidate2, signal) {
        if (signal.aborted)
          throw new DOMException("Aborted", "AbortError");
        const device = selected && selected.candidateId === candidate2.candidateId && selected.transportHandle === candidate2.transportHandle && selected.selectionLeaseId === candidate2.selectionLeaseId ? selected.device : await input.consumeSelectionLease(candidate2);
        selected = {
          candidateId: candidate2.candidateId,
          transportHandle: candidate2.transportHandle,
          selectionLeaseId: candidate2.selectionLeaseId,
          device
        };
        if (!device.gatt)
          throw new LocalProvisioningFailure("GATT_SERVICE_NOT_FOUND");
        let server, service, deviceInfo, command, status;
        let stage = "connect", retired = false, closeOnRetire;
        const diagnosticFailure = (code, failureStage, error) => {
          const failure2 = new LocalProvisioningFailure(code);
          const names = [
            "NetworkError",
            "NotFoundError",
            "NotSupportedError",
            "InvalidStateError",
            "SecurityError",
            "AbortError",
            "TimeoutError",
            "UnknownError"
          ];
          failure2.diagnostic = {
            stage: failureStage,
            errorName: names.includes(error?.name) ? error.name : "UnknownError"
          };
          return failure2;
        };
        const retireConnection = () => {
          if (retired) return;
          retired = true;
          signal.removeEventListener("abort", retireConnection);
          closeOnRetire?.();
          device.gatt.disconnect();
        };
        signal.addEventListener("abort", retireConnection, { once: true });
        const assertActive = () => {
          if (signal.aborted || retired)
            throw new DOMException("Aborted", "AbortError");
        };
        try {
          server = await device.gatt.connect();
          assertActive();
          stage = "service";
          service = await server.getPrimaryService(PROVISIONING_SERVICE_UUID);
          assertActive();
          stage = "characteristic";
          deviceInfo = await service.getCharacteristic(DEVICE_INFO_UUID);
          assertActive();
          command = await service.getCharacteristic(COMMAND_UUID);
          assertActive();
          status = await service.getCharacteristic(STATUS_UUID);
          assertActive();
        } catch (error) {
          retireConnection();
          if (signal.aborted || error?.name === "AbortError")
            throw new DOMException("Aborted", "AbortError");
          const code = error?.name === "NotFoundError" && stage !== "connect" ? stage === "service" ? "GATT_SERVICE_NOT_FOUND" : "GATT_CHARACTERISTIC_MISMATCH" : "LOCAL_TRANSPORT_DISCONNECTED";
          throw diagnosticFailure(code, stage, error);
        }
        const allocator = createMessageIdAllocator(), reassemblers = /* @__PURE__ */ new Map(), completed = /* @__PURE__ */ new Map();
        let closed = false, pending, statusListener, terminalFailure;
        const closeWith = (error) => {
          if (closed)
            return;
          closed = true;
          terminalFailure = error ?? new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED");
          if (pending) {
            clearTimeout(pending.timer);
            pending.reject(error ?? new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED"));
            pending = void 0;
          }
          status.removeEventListener("characteristicvaluechanged", onStatus);
          device.removeEventListener("gattserverdisconnected", onDisconnect);
          void status.stopNotifications().catch(() => void 0);
          retireConnection();
          allocator.clear();
          reassemblers.clear();
        };
        const onDisconnect = () => closeWith(new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED"));
        const onStatus = (event) => {
          try {
            const characteristic = event.target, value = characteristic.value;
            if (!value)
              protocol();
            const fragment = bytes(value), id = new DataView(fragment.buffer, fragment.byteOffset, fragment.byteLength).getUint16(2);
            let reassembler = reassemblers.get(id);
            if (!reassembler) {
              reassembler = createGattReassembler(input.clock);
              reassemblers.set(id, reassembler);
            }
            const frame = reassembler.push(fragment);
            if (!frame)
              return;
            reassemblers.delete(id);
            const outer = route(frame), key = `${outer.requestId}
${outer.messageType}`, now = input.clock.monotonicMs();
            for (const [oldKey, at] of completed)
              if (now - at >= 3e4)
                completed.delete(oldKey);
            if (completed.has(key))
              return;
            if (pending && pending.key === key) {
              const current = pending;
              pending = void 0;
              clearTimeout(current.timer);
              completed.set(key, now);
              current.resolve(frame);
              return;
            }
            if (outer.messageType === "job.status.event" && statusListener) {
              completed.set(key, now);
              statusListener(frame);
              return;
            }
            protocol();
          } catch (error) {
            closeWith(error);
          }
        };
        closeOnRetire = () => closeWith(new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED"));
        device.addEventListener("gattserverdisconnected", onDisconnect);
        status.addEventListener("characteristicvaluechanged", onStatus);
        try {
          await status.startNotifications();
          assertActive();
        } catch (error) {
          closeWith();
          throw diagnosticFailure("LOCAL_TRANSPORT_DISCONNECTED", "notifications", error);
        }
        const transport = {
          kind: "ble-gatt",
          capabilities: { statusNotifications: true },
          async readDeviceInfo(readSignal) {
            if (closed)
              throw new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED");
            if (readSignal.aborted)
              throw new DOMException("Aborted", "AbortError");
            const result = bytes(await deviceInfo.readValue());
            if (result.length < 2 || result.length > 512)
              throw new LocalProvisioningFailure("LOCAL_DEVICE_INFO_INVALID");
            return result;
          },
          async request(logicalFrame, match, requestSignal) {
            if (closed)
              throw new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED");
            if (pending)
              throw new LocalProvisioningFailure("GATT_FRAGMENT_PROTOCOL_ERROR");
            if (requestSignal.aborted)
              throw new DOMException("Aborted", "AbortError");
            const id = allocator.next(input.clock.monotonicMs());
            const requestKey = `${match.requestId}
${match.responseMessageType}`;
            allocator.markPending(id);
            const response = new Promise((resolve, reject) => {
              pending = {
                key: requestKey,
                resolve,
                reject,
                timer: setTimeout(() => {
                  if (pending?.key === requestKey) {
                    const current = pending;
                    pending = void 0;
                    completed.set(requestKey, input.clock.monotonicMs());
                    const failure2 = new LocalProvisioningFailure("GATT_FRAGMENT_INCOMPLETE");
                    current.reject(failure2);
                    closeWith(failure2);
                  }
                }, input.requestTimeoutMs ?? 5e3)
              };
            });
            const interruption = new Promise((_, reject) => {
              void response.catch(reject);
            });
            void interruption.catch(() => void 0);
            const abort = () => {
              if (pending?.key === requestKey) {
                const current = pending;
                pending = void 0;
                clearTimeout(current.timer);
                completed.set(requestKey, input.clock.monotonicMs());
                current.reject(new DOMException("Aborted", "AbortError"));
              }
            };
            requestSignal.addEventListener("abort", abort, { once: true });
            try {
              for (const fragment of fragmentLogicalFrame(logicalFrame, id)) {
                if (requestSignal.aborted)
                  throw new DOMException("Aborted", "AbortError");
                if (closed) throw terminalFailure;
                await Promise.race([command.writeValueWithResponse(fragment.slice().buffer), interruption]);
              }
              return await response;
            } catch (error) {
              const current = pending;
              if (current?.key === requestKey) {
                pending = void 0;
                clearTimeout(current.timer);
                completed.set(requestKey, input.clock.monotonicMs());
                current.reject(error);
                await response.catch(() => void 0);
              }
              if (error instanceof DOMException && error.name === "AbortError") {
                closeWith(error);
                throw error;
              }
              const failure2 = error instanceof LocalProvisioningFailure ? error : new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED");
              closeWith(failure2);
              throw failure2;
            } finally {
              requestSignal.removeEventListener("abort", abort);
              if (!closed)
                allocator.release(id, input.clock.monotonicMs());
            }
          },
          async subscribeStatus(listener, subscribeSignal) {
            if (closed)
              throw new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED");
            if (subscribeSignal.aborted)
              throw new DOMException("Aborted", "AbortError");
            statusListener = listener;
            const clear = () => {
              if (statusListener === listener)
                statusListener = void 0;
            };
            subscribeSignal.addEventListener("abort", clear, { once: true });
            return async () => {
              subscribeSignal.removeEventListener("abort", clear);
              clear();
            };
          },
          async close() {
            closeWith();
          }
        };
        return transport;
      }
    };
  }
  function createElectronGattTransportEndpoint(input) {
    const connections = /* @__PURE__ */ new Map(), randomId = input.randomId ?? (() => crypto.randomUUID());
    const get = (id) => {
      const transport = connections.get(id);
      if (!transport)
        throw new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED");
      return transport;
    };
    return {
      async connect(candidate2, signal) {
        const transport = await input.factory.connect(candidate2, signal), id = randomId();
        connections.set(id, transport);
        return id;
      },
      readDeviceInfo(id, signal) {
        return get(id).readDeviceInfo(signal);
      },
      request(id, frame, match, signal) {
        return get(id).request(frame, match, signal);
      },
      async subscribeStatus(id, listener, signal) {
        const subscribe = get(id).subscribeStatus;
        if (!subscribe)
          throw new LocalProvisioningFailure("LOCAL_TRANSPORT_DISCONNECTED");
        return subscribe.call(get(id), listener, signal);
      },
      async close(id) {
        const transport = connections.get(id);
        connections.delete(id);
        await transport?.close();
      },
      async closeAll() {
        const all = [...connections.values()];
        connections.clear();
        await Promise.all(all.map((transport) => transport.close()));
      }
    };
  }

  // local-ui/renderer/deviceSetupTransport.ts
  var failure = (code) => Object.assign(new Error(code), { code });
  var object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  var identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
  var uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value
  );
  var responseTypes = /* @__PURE__ */ new Set([
    "device.info.result",
    "hello.result",
    "status.result",
    "pairing.start.result",
    "pairing.challenge.result",
    "pairing.token.result",
    "pairing.cancel.result",
    "wifi.scan.result",
    "wifi.apply.result",
    "job.status.result"
  ]);
  function frameBytes(value, max) {
    if (!Array.isArray(value) || !value.length || value.length > max || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
      throw failure("PROTOCOL_CHANGED");
    return Uint8Array.from(value);
  }
  function outputBytes(value, max) {
    if (!(value instanceof Uint8Array) || !value.length || value.length > max)
      throw failure("PROTOCOL_CHANGED");
    return Array.from(value);
  }
  function candidate(value) {
    if (!object(value) || Object.keys(value).length !== 8 || value.transport !== "ble-gatt" || !identifier(value.candidateId) || !identifier(value.transportHandle) || !identifier(value.selectionLeaseId) || typeof value.advertisedName !== "string" || value.advertisedName.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(value.advertisedName) || !(value.rssi === null || typeof value.rssi === "number" && Number.isFinite(value.rssi) && value.rssi <= 0) || typeof value.firstSeenMonotonicMs !== "number" || !Number.isFinite(value.firstSeenMonotonicMs) || value.firstSeenMonotonicMs < 0 || typeof value.lastSeenMonotonicMs !== "number" || !Number.isFinite(value.lastSeenMonotonicMs) || value.lastSeenMonotonicMs < value.firstSeenMonotonicMs)
      throw failure("INVALID_REQUEST");
    return { ...value };
  }
  function createDeviceSetupTransport(options) {
    const clock = options.clock ?? { monotonicMs: () => performance.now() };
    const makeSelection = () => (options.selectionFactory ?? createElectronBluetoothSelectionEndpoint)({
      bluetooth: options.bluetooth,
      clock
    });
    const makeEndpoint = (currentSelection) => options.endpointFactory ? options.endpointFactory(currentSelection, clock) : createElectronGattTransportEndpoint({
      factory: createElectronGattTransportFactory({
        consumeSelectionLease: (selected) => selection.consumeSelectionLease(selected),
        clock,
        // The SDK starts this deadline before writing every 12-byte GATT
        // fragment. Signed pairing tokens can take more than 5 seconds.
        requestTimeoutMs: 3e4
      })
    });
    let selection = makeSelection(), endpoint = makeEndpoint(selection);
    let epoch = 0, selectionEpoch = 0, disposed = false, disposing;
    let selectionCancel;
    let selectionSettled;
    const flights = /* @__PURE__ */ new Map();
    const subscriptions = /* @__PURE__ */ new Map();
    const abortFlights = (connectionId) => {
      for (const flight of flights.values())
        if (connectionId === void 0 || flight.connectionId === connectionId)
          flight.abort.abort();
    };
    const unsubscribeStatus = async (id) => {
      const unsubscribe2 = subscriptions.get(id);
      subscriptions.delete(id);
      await unsubscribe2?.();
    };
    function cancelSelection() {
      selectionCancel?.();
      ++selectionEpoch;
      selection.cancelSelection();
      selection = makeSelection();
      return selectionSettled ?? Promise.resolve();
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
    async function handle(input) {
      if (disposed || !object(input) || !identifier(input.requestId)) return;
      const requestId = input.requestId;
      if (flights.has(requestId)) return;
      const allowed = [
        "connect",
        "cancelConnect",
        "readDeviceInfo",
        "request",
        "subscribeStatus",
        "close",
        "closeAll"
      ];
      if (!allowed.includes(input.operation) || !Array.isArray(input.args) || input.args.length > 3 || Object.keys(input).some(
        (key) => !["requestId", "operation", "args"].includes(key)
      )) {
        options.bridge.reply({ requestId, ok: false, code: "INVALID_REQUEST" });
        return;
      }
      if (input.operation === "cancelConnect") {
        if (input.args.length !== 1 || !identifier(input.args[0])) {
          options.bridge.reply({ requestId, ok: false, code: "INVALID_REQUEST" });
          return;
        }
        const flight2 = flights.get(input.args[0]);
        if (flight2?.operation === "connect") flight2.abort.abort();
        options.bridge.reply({ requestId, ok: true });
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
          code: "RESOURCE_EXHAUSTED"
        });
        return;
      }
      const expected = epoch, current = endpoint, abort = new AbortController();
      const flight = { abort, operation: input.operation };
      flights.set(requestId, flight);
      const active = () => {
        if (disposed || epoch !== expected || abort.signal.aborted)
          throw failure("LOCAL_TRANSPORT_DISCONNECTED");
      };
      try {
        let value;
        if (input.operation === "connect") {
          if (input.args.length !== 1) throw failure("INVALID_REQUEST");
          const selected = candidate(input.args[0]);
          const id = await current.connect(selected, abort.signal);
          if (disposed || epoch !== expected || abort.signal.aborted) {
            await current.close(id).catch(() => void 0);
            active();
          }
          if (!identifier(id)) {
            await current.close(id).catch(() => void 0);
            throw failure("PROTOCOL_CHANGED");
          }
          value = id;
        } else {
          const id = input.args[0];
          if (!identifier(id) || input.args.length !== (input.operation === "request" ? 3 : 1))
            throw failure("INVALID_REQUEST");
          flight.connectionId = id;
          if (input.operation === "readDeviceInfo")
            value = outputBytes(
              await current.readDeviceInfo(id, abort.signal),
              512
            );
          else if (input.operation === "request") {
            const frame = frameBytes(input.args[1], 2048), match = input.args[2];
            if (!object(match) || Object.keys(match).length !== 2 || !uuid(match.requestId) || typeof match.responseMessageType !== "string" || !responseTypes.has(match.responseMessageType))
              throw failure("INVALID_REQUEST");
            value = outputBytes(
              await current.request(
                id,
                frame,
                {
                  requestId: match.requestId,
                  responseMessageType: match.responseMessageType
                },
                abort.signal
              ),
              2048
            );
          } else if (input.operation === "subscribeStatus") {
            await unsubscribeStatus(id);
            active();
            let subscribed = true;
            const unsubscribe2 = await current.subscribeStatus(
              id,
              (frame) => {
                if (!subscribed || disposed || epoch !== expected || abort.signal.aborted)
                  return;
                try {
                  options.bridge.status(id, outputBytes(frame, 2048));
                } catch {
                  abort.abort();
                  void current.close(id).catch(() => void 0);
                }
              },
              abort.signal
            );
            if (disposed || epoch !== expected || abort.signal.aborted) {
              await unsubscribe2();
              active();
            }
            subscriptions.set(id, async () => {
              subscribed = false;
              await unsubscribe2();
            });
          } else if (input.operation === "close") {
            abortFlights(id);
            await unsubscribeStatus(id);
            await current.close(id);
            value = void 0;
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
          ...value === void 0 ? {} : { value }
        });
      } catch (error) {
        if (!disposed) {
          const code = error?.code;
          const detail = error?.diagnostic;
          const nativeName = detail?.errorName ?? error?.name;
          const diagnostic = {
            ...["connect", "service", "characteristic", "notifications"].includes(detail?.stage ?? "") ? { stage: detail.stage } : {},
            errorName: [
              "NetworkError",
              "NotFoundError",
              "NotSupportedError",
              "InvalidStateError",
              "SecurityError",
              "AbortError",
              "TimeoutError",
              "LocalProvisioningFailure"
            ].includes(nativeName ?? "") ? nativeName : "UnknownError"
          };
          options.bridge.reply({
            requestId,
            ok: false,
            code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : "LOCAL_TRANSPORT_DISCONNECTED",
            ...detail || diagnostic.errorName !== "UnknownError" ? { diagnostic } : {}
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
      requestDeviceFromUserGesture() {
        if (disposed)
          return Promise.reject(failure("LOCAL_TRANSPORT_DISCONNECTED"));
        if (selectionSettled)
          return Promise.reject(failure("LOCAL_SELECTION_BUSY"));
        const expected = selectionEpoch, current = selection;
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error, selected) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (selectionCancel === cancel) selectionCancel = void 0;
            if (error) reject(error);
            else resolve(selected);
          };
          const cancel = () => finish(failure("LOCAL_SELECTION_LEASE_INVALID"));
          const timer = setTimeout(() => {
            finish(failure("LOCAL_SELECTION_TIMEOUT"));
            cancelSelection();
          }, options.selectionTimeoutMs ?? 12e3);
          selectionCancel = cancel;
          try {
            const completed = current.requestDeviceFromUserGesture().then(
              (selected) => {
                if (selectionSettled === completed) selectionSettled = void 0;
                if (disposed || expected !== selectionEpoch || settled) {
                  current.cancelSelection();
                  finish(failure("LOCAL_SELECTION_LEASE_INVALID"));
                  return;
                }
                finish(void 0, selected);
              },
              (error) => {
                if (selectionSettled === completed) selectionSettled = void 0;
                finish(error);
              }
            );
            selectionSettled = completed;
          } catch (error) {
            finish(error);
          }
        });
      },
      cancelSelection,
      dispose() {
        if (disposing) return disposing;
        disposed = true;
        unsubscribe();
        disposing = closeAll();
        return disposing;
      }
    };
  }

  // local-ui/renderer/bluetooth-availability.mjs
  function createBluetoothAvailability(bluetooth, readRadioState) {
    let state = { status: bluetooth?.getAvailability ? "checking" : "unsupported" };
    let generation = 0, disposed = false;
    const listeners = /* @__PURE__ */ new Set();
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
          readRadioState ? readRadioState() : Promise.resolve({ status: "available" })
        ]);
        if (expected === generation) publish(radio?.status === "permission-denied" ? "permission-denied" : !available ? "unavailable" : ["available", "unavailable", "unsupported", "error"].includes(radio?.status) ? radio.status : "error");
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
      snapshot,
      refresh,
      reportError,
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
      }
    };
  }

  // local-ui/renderer/device-setup-entry.ts
  var bluetoothAvailability = createBluetoothAvailability(
    navigator.bluetooth,
    window.wanxDiscovery?.bluetoothState ? () => window.wanxDiscovery.bluetoothState() : void 0
  );
  window.wanxBluetooth = bluetoothAvailability;
  void bluetoothAvailability.refresh();
  window.addEventListener?.("focus", () => {
    void bluetoothAvailability.refresh();
  });
  if (window.wanxSetupTransport && navigator.bluetooth) {
    const transport = createDeviceSetupTransport({
      bridge: window.wanxSetupTransport,
      bluetooth: navigator.bluetooth,
      selectionTimeoutMs: window.wanxSetupTransport.scanTimeoutMs
    });
    window.wanxDeviceSetupTransport = {
      requestDeviceFromUserGesture() {
        return transport.requestDeviceFromUserGesture().catch((error) => {
          bluetoothAvailability.reportError(error);
          throw error;
        });
      },
      cancelSelection: () => transport.cancelSelection(),
      dispose: () => transport.dispose()
    };
  }
})();
