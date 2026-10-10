import { request } from "../request";

export interface OctopTimezoneSettings {
  timezone: string;
}

export interface OctopUploadSettings {
  max_upload_mb: number;
  max_upload_bytes: number;
}

export interface OctopCapabilitiesSettings {
  mobile: { enabled: boolean; backend: string };
  server_version?: string;
  sdk_management?: {
    protocol_version: number;
    applications: boolean;
    remote_identity_registration: boolean;
  };
  permissions?: string[];
}

export interface CaptchaPairView {
  site_key: string;
  has_secret: boolean;
  cam_secret_id?: string;
  has_cam_secret?: boolean;
}

export interface CaptchaSettings {
  active: string;
  available: string[];
  providers: Record<string, CaptchaPairView>;
  source: "settings" | "env";
  v3_min_score: number;
}

export type CaptchaPairBody = {
  site_key?: string;
  secret?: string;
  cam_secret_id?: string;
  cam_secret?: string;
} | null;

export interface CaptchaSettingsPut {
  active?: string;
  providers?: Record<string, CaptchaPairBody>;
}

export const octopSettingsApi = {
  timezone: () => request<OctopTimezoneSettings>("/settings/timezone"),
  upload: () => request<OctopUploadSettings>("/settings/upload"),
  capabilities: (options?: RequestInit) =>
    request<OctopCapabilitiesSettings>("/settings/capabilities", {
      cache: "no-store",
      ...options,
    }),
  captcha: () => request<CaptchaSettings>("/settings/captcha"),
  putCaptcha: (body: CaptchaSettingsPut) =>
    request<CaptchaSettings>("/settings/captcha", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
