import CoreBluetooth
import Darwin
import Foundation

private let serviceId = "f6c7b7a0-5a0f-4b7f-9f3f-4d3f7b5a1000"
private let deviceInfoId = "f6c7b7a1-5a0f-4b7f-9f3f-4d3f7b5a1000"

private func displayName(_ value: Any?) -> String? {
    guard let value = value as? String,
          !value.isEmpty, value.utf16.count <= 64,
          !value.unicodeScalars.contains(where: {
              $0.value <= 0x1f || (0x7f ... 0x9f).contains($0.value)
          })
    else { return nil }
    return value
}

// Public, unverified display hints only. Provisioning verifies the selected box
// separately; no other deviceInfo fields leave this process.
private func displayIdentity(_ data: Data) -> [String: String]? {
    guard !data.isEmpty, data.count <= 512,
          let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          value["schema_version"] as? Int == 3,
          value["provisioning_protocol_version"] as? Int == 2,
          value["security_profile"] as? String == "NEXUSAOS_LOCAL_AEAD_V2",
          let deviceId = value["device_id"] as? String,
          (1 ... 36).contains(deviceId.utf8.count),
          deviceId.utf8.allSatisfy({
              (65 ... 90).contains($0) || (97 ... 122).contains($0) ||
                  (48 ... 57).contains($0) || [45, 46, 95].contains($0)
          })
    else { return nil }
    var identity = ["deviceId": deviceId]
    if let name = displayName(value["display_name"]) {
        identity["displayName"] = name
    }
    return identity
}

private final class DiscoveredBox {
    let peripheral: CBPeripheral
    var advertisedName: String?
    var identity: [String: String]?
    var lastOutput: Data?
    var disconnecting = false
    var reading = false
    var attempts = 0
    var timeout: DispatchWorkItem?
    var timeoutGeneration = 0

    init(_ peripheral: CBPeripheral) { self.peripheral = peripheral }
}

