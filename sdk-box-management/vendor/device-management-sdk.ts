import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export const CONSUMER_SIGNATURE_VERSION = "NEXUSAOS-CONSUMER-V1" as const;

export interface DeviceManagementStorage {
  get(key: string): unknown;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface DeviceManagementRequest {
  url: string;
  method?: string;
  data?: unknown;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface DeviceManagementResponse {
  statusCode: number;
  data: unknown;
  headers?: Readonly<Record<string, string | readonly string[]>>;
}

export type DeviceManagementRequestFn = (
  request: DeviceManagementRequest,
) => Promise<DeviceManagementResponse>;

export interface DeviceManagementKeyAdapter {
  generate(keyAlias: string): Promise<{ publicKey: string }>;
  getPublicKey(keyAlias: string): Promise<string | undefined>;
  sign(keyAlias: string, payload: Uint8Array): Promise<string>;
}

export interface ConsumerSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
  readonly clientId: string;
  readonly expiresIn?: number;
}

export interface ConsumerClientRegistration {
  readonly clientId: string;
  readonly clientPublicKey: string;
  readonly platform: "android" | "ios" | "h5" | "harmony" | "macos" | "windows" | "linux" | "unknown";
  readonly deviceModel?: string;
  readonly displayName?: string;
}

export interface ConsumerClientView {
  readonly clientId: string;
  readonly platform: string;
  readonly deviceModel?: string;
  readonly displayName?: string;
  readonly status: string;
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastSeenAt?: string;
  readonly revokedAt?: string;
}

export interface ConsumerDeviceView {
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly role: "owner";
  readonly scopes: string[];
  readonly ownershipEpoch: number;
  readonly status: string;
  readonly online: boolean;
  readonly lastHeartbeat?: string;
  readonly remoteGatewayLastSeen?: string;
  readonly currentVersion?: string;
  readonly currentSecurityVersion?: number;
  readonly updateAvailable?: boolean;
  readonly updateBlockReason?: string;
}

export interface ConsumerOwnershipTransferView {
  readonly transferId: string;
  readonly deviceId: string;
  readonly state: string;
  readonly direction: "incoming" | "outgoing";
  readonly retainData: boolean;
  readonly ownershipEpoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt?: string;
}

export interface ConsumerSupportSessionView {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly scopes: string[];
  readonly reason: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

export interface ConsumerFactoryResetResult {
  readonly commandId: string;
  readonly deviceId: string;
  readonly status: string;
  readonly ownershipEpoch: number;
  readonly expiresAt: string;
}

export interface ConsumerFactoryResetV2Request {
  readonly clientAttemptId: string;
  readonly ownerPhone: string;
  readonly verificationCode: string;
  readonly confirmation: "ERASE";
  readonly scopeManifestSha256: string;
  readonly handoffGeneration: number;
}

export interface ConsumerFactoryResetV2Result {
  readonly resetId: string;
  readonly deviceId: string;
  readonly state: string;
  readonly targetEpoch: number;
  readonly handoffGeneration: number;
  readonly scopeManifestSha256: string;
  readonly authorizationUpdateId: string;
  readonly expiresAt: string;
  readonly reclaimable: boolean;
  readonly handoffId?: string;
  readonly markerSha256?: string;
  readonly permit?: unknown;
}

export interface ConsumerOtaUpdateView {
  readonly updateId: string;
  readonly deviceId: string;
  readonly releaseId: string;
  readonly status: string;
  readonly securityVersion: number;
  readonly currentVersion?: string;
  readonly targetVersion?: string;
  readonly progressPercent?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly updatedAt?: string;
}

export interface ConsumerOtaAvailableRelease {
  readonly releaseId: string;
  readonly version: string;
  readonly securityVersion: number;
  readonly target: string;
  readonly targetArch: string;
  readonly hardwareProfile: string;
  readonly publishedAt?: string;
}

export interface ConsumerOtaStatus {
  readonly updates: ConsumerOtaUpdateView[];
  readonly availableRelease?: ConsumerOtaAvailableRelease;
  readonly device?: {
    readonly deviceId: string;
    readonly component: string;
    readonly currentVersion?: string;
    readonly currentSecurityVersion?: number;
    readonly availableVersion?: string;
    readonly availableSecurityVersion?: number;
    readonly updateAvailable?: boolean;
    readonly blockReason?: string;
  };
}

export interface ConsumerClientIdentity {
  readonly clientId: string;
  readonly keyAlias: string;
  readonly publicKey: string;
}

export type ConsumerSmsScene = "consumer_login" | "consumer_register" | "consumer_reset_password";

export interface DeviceManagementClient {
  sendSmsCode(phone: string, scene?: ConsumerSmsScene): Promise<{ expiresIn: number; debugCode?: string }>;
  loginWithSms(phone: string, code: string, client: ConsumerClientRegistration): Promise<ConsumerSession>;
  refresh(): Promise<ConsumerSession>;
  logout(): Promise<void>;
  getClients(): Promise<ConsumerClientView[]>;
  revokeClient(clientId: string): Promise<void>;
  getDevices(): Promise<ConsumerDeviceView[]>;
  getOtaStatus(deviceId: string): Promise<ConsumerOtaStatus>;
  requestOta(deviceId: string, payload: {
    releaseId: string;
    currentVersion?: string;
    currentSecurityVersion?: number;
    idempotencyKey?: string;
  }): Promise<ConsumerOtaUpdateView>;
  createOwnershipTransfer(deviceId: string, payload: {
    ownerPhone: string;
    verificationCode: string;
    targetPhone: string;
    retainData: boolean;
  }): Promise<ConsumerOwnershipTransferView>;
  getOwnershipTransfers(): Promise<ConsumerOwnershipTransferView[]>;
  acceptOwnershipTransfer(transferId: string): Promise<ConsumerOwnershipTransferView>;
  requestFactoryReset(deviceId: string, payload: {
    ownerPhone: string;
    verificationCode: string;
    confirmation: "ERASE";
  }): Promise<ConsumerFactoryResetResult>;
  requestFactoryResetV2(deviceId: string, payload: ConsumerFactoryResetV2Request): Promise<ConsumerFactoryResetV2Result>;
  createSupportSession(deviceId: string, payload: {
    scopes: Array<"support.logs" | "support.ssh" | "support.vnc">;
    reason: string;
    durationMinutes: number;
  }): Promise<ConsumerSupportSessionView>;
  getSupportSessions(deviceId: string): Promise<ConsumerSupportSessionView[]>;
  revokeSupportSession(deviceId: string, sessionId: string): Promise<void>;
}

export interface CreateDeviceManagementOptions {
  readonly baseUrl: string;
  readonly request: DeviceManagementRequestFn;
  readonly storage: DeviceManagementStorage;
  /** Required only for protected calls; SMS send/login and refresh can work without it. */
  readonly keyAdapter?: DeviceManagementKeyAdapter;
  /** Serializes rotating refresh tokens across clients sharing one account session. */
  readonly refreshCoordinator?: (
    refresh: () => Promise<ConsumerSession>,
  ) => Promise<ConsumerSession>;
  /** Called after this client invalidates the persisted account session. */
  readonly onSessionCleared?: () => void;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export const DEVICE_MANAGEMENT_STORAGE_KEYS = Object.freeze({
  accessToken: "nexusConsumerAccessToken",
  refreshToken: "nexusConsumerRefreshToken",
  accountId: "nexusConsumerAccountId",
  clientId: "nexusConsumerClientId",
  identity: "nexusConsumerClientIdentity",
});

export function loadConsumerSession(storage: Pick<DeviceManagementStorage, "get">): ConsumerSession | undefined {
  const accessToken = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.accessToken));
  const refreshToken = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.refreshToken));
  const accountId = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.accountId));
  const clientId = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.clientId));
  if (!accessToken || !refreshToken || !accountId || !clientId) return undefined;
  return { accessToken, refreshToken, accountId, clientId };
}

