using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;

// Read-only public display hints. Provisioning verifies the selected device separately.
internal static class Discovery
{
    private static readonly Guid ServiceId = new Guid("f6c7b7a0-5a0f-4b7f-9f3f-4d3f7b5a1000");
    private static readonly Guid DeviceInfoId = new Guid("f6c7b7a1-5a0f-4b7f-9f3f-4d3f7b5a1000");
    private static readonly Regex DeviceId = new Regex("^[A-Za-z0-9._-]{1,36}$", RegexOptions.CultureInvariant);
    private static readonly Regex Control = new Regex("[\u0000-\u001f\u007f-\u009f]");
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly object Gate = new object();
    private static readonly HashSet<ulong> Seen = new HashSet<ulong>();
    private static readonly HashSet<ulong> Known = new HashSet<ulong>();
    private static readonly HashSet<ulong> Services = new HashSet<ulong>();
    private static readonly Dictionary<ulong, string> Names = new Dictionary<ulong, string>();
    private static readonly SemaphoreSlim Probes = new SemaphoreSlim(3);
    private static int outputBytes;
    private static int outputRecords;
    private static bool stopped;
    private static bool diagnose;
    private static readonly Stopwatch Clock = Stopwatch.StartNew();

    private static void Report(ulong address, string stage, string outcome)
    {
        if (diagnose) Console.Error.WriteLine(Clock.ElapsedMilliseconds + "ms " + Address(address) + " " + stage + " " + outcome);
    }

    private static bool Name(string value)
    {
        return !String.IsNullOrEmpty(value) && value.Length <= 64 && !Control.IsMatch(value);
    }

    private static string Address(ulong value)
    {
        string hex = value.ToString("X12");
        return String.Join(":", Enumerable.Range(0, 6).Select(i => hex.Substring(i * 2, 2)));
    }

    private static void Emit(ulong address, string advertisedName, Dictionary<string, string> identity = null)
    {
        var value = new Dictionary<string, object> {
            { "deviceId", Address(address) },
            { "serviceUuid", ServiceId.ToString() },
            { "advertisedName", advertisedName },
        };
        if (identity != null) value.Add("displayIdentity", identity);
        string line = Json.Serialize(value);
        int length = Encoding.UTF8.GetByteCount(line) + 1;
        lock (Gate) {
            if (stopped || length > 2048 || outputRecords >= 256 || outputBytes + length > 65536) return;
            Console.WriteLine(line);
            outputRecords++;
            outputBytes += length;
        }
    }

