import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const runFile = promisify(execFile);
// Read-only WinRT radio enumeration. Never request access or change radio state.
const WINDOWS_RADIOS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation') } | Select-Object -First 1
try {
  $operation = [Windows.Devices.Radios.Radio]::GetRadiosAsync()
  $task = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @($operation))
  $radios = $task.GetAwaiter().GetResult()
  $states = @($radios | Where-Object { $_.Kind.ToString() -eq 'Bluetooth' } | ForEach-Object { $_.State.ToString() })
  ConvertTo-Json -InputObject @{ states = $states } -Compress
} catch [System.UnauthorizedAccessException] {
  '{"permissionDenied":true}'
}
`;

export function macBluetoothState(value) {
  const radios = value?.SPBluetoothDataType;
  if (!Array.isArray(radios)) return { status: "error" };
  const states = radios.map(radio => radio?.controller_properties?.controller_state).filter(Boolean);
  if (states.includes("attrib_on")) return { status: "available" };
  if (states.includes("attrib_off")) return { status: "unavailable", reason: "powered-off" };
  return { status: "unavailable", reason: "adapter-unavailable" };
}
export function windowsBluetoothState(value) {
  if (value?.permissionDenied === true) return { status: "permission-denied" };
  if (!Array.isArray(value?.states)) return { status: "error" };
  if (value.states.includes("On")) return { status: "available" };
  if (value.states.some(state => state === "Off" || state === "Disabled"))
    return { status: "unavailable", reason: "powered-off" };
  // Empty enumeration can also indicate OS/driver limitations, not missing hardware.
  return value.states.length ? { status: "error" } : { status: "unavailable", reason: "adapter-unavailable" };
}
export async function readBluetoothState({ platform = process.platform, exec = runFile, env = process.env } = {}) {
  const options = { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" };
  try {
    if (platform === "darwin") {
      const { stdout } = await exec("/usr/sbin/system_profiler", ["SPBluetoothDataType", "-json"], options);
      return macBluetoothState(JSON.parse(stdout));
    }
    if (platform === "win32") {
      const powershell = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(WINDOWS_RADIOS, "utf16le").toString("base64")], options);
      return windowsBluetoothState(JSON.parse(stdout.replace(/^\uFEFF/, "")));
    }
  } catch { return { status: "error" }; }
  return { status: "unsupported" };
}
