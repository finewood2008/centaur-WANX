import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Extend the pinned upstream SDK without changing its identity proof or AEAD
// profile. Every anchor is checked so an upstream change cannot silently drift.
export function patchWifiScan(directory, kind) {
  const edit = (name, from, to) => {
    const target = path.join(directory, 'dist', name);
    const source = readFileSync(target, 'utf8');
    if (source.split(from).length !== 2) throw Error(`Wi-Fi SDK anchor mismatch: ${name}: ${from}`);
    writeFileSync(target, source.replace(from, to));
  };
  if (kind === 'contracts') {
    edit('index.d.ts', 'export type SecureRequestType = "wifi.apply"', 'export type SecureRequestType = "wifi.scan" | "wifi.apply"');
    return;
  }
  edit('index.d.ts', 'messageType: "wifi.apply" |', 'messageType: "wifi.scan" | "wifi.apply" |');
  edit('coordinator.d.ts', '    provideWifi(input: {', `    /** Scan nearby networks using the authenticated box's Wi-Fi adapter. */
    scanWifi(signal?: AbortSignal): Promise<Array<{ ssid: string; signal: number; security: "open" | "wpa_personal" | "unsupported" }>>;
    provideWifi(input: {`);
  edit('index.js', '    if (messageType === "wifi.apply.result") {', `    if (messageType === "wifi.scan.result") {
        exact(payload, ["scan_state", "networks", "next_offset"]);
        if (!["scanning", "ready"].includes(payload.scan_state) ||
            !Array.isArray(payload.networks) || payload.networks.length > 6 ||
            !(payload.next_offset === null || (Number.isSafeInteger(payload.next_offset) && payload.next_offset >= 1 && payload.next_offset <= 60)))
            fail();
        if (payload.scan_state === "scanning" && (payload.networks.length !== 0 || payload.next_offset !== null))
            fail();
        for (const network of payload.networks) {
            if (!record(network)) fail();
            exact(network, ["ssid", "signal", "security"]);
            if (typeof network.ssid !== "string" || network.ssid.length === 0 ||
                new TextEncoder().encode(network.ssid).length > 32 ||
                /[\\u0000-\\u001f\\u007f-\\u009f\\ud800-\\udfff]/u.test(network.ssid) ||
                !Number.isSafeInteger(network.signal) || network.signal < 0 || network.signal > 100 ||
                !["open", "wpa_personal", "unsupported"].includes(network.security))
                fail();
        }
    }
    else if (messageType === "wifi.apply.result") {`);
  edit('index.js', '["status.result", "pairing.cancel.result"].includes(messageType)', '["wifi.scan.result", "status.result", "pairing.cancel.result"].includes(messageType)');
  edit('index.js', '                else if (messageType === "status")', `                else if (messageType === "wifi.scan") {
                    exact(payload, ["offset", "refresh"]);
                    if (!Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset > 60 ||
                        typeof payload.refresh !== "boolean" || (payload.refresh && payload.offset !== 0))
                        fail();
                }
                else if (messageType === "status")`);
  edit('coordinator.js', '    if (error.code === "unsupported_network_security")', `    if (error.code === "wifi_scan_failed")
        return new ClaimCoordinatorFailure("WIFI_SCAN_FAILED", true);
    if (error.code === "wifi_unavailable")
        return new ClaimCoordinatorFailure("WIFI_UNAVAILABLE", true);
    if (error.code === "unsupported_network_security")`);
  edit('coordinator.js', '        provideWifi(input) {', `        scanWifi(caller = new AbortController().signal) {
            return run("scanWifi", {}, caller, async (operationSignal) => {
                if (snapshot.state !== "awaitingWifi")
                    throw new ClaimCoordinatorFailure("CLAIM_INVALID_STATE", false);
                const timeout = new AbortController();
                const timeoutTimer = setTimeout(() => timeout.abort(), 20000);
                const signal = AbortSignal.any([operationSignal, timeout.signal]);
                const deadline = deps.clock.monotonicMs() + 20000;
                const networks = [];
                let offset = 0, refresh = true;
                try {
                for (;;) {
                    ensureActive(signal);
                    if (deps.clock.monotonicMs() >= deadline)
                        throw new ClaimCoordinatorFailure("WIFI_SCAN_TIMEOUT", true);
                    const page = await secure("wifi.scan", { offset, refresh }, signal);
                    refresh = false;
                    if (deps.clock.monotonicMs() >= deadline)
                        throw new ClaimCoordinatorFailure("WIFI_SCAN_TIMEOUT", true);
                    if (page.scan_state === "scanning") {
                        if (offset !== 0)
                            throw new ClaimCoordinatorFailure("PROTOCOL_CHANGED", false);
                        await new Promise((resolve, reject) => {
                            const abort = () => { clearTimeout(timer); reject(aborted()); };
                            const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 700);
                            signal.addEventListener("abort", abort, { once: true });
                            if (signal.aborted) abort();
                        });
                        continue;
                    }
                    networks.push(...page.networks);
                    if (networks.length > 60 ||
                        (page.next_offset !== null && (page.networks.length === 0 || page.next_offset !== offset + page.networks.length || page.next_offset >= 60)))
                        throw new ClaimCoordinatorFailure("PROTOCOL_CHANGED", false);
                    if (page.next_offset === null)
                        return networks;
                    offset = page.next_offset;
                }
                } catch (error) {
                    if (timeout.signal.aborted && !operationSignal.aborted)
                        throw new ClaimCoordinatorFailure("WIFI_SCAN_TIMEOUT", true);
                    throw error;
                } finally {
                    clearTimeout(timeoutTimer);
                }
            });
        },
        provideWifi(input) {`);
}