    private static Dictionary<string, string> ParseIdentity(byte[] data)
    {
        if (data == null || data.Length == 0 || data.Length > 512) return null;
        Dictionary<string, object> value;
        try {
            value = Json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(data));
        } catch { return null; }
        object schema, protocol, profile, id, display;
        if (value == null || !value.TryGetValue("schema_version", out schema) || !Object.Equals(schema, 3) ||
            !value.TryGetValue("provisioning_protocol_version", out protocol) || !Object.Equals(protocol, 2) ||
            !value.TryGetValue("security_profile", out profile) || !Object.Equals(profile, "NEXUSAOS_LOCAL_AEAD_V2") ||
            !value.TryGetValue("device_id", out id) || !(id is string) || !DeviceId.IsMatch((string)id)) return null;
        var result = new Dictionary<string, string> { { "deviceId", (string)id } };
        if (value.TryGetValue("display_name", out display) && display is string && Name((string)display))
            result.Add("displayName", (string)display);
        return result;
    }

    private static async Task Probe(ulong address, BluetoothAddressType addressType, string advertisedName)
    {
        await Probes.WaitAsync();
        try {
            Dictionary<string, string> identity = null;
            using (var timeout = new CancellationTokenSource(25000))
            using (var device = await BluetoothLEDevice.FromBluetoothAddressAsync(address, addressType).AsTask(timeout.Token)) {
                if (device == null) { Report(address, "device", "missing"); return; }
                Report(address, "device", "opened");
                var services = await device.GetGattServicesForUuidAsync(ServiceId, BluetoothCacheMode.Cached).AsTask(timeout.Token);
                if (services.Status != GattCommunicationStatus.Success) { Report(address, "services", services.Status.ToString()); return; }
                Report(address, "services", services.Services.Count.ToString());
                foreach (var service in services.Services) {
                    using (service) {
                        var characteristics = await service.GetCharacteristicsForUuidAsync(DeviceInfoId, BluetoothCacheMode.Cached).AsTask(timeout.Token);
                        if (characteristics.Status != GattCommunicationStatus.Success) { Report(address, "characteristics", characteristics.Status.ToString()); continue; }
                        Report(address, "characteristics", characteristics.Characteristics.Count.ToString());
                        foreach (var characteristic in characteristics.Characteristics) {
                            if ((characteristic.CharacteristicProperties & GattCharacteristicProperties.Read) == 0) continue;
                            var read = await characteristic.ReadValueAsync(BluetoothCacheMode.Cached).AsTask(timeout.Token);
                            if (read.Status != GattCommunicationStatus.Success || ParseIdentity(read.Value.ToArray()) == null)
                                read = await characteristic.ReadValueAsync(BluetoothCacheMode.Uncached).AsTask(timeout.Token);
                            if (read.Status != GattCommunicationStatus.Success) { Report(address, "read", read.Status.ToString()); continue; }
                            identity = ParseIdentity(read.Value.ToArray());
                            Report(address, "identity", identity == null ? "invalid" : "valid");
                            if (identity != null) break;
                        }
                    }
                    if (identity != null) break;
                }
            }
            // Release GATT handles before the provisioning picker uses this box.
            if (identity != null) Emit(address, advertisedName, identity);
        } catch (Exception error) { Report(address, "probe", error.GetType().Name); }
        finally { Probes.Release(); }
    }

    private static void Received(BluetoothLEAdvertisementWatcher watcher, BluetoothLEAdvertisementReceivedEventArgs args)
    {
        string name;
        lock (Gate) {
            if (stopped) return;
            if (args.Advertisement.ServiceUuids.Contains(ServiceId) && Services.Count < 128)
                Services.Add(args.BluetoothAddress);
            var localName = args.Advertisement.LocalName;
            if (Name(localName) && (Names.ContainsKey(args.BluetoothAddress) || Names.Count < 256))
                Names[args.BluetoothAddress] = localName;
            if (!Services.Contains(args.BluetoothAddress) || !Names.TryGetValue(args.BluetoothAddress, out name) ||
                Seen.Contains(args.BluetoothAddress) || Seen.Count >= 128) return;
            Seen.Add(args.BluetoothAddress);
        }
        Emit(args.BluetoothAddress, name);
        Report(args.BluetoothAddress, "addressType", args.BluetoothAddressType.ToString());
        if (!Known.Contains(args.BluetoothAddress))
            Task.Run(() => Probe(args.BluetoothAddress, args.BluetoothAddressType, name));
    }

    private static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        diagnose = args.Length == 1 && args[0] == "--diagnose";
        if (args.Length == 1 && args[0] == "--self-test") {
            var valid = Encoding.UTF8.GetBytes("{\"schema_version\":3,\"provisioning_protocol_version\":2,\"security_profile\":\"NEXUSAOS_LOCAL_AEAD_V2\",\"device_id\":\"box-01\",\"display_name\":\"办公室盒子\"}");
            var parsed = ParseIdentity(valid);
            if (Address(0x1C7E51C73E8A) != "1C:7E:51:C7:3E:8A" || parsed == null ||
                parsed["deviceId"] != "box-01" || parsed["displayName"] != "办公室盒子" ||
                ParseIdentity(Encoding.UTF8.GetBytes("{\"schema_version\":2,\"device_id\":\"box-01\"}")) != null)
                throw new Exception("Discovery self-test failed");
            Console.WriteLine("OK");
            return;
        }
        foreach (var arg in args) {
            if (!arg.StartsWith("--known=", StringComparison.Ordinal)) continue;
            var address = arg.Substring(8);
            ulong known;
            if (Regex.IsMatch(address, "^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$") &&
                ulong.TryParse(address.Replace(":", ""), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out known))
                Known.Add(known);
        }
        var watcher = new BluetoothLEAdvertisementWatcher { ScanningMode = BluetoothLEScanningMode.Active };
        var handler = new Windows.Foundation.TypedEventHandler<BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementReceivedEventArgs>(Received);
        typeof(BluetoothLEAdvertisementWatcher).GetMethod("add_Received").Invoke(watcher, new object[] { handler });
        try {
            watcher.Start();
            Thread.Sleep(diagnose ? 30000 : 61000);
        } finally {
            watcher.Stop();
            lock (Gate) stopped = true;
        }
    }
}
