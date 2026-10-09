import { request } from "../request";
export type {
  ConsumerDeviceView,
  ConsumerClientView,
  ConsumerOwnershipTransferView,
  ConsumerSupportSessionView,
  ConsumerOtaStatus,
} from "../../../../sdk-box-management/vendor/device-management-sdk";
export interface BoxManagementState {
  configured: boolean;
  sdkVersion: string;
  identity: { accountId: string; clientId: string } | null;
}
export type BoxManagementAction =
  | "state"
  | "account.sendSMS"
  | "account.login"
  | "account.logout"
  | "devices.list"
  | "ota.status"
  | "ota.request"
  | "transfers.list"
  | "transfers.create"
  | "transfers.accept"
  | "support.list"
  | "support.create"
  | "support.revoke"
  | "clients.list"
  | "clients.revoke"
  | "factory.reset";
export function boxManagementAction<T>(
  action: BoxManagementAction,
  input: Record<string, unknown> = {},
) {
  return request<T>("/box-management/action", {
    method: "POST",
    body: JSON.stringify({ action, input }),
  });
}