export function saveConsumerSession(session: ConsumerSession, storage: DeviceManagementStorage): void {
  requireNonEmpty(session.accessToken, "accessToken");
  requireNonEmpty(session.refreshToken, "refreshToken");
  requireNonEmpty(session.accountId, "accountId");
  requireNonEmpty(session.clientId, "clientId");
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.accessToken, session.accessToken);
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.refreshToken, session.refreshToken);
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.accountId, session.accountId);
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.clientId, session.clientId);
}

export function clearConsumerSession(storage: DeviceManagementStorage): void {
  for (const key of [
    DEVICE_MANAGEMENT_STORAGE_KEYS.accessToken,
    DEVICE_MANAGEMENT_STORAGE_KEYS.refreshToken,
    DEVICE_MANAGEMENT_STORAGE_KEYS.accountId,
    DEVICE_MANAGEMENT_STORAGE_KEYS.clientId,
  ]) storage.remove(key);
}

export async function loadOrCreateClientIdentity(options: {
  storage: DeviceManagementStorage;
  keyAdapter: DeviceManagementKeyAdapter;
  randomId?: () => string;
}): Promise<ConsumerClientIdentity> {
  const existing = parseIdentity(options.storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.identity));
  if (existing) {
    const publicKey = await options.keyAdapter.getPublicKey(existing.keyAlias);
    if (publicKey === existing.publicKey) return existing;
    options.storage.remove(DEVICE_MANAGEMENT_STORAGE_KEYS.identity);
  }
  const clientId = (options.randomId ?? secureRandomId)();
  const keyAlias = `nexusaos.consumer.${clientId}`;
  const generated = await options.keyAdapter.generate(keyAlias);
  requireNonEmpty(generated.publicKey, "publicKey");
  const identity = { clientId, keyAlias, publicKey: generated.publicKey.trim() };
  options.storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.identity, JSON.stringify(identity));
  return identity;
}