// The only GATT operation is reading the fixed, public deviceInfo characteristic.
// No pairing, configuration, notification subscription or characteristic write.
private final class BoxDiscovery: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager!
    private var boxes: [UUID: DiscoveredBox] = [:]
    private var pending: [UUID] = []
    private var active = Set<UUID>()
    private var signals: [DispatchSourceSignal] = []
    private var outputBytes = 0
    private var outputRecords = 0
    private var finished = false

    override init() {
        super.init()
        // A stopped scan must also close any read-only connections in progress.
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.finish() }
            source.resume()
            signals.append(source)
        }
        signal(SIGPIPE, SIG_IGN)
        central = CBCentralManager(delegate: self, queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 29.5) { self.finish() }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard !finished else { return }
        switch central.state {
        case .poweredOn:
            central.scanForPeripherals(
                withServices: [CBUUID(string: serviceId)],
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
            )
        case .poweredOff, .unauthorized, .unsupported:
            finish()
        case .unknown, .resetting:
            break
        @unknown default:
            finish()
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard !finished,
              let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID],
              services.contains(CBUUID(string: serviceId))
        else { return }

        let id = peripheral.identifier
        let box: DiscoveredBox
        if let existing = boxes[id] {
            box = existing
        } else {
            guard boxes.count < 128 else { return }
            box = DiscoveredBox(peripheral)
            boxes[id] = box
            pending.append(id)
        }
        if let name = displayName(advertisementData[CBAdvertisementDataLocalNameKey]) {
            box.advertisedName = name
        } else if box.advertisedName == nil, let name = displayName(peripheral.name) {
            box.advertisedName = name
        }
        emit(box)
        connectNext()
    }

    private func connectNext() {
        guard !finished, central.state == .poweredOn else { return }
        while active.count < 3, !pending.isEmpty {
            let id = pending.removeFirst()
            guard let box = boxes[id] else { continue }
            box.attempts += 1
            box.disconnecting = false
            box.reading = false
            active.insert(id)
            box.peripheral.delegate = self
            armTimeout(box, seconds: 5)
            central.connect(box.peripheral)
        }
    }

    private func armTimeout(_ box: DiscoveredBox, seconds: Double) {
        box.timeout?.cancel()
        box.timeoutGeneration += 1
        let generation = box.timeoutGeneration
        let id = box.peripheral.identifier
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, let current = self.boxes[id],
                  current.timeoutGeneration == generation else { return }
            self.disconnect(id)
        }
        box.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: timeout)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard !finished, let box = boxes[peripheral.identifier],
              active.contains(peripheral.identifier), !box.disconnecting
        else {
            central.cancelPeripheralConnection(peripheral)
            return
        }
        // Connection establishment can consume several seconds by itself.
        // Give service discovery and the public read their own bounded budget;
        // the scan-wide deadline still bounds the entire operation.
        armTimeout(box, seconds: 3)
        peripheral.discoverServices([CBUUID(string: serviceId)])
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard canRead(peripheral) else { return }
        guard error == nil,
              let service = peripheral.services?.first(where: { $0.uuid == CBUUID(string: serviceId) })
        else { disconnect(peripheral.identifier); return }
        peripheral.discoverCharacteristics([CBUUID(string: deviceInfoId)], for: service)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        guard canRead(peripheral), service.uuid == CBUUID(string: serviceId) else { return }
        guard error == nil,
              let characteristic = service.characteristics?.first(where: {
                  $0.uuid == CBUUID(string: deviceInfoId) && $0.properties.contains(.read)
              })
        else { disconnect(peripheral.identifier); return }
        boxes[peripheral.identifier]?.reading = true
        peripheral.readValue(for: characteristic)
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard canRead(peripheral), let box = boxes[peripheral.identifier], box.reading,
              characteristic.uuid == CBUUID(string: deviceInfoId),
              characteristic.service?.uuid == CBUUID(string: serviceId)
        else { return }
        box.reading = false
        if error == nil, let data = characteristic.value, let identity = displayIdentity(data) {
            box.identity = identity
            emit(box)
        }
        disconnect(peripheral.identifier)
    }

    private func canRead(_ peripheral: CBPeripheral) -> Bool {
        !finished && active.contains(peripheral.identifier) &&
            boxes[peripheral.identifier]?.disconnecting == false
    }

    private func disconnect(_ id: UUID) {
        guard active.contains(id), let box = boxes[id], !box.disconnecting else { return }
        box.disconnecting = true
        box.timeout?.cancel()
        box.timeout = nil
        central.cancelPeripheralConnection(box.peripheral)
        // Keep this slot occupied until CoreBluetooth confirms disconnection.
    }

    private func disconnected(_ peripheral: CBPeripheral) {
        guard active.remove(peripheral.identifier) != nil else { return }
        boxes[peripheral.identifier]?.timeout?.cancel()
        boxes[peripheral.identifier]?.timeout = nil
        peripheral.delegate = nil
        // Transient connection failures must not leave a visible box unnamed
        // for the whole scan. Give unseen boxes their first attempt before retrying.
        if !finished, let box = boxes[peripheral.identifier],
           box.identity == nil, box.attempts < 2 {
            pending.append(peripheral.identifier)
        }
        connectNext()
    }

    func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) { disconnected(peripheral) }

    func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) { disconnected(peripheral) }

    private func emit(_ box: DiscoveredBox) {
        guard !finished, let name = box.advertisedName ?? box.identity?["deviceId"] else { return }
        var value: [String: Any] = [
            "peripheralId": box.peripheral.identifier.uuidString.uppercased(),
            "serviceUuid": serviceId,
            "advertisedName": name,
        ]
        if let identity = box.identity { value["displayIdentity"] = identity }
        guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              data.count <= 2048, data != box.lastOutput else { return }
        guard outputRecords < 256, outputBytes + data.count + 1 <= 65536 else {
            finish()
            return
        }
        box.lastOutput = data
        data.append(0x0a)
        outputBytes += data.count
        outputRecords += 1
        do { try FileHandle.standardOutput.write(contentsOf: data) }
        catch { finish() }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        central.stopScan()
        pending.removeAll()
        for id in active {
            guard let box = boxes[id] else { continue }
            box.timeout?.cancel()
            box.peripheral.delegate = nil
            central.cancelPeripheralConnection(box.peripheral)
        }
        // Briefly drain cancellation requests; the helper still exits before
        // the SDK's 30-second scan deadline.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
    }
}

private let scanner = BoxDiscovery()
RunLoop.main.run()
