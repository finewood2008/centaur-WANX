import type { ClaimCoordinatorSnapshot } from "@nexusaos/local-provisioning-core";
import type { SelectedDiscoveryCandidate } from "@nexusaos/local-provisioning-contracts";

export type SetupSnapshot = ClaimCoordinatorSnapshot;
export interface SetupBridge {
  state(): Promise<SetupSnapshot>;
  begin(candidate: SelectedDiscoveryCandidate): Promise<SetupSnapshot>;
  resume(input?: { deviceId?: string; pairingSessionId?: string }): Promise<SetupSnapshot>;
  redeemClaimCode?(code: string): Promise<{
    deviceId: string;
    authorizationState: string;
  }>;
  confirmPhysical(): Promise<SetupSnapshot>;
  scanWifi(): Promise<Array<{
    ssid: string;
    signal: number;
    security: "open" | "wpa_personal" | "unsupported";
  }>>;
  wifi(input: {
    ssid: string;
    security: "open" | "wpa_personal";
    password?: string;
    hidden: boolean;
  }): Promise<SetupSnapshot>;
  confirmOwnership(): Promise<SetupSnapshot>;
  refresh(): Promise<SetupSnapshot>;
  cancel(): Promise<SetupSnapshot>;
  reset(): Promise<SetupSnapshot>;
  subscribe(listener: (snapshot: SetupSnapshot) => void): () => void;
}
export interface SetupTransportRequest {
  requestId: string;
  operation:
    | "connect"
    | "cancelConnect"
    | "readDeviceInfo"
    | "request"
    | "subscribeStatus"
    | "close"
    | "closeAll";
  args: unknown[];
}
export interface SetupTransportBridge {
  scanTimeoutMs?: number;
  subscribe(listener: (request: SetupTransportRequest) => void): () => void;
  reply(result: {
    requestId: string;
    ok: boolean;
    value?: unknown;
    code?: string;
  }): void;
  status(connectionId: string, frame: number[]): void;
}

export interface DeviceSetupTransport {
  requestDeviceFromUserGesture(): Promise<SelectedDiscoveryCandidate>;
  cancelSelection(): Promise<void>;
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    wanxDiscovery?: {
      bluetoothState(): Promise<{ status: string }>;
    };
    wanxBluetooth?: {
      snapshot(): { status: "checking" | "available" | "unavailable" | "permission-denied" | "unsupported" | "error" };
      refresh(): Promise<{ status: string }>;
      reportError(error: unknown): void;
      subscribe(listener: (state: { status: string }) => void): () => void;
    };
    wanxSetup?: SetupBridge;
    wanxSetupTransport?: SetupTransportBridge;
    wanxDeviceSetupTransport?: DeviceSetupTransport;
  }
}