export function createUniDeviceManagementClient(options: CreateDeviceManagementOptions): DeviceManagementClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  let refreshFlight: Promise<ConsumerSession> | undefined;

  function discardSession(): void {
    clearConsumerSession(options.storage);
    options.onSessionCleared?.();
  }

  async function request(path: string, method: string, data?: unknown): Promise<DeviceManagementResponse> {
    return options.request({
      url: `${baseUrl}${path}`,
      method,
      ...(data === undefined ? {} : { data }),
    });
  }

  async function refreshSession(): Promise<ConsumerSession> {
    const current = loadConsumerSession(options.storage);
    if (!current) throw new Error("请先登录 NexusAOS 账号");
    const response = await request("/app-api/auth/refresh", "POST", { refreshToken: current.refreshToken });
    if (isUnauthorized(response)) {
      discardSession();
      throw new Error(extractMessage(response) ?? "登录已过期，请重新登录");
    }
    const body = unwrapBody<ConsumerSession>(response, "登录已过期，请重新登录");
    saveConsumerSession(body, options.storage);
    return body;
  }

  function coordinatedRefresh(): Promise<ConsumerSession> {
    if (refreshFlight) return refreshFlight;
    const started = Promise.resolve().then(() => options.refreshCoordinator
      ? options.refreshCoordinator(refreshSession)
      : refreshSession());
    const tracked = started.finally(() => {
      if (refreshFlight === tracked) refreshFlight = undefined;
    });
    refreshFlight = tracked;
    return tracked;
  }

  async function signed(path: string, method: string, data?: unknown): Promise<DeviceManagementRequest> {
    const session = loadConsumerSession(options.storage);
    const identity = parseIdentity(options.storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.identity));
    if (!options.keyAdapter) throw new Error("客户端安全密钥不可用");
    if (!session || !identity || identity.clientId !== session.clientId) {
      throw new Error("请重新登录 NexusAOS 账号");
    }
    const body = data === undefined ? "" : stableStringify(data);
    const bodyHash = sha256Hex(body);
    const timestamp = String(Math.floor((options.now ?? Date.now)() / 1000));
    const nonce = (options.randomId ?? secureRandomId)();
    const canonical = [CONSUMER_SIGNATURE_VERSION, session.accountId, session.clientId,
      method.toUpperCase(), path, timestamp, nonce, bodyHash].join("\n");
    const signature = await options.keyAdapter.sign(identity.keyAlias, utf8Bytes(canonical));
    return {
      url: `${baseUrl}${path}`,
      method,
      ...(body ? { data: body } : {}),
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Nexus-Client-Id": session.clientId,
        "X-Nexus-Timestamp": timestamp,
        "X-Nexus-Nonce": nonce,
        "X-Nexus-Body-SHA256": bodyHash,
        "X-Nexus-Signature": signature,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    };
  }

  async function protectedCall<T>(path: string, method: string, data?: unknown,
    extraHeaders: Readonly<Record<string, string>> = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestOptions = await signed(path, method, data);
      requestOptions.headers = { ...requestOptions.headers, ...extraHeaders };
      const response = await options.request(requestOptions);
      if (attempt === 0 && isUnauthorized(response)) {
        await coordinatedRefresh();
        continue;
      }
      return unwrapBody<T>(response, `C端服务请求失败：${response.statusCode}`);
    }
    throw new Error("登录已过期，请重新登录");
  }

  return {
    async sendSmsCode(phone, scene = "consumer_login") {
      return unwrapBody(await request("/app-api/auth/sms/send", "POST", { phone, scene }), "验证码发送失败");
    },
    async loginWithSms(phone, code, client) {
      const session = unwrapBody<ConsumerSession>(
        await request("/app-api/auth/sms/login", "POST", { phone, code, ...client }),
        "登录失败",
      );
      saveConsumerSession(session, options.storage);
      return session;
    },
    refresh: coordinatedRefresh,
    async logout() {
      const current = loadConsumerSession(options.storage);
      if (!current) return;
      try {
        const requestOptions = await signed("/app-api/auth/logout", "POST", { refreshToken: current.refreshToken });
        await options.request(requestOptions);
      } finally {
        discardSession();
      }
    },
    getClients: () => protectedCall("/app-api/auth/clients", "GET"),
    async revokeClient(clientId) {
      await protectedCall(`/app-api/auth/clients/${encodeURIComponent(clientId)}`, "DELETE");
      const current = loadConsumerSession(options.storage);
      if (current?.clientId === clientId) discardSession();
    },
    getDevices: () => protectedCall("/app-api/devices", "GET"),
    async getOtaStatus(deviceId) {
      const value = await protectedCall<ConsumerOtaStatus | ConsumerOtaUpdateView[]>(`/app-api/devices/${encodeURIComponent(deviceId)}/ota`, "GET");
      return Array.isArray(value) ? { updates: value } : value;
    },
    requestOta(deviceId, payload) {
      const idempotencyKey = payload.idempotencyKey ?? `${(options.randomId ?? secureRandomId)()}`;
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/ota`, "POST", {
        releaseId: payload.releaseId,
        idempotencyKey,
        currentSecurityVersion: payload.currentSecurityVersion ?? 0,
        ...(payload.currentVersion ? { currentVersion: payload.currentVersion } : {}),
      });
    },
    createOwnershipTransfer(deviceId, payload) {
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/ownership/transfer`, "POST", payload);
    },
    getOwnershipTransfers: () => protectedCall("/app-api/ownership/transfers", "GET"),
    acceptOwnershipTransfer: transferId => protectedCall(`/app-api/ownership/transfers/${encodeURIComponent(transferId)}/accept`, "POST"),
    requestFactoryReset(deviceId, payload) {
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/factory-reset`, "POST", payload);
    },
    requestFactoryResetV2(deviceId, payload) {
      assertFactoryResetV2Request(payload);
      return protectedCall(
        `/app-api/devices/${encodeURIComponent(deviceId)}/factory-reset-v2`,
        "POST",
        payload,
        { "Idempotency-Key": payload.clientAttemptId },
      );
    },
    createSupportSession(deviceId, payload) {
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/support-sessions`, "POST", payload);
    },
    getSupportSessions: deviceId => protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/support-sessions`, "GET"),
    revokeSupportSession: async (deviceId, sessionId) => {
      await protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/support-sessions/${encodeURIComponent(sessionId)}`, "DELETE");
    },
  };
}

