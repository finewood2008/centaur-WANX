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
    | "readDeviceInfo"
    | "request"
    | "subscribeStatus"
    | "close"
    | "closeAll";
  args: unknown[];
}
export interface SetupTransportBridge {
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
  cancelSelection(): void;
  dispose(): Promise<void>;
}

declare global {
  interface Window {
    wanxSetup?: SetupBridge;
    wanxSetupTransport?: SetupTransportBridge;
    wanxDeviceSetupTransport?: DeviceSetupTransport;
  }
}