function unwrapBody<T>(response: DeviceManagementResponse, fallback: string): T {
  const body = asRecord(response.data);
  if (response.statusCode < 200 || response.statusCode >= 300 || body?.success === false) {
    throw new Error(typeof body?.msg === "string" ? body.msg : fallback);
  }
  return (body && "data" in body ? body.data : response.data) as T;
}

function extractMessage(response: DeviceManagementResponse): string | undefined {
  const body = asRecord(response.data);
  return typeof body?.msg === "string" && body.msg.trim() ? body.msg : undefined;
}

function isUnauthorized(response: DeviceManagementResponse): boolean {
  const body = asRecord(response.data);
  return response.statusCode === 401 || body?.code === 401;
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function isConsumerFactoryResetV2AttemptId(value: unknown): value is string {
  return typeof value === "string" && UUID4.test(value);
}

export function isConsumerFactoryResetV2Sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

export function assertFactoryResetV2Request(payload: ConsumerFactoryResetV2Request): void {
  const keys = Object.keys(payload as object).sort();
  const expected = [
    "clientAttemptId", "confirmation", "handoffGeneration", "ownerPhone",
    "scopeManifestSha256", "verificationCode",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("重置请求字段不完整或包含未知字段");
  }
  if (!isConsumerFactoryResetV2AttemptId(payload.clientAttemptId)) {
    throw new Error("clientAttemptId 必须是小写 UUID4");
  }
  if (!/^1\d{10}$/.test(payload.ownerPhone)) {
    throw new Error("ownerPhone 格式无效");
  }
  if (!/^\d{6}$/.test(payload.verificationCode)) {
    throw new Error("verificationCode 格式无效");
  }
  if (payload.confirmation !== "ERASE") {
    throw new Error("confirmation 必须为 ERASE");
  }
  if (!isConsumerFactoryResetV2Sha256(payload.scopeManifestSha256)) {
    throw new Error("scopeManifestSha256 必须是 64 位小写 SHA-256");
  }
  if (!Number.isSafeInteger(payload.handoffGeneration) || payload.handoffGeneration < 2) {
    throw new Error("handoffGeneration 必须是大于等于 2 的安全整数");
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8Bytes(value)));
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const second = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (second - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
}

function secureRandomId(): string {
  const values = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error("当前环境不支持安全随机数");
  globalThis.crypto.getRandomValues(values);
  values[6] = (values[6]! & 0x0f) | 0x40;
  values[8] = (values[8]! & 0x3f) | 0x80;
  const hex = Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseIdentity(value: unknown): ConsumerClientIdentity | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ConsumerClientIdentity>;
    if (typeof parsed.clientId === "string" && parsed.clientId && typeof parsed.keyAlias === "string" &&
        parsed.keyAlias && typeof parsed.publicKey === "string" && parsed.publicKey) return parsed as ConsumerClientIdentity;
  } catch { /* malformed storage is treated as absent */ }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`设备管理字段无效：${field}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
