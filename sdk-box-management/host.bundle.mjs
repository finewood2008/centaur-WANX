// host.mjs
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

// node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => (
  // @ts-ignore
  typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
))();
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes(bytes);
  if (hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
var Hash = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}

// node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE);
  const _32n = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE ? 4 : 0;
  const l = isLE ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE);
  view.setUint32(byteOffset + l, wl, isLE);
}
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class extends Hash {
  constructor(blockLen, outputLen, padOffset, isLE) {
    super();
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    clean(this.buffer.subarray(pos));
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// node_modules/@noble/hashes/esm/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor(outputLen = 32) {
    super(64, outputLen, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var sha256 = /* @__PURE__ */ createHasher(() => new SHA256());

// node_modules/@noble/hashes/esm/sha256.js
var sha2562 = sha256;

// vendor/device-management-sdk.ts
var CONSUMER_SIGNATURE_VERSION = "NEXUSAOS-CONSUMER-V1";
var DEVICE_MANAGEMENT_STORAGE_KEYS = Object.freeze({
  accessToken: "nexusConsumerAccessToken",
  refreshToken: "nexusConsumerRefreshToken",
  accountId: "nexusConsumerAccountId",
  clientId: "nexusConsumerClientId",
  identity: "nexusConsumerClientIdentity"
});
function loadConsumerSession(storage) {
  const accessToken = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.accessToken));
  const refreshToken = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.refreshToken));
  const accountId = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.accountId));
  const clientId = readString(storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.clientId));
  if (!accessToken || !refreshToken || !accountId || !clientId) return void 0;
  return { accessToken, refreshToken, accountId, clientId };
}
function saveConsumerSession(session, storage) {
  requireNonEmpty(session.accessToken, "accessToken");
  requireNonEmpty(session.refreshToken, "refreshToken");
  requireNonEmpty(session.accountId, "accountId");
  requireNonEmpty(session.clientId, "clientId");
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.accessToken, session.accessToken);
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.refreshToken, session.refreshToken);
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.accountId, session.accountId);
  storage.set(DEVICE_MANAGEMENT_STORAGE_KEYS.clientId, session.clientId);
}
function clearConsumerSession(storage) {
  for (const key of [
    DEVICE_MANAGEMENT_STORAGE_KEYS.accessToken,
    DEVICE_MANAGEMENT_STORAGE_KEYS.refreshToken,
    DEVICE_MANAGEMENT_STORAGE_KEYS.accountId,
    DEVICE_MANAGEMENT_STORAGE_KEYS.clientId
  ]) storage.remove(key);
}
async function loadOrCreateClientIdentity(options) {
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
function createUniDeviceManagementClient(options) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  let refreshFlight;
  function discardSession() {
    clearConsumerSession(options.storage);
    options.onSessionCleared?.();
  }
  async function request(path, method, data) {
    return options.request({
      url: `${baseUrl}${path}`,
      method,
      ...data === void 0 ? {} : { data }
    });
  }
  async function refreshSession() {
    const current = loadConsumerSession(options.storage);
    if (!current) throw new Error("\u8BF7\u5148\u767B\u5F55 NexusAOS \u8D26\u53F7");
    const response = await request("/app-api/auth/refresh", "POST", { refreshToken: current.refreshToken });
    if (isUnauthorized(response)) {
      discardSession();
      throw new Error(extractMessage(response) ?? "\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    const body = unwrapBody(response, "\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    saveConsumerSession(body, options.storage);
    return body;
  }
  function coordinatedRefresh() {
    if (refreshFlight) return refreshFlight;
    const started = Promise.resolve().then(() => options.refreshCoordinator ? options.refreshCoordinator(refreshSession) : refreshSession());
    const tracked = started.finally(() => {
      if (refreshFlight === tracked) refreshFlight = void 0;
    });
    refreshFlight = tracked;
    return tracked;
  }
  async function signed(path, method, data) {
    const session = loadConsumerSession(options.storage);
    const identity = parseIdentity(options.storage.get(DEVICE_MANAGEMENT_STORAGE_KEYS.identity));
    if (!options.keyAdapter) throw new Error("\u5BA2\u6237\u7AEF\u5B89\u5168\u5BC6\u94A5\u4E0D\u53EF\u7528");
    if (!session || !identity || identity.clientId !== session.clientId) {
      throw new Error("\u8BF7\u91CD\u65B0\u767B\u5F55 NexusAOS \u8D26\u53F7");
    }
    const body = data === void 0 ? "" : stableStringify(data);
    const bodyHash = sha256Hex(body);
    const timestamp = String(Math.floor((options.now ?? Date.now)() / 1e3));
    const nonce = (options.randomId ?? secureRandomId)();
    const canonical = [
      CONSUMER_SIGNATURE_VERSION,
      session.accountId,
      session.clientId,
      method.toUpperCase(),
      path,
      timestamp,
      nonce,
      bodyHash
    ].join("\n");
    const signature = await options.keyAdapter.sign(identity.keyAlias, utf8Bytes(canonical));
    return {
      url: `${baseUrl}${path}`,
      method,
      ...body ? { data: body } : {},
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "X-Nexus-Client-Id": session.clientId,
        "X-Nexus-Timestamp": timestamp,
        "X-Nexus-Nonce": nonce,
        "X-Nexus-Body-SHA256": bodyHash,
        "X-Nexus-Signature": signature,
        ...body ? { "Content-Type": "application/json" } : {}
      }
    };
  }
  async function protectedCall(path, method, data, extraHeaders = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestOptions = await signed(path, method, data);
      requestOptions.headers = { ...requestOptions.headers, ...extraHeaders };
      const response = await options.request(requestOptions);
      if (attempt === 0 && isUnauthorized(response)) {
        await coordinatedRefresh();
        continue;
      }
      return unwrapBody(response, `C\u7AEF\u670D\u52A1\u8BF7\u6C42\u5931\u8D25\uFF1A${response.statusCode}`);
    }
    throw new Error("\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
  }
  return {
    async sendSmsCode(phone2, scene = "consumer_login") {
      return unwrapBody(await request("/app-api/auth/sms/send", "POST", { phone: phone2, scene }), "\u9A8C\u8BC1\u7801\u53D1\u9001\u5931\u8D25");
    },
    async loginWithSms(phone2, code2, client) {
      const session = unwrapBody(
        await request("/app-api/auth/sms/login", "POST", { phone: phone2, code: code2, ...client }),
        "\u767B\u5F55\u5931\u8D25"
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
      const value = await protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/ota`, "GET");
      return Array.isArray(value) ? { updates: value } : value;
    },
    requestOta(deviceId, payload) {
      const idempotencyKey = payload.idempotencyKey ?? `${(options.randomId ?? secureRandomId)()}`;
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/ota`, "POST", {
        releaseId: payload.releaseId,
        idempotencyKey,
        currentSecurityVersion: payload.currentSecurityVersion ?? 0,
        ...payload.currentVersion ? { currentVersion: payload.currentVersion } : {}
      });
    },
    createOwnershipTransfer(deviceId, payload) {
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/ownership/transfer`, "POST", payload);
    },
    getOwnershipTransfers: () => protectedCall("/app-api/ownership/transfers", "GET"),
    acceptOwnershipTransfer: (transferId) => protectedCall(`/app-api/ownership/transfers/${encodeURIComponent(transferId)}/accept`, "POST"),
    requestFactoryReset(deviceId, payload) {
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/factory-reset`, "POST", payload);
    },
    requestFactoryResetV2(deviceId, payload) {
      assertFactoryResetV2Request(payload);
      return protectedCall(
        `/app-api/devices/${encodeURIComponent(deviceId)}/factory-reset-v2`,
        "POST",
        payload,
        { "Idempotency-Key": payload.clientAttemptId }
      );
    },
    createSupportSession(deviceId, payload) {
      return protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/support-sessions`, "POST", payload);
    },
    getSupportSessions: (deviceId) => protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/support-sessions`, "GET"),
    revokeSupportSession: async (deviceId, sessionId) => {
      await protectedCall(`/app-api/devices/${encodeURIComponent(deviceId)}/support-sessions/${encodeURIComponent(sessionId)}`, "DELETE");
    }
  };
}
function unwrapBody(response, fallback) {
  const body = asRecord(response.data);
  if (response.statusCode < 200 || response.statusCode >= 300 || body?.success === false) {
    throw new Error(typeof body?.msg === "string" ? body.msg : fallback);
  }
  return body && "data" in body ? body.data : response.data;
}
function extractMessage(response) {
  const body = asRecord(response.data);
  return typeof body?.msg === "string" && body.msg.trim() ? body.msg : void 0;
}
function isUnauthorized(response) {
  const body = asRecord(response.data);
  return response.statusCode === 401 || body?.code === 401;
}
var UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var SHA2562 = /^[0-9a-f]{64}$/;
function isConsumerFactoryResetV2AttemptId(value) {
  return typeof value === "string" && UUID4.test(value);
}
function isConsumerFactoryResetV2Sha256(value) {
  return typeof value === "string" && SHA2562.test(value);
}
function assertFactoryResetV2Request(payload) {
  const keys = Object.keys(payload).sort();
  const expected = [
    "clientAttemptId",
    "confirmation",
    "handoffGeneration",
    "ownerPhone",
    "scopeManifestSha256",
    "verificationCode"
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("\u91CD\u7F6E\u8BF7\u6C42\u5B57\u6BB5\u4E0D\u5B8C\u6574\u6216\u5305\u542B\u672A\u77E5\u5B57\u6BB5");
  }
  if (!isConsumerFactoryResetV2AttemptId(payload.clientAttemptId)) {
    throw new Error("clientAttemptId \u5FC5\u987B\u662F\u5C0F\u5199 UUID4");
  }
  if (!/^1\d{10}$/.test(payload.ownerPhone)) {
    throw new Error("ownerPhone \u683C\u5F0F\u65E0\u6548");
  }
  if (!/^\d{6}$/.test(payload.verificationCode)) {
    throw new Error("verificationCode \u683C\u5F0F\u65E0\u6548");
  }
  if (payload.confirmation !== "ERASE") {
    throw new Error("confirmation \u5FC5\u987B\u4E3A ERASE");
  }
  if (!isConsumerFactoryResetV2Sha256(payload.scopeManifestSha256)) {
    throw new Error("scopeManifestSha256 \u5FC5\u987B\u662F 64 \u4F4D\u5C0F\u5199 SHA-256");
  }
  if (!Number.isSafeInteger(payload.handoffGeneration) || payload.handoffGeneration < 2) {
    throw new Error("handoffGeneration \u5FC5\u987B\u662F\u5927\u4E8E\u7B49\u4E8E 2 \u7684\u5B89\u5168\u6574\u6570");
  }
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function sha256Hex(value) {
  return bytesToHex(sha2562(utf8Bytes(value)));
}
function utf8Bytes(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 55296 && codePoint <= 56319) {
      const second = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (second >= 56320 && second <= 57343) {
        codePoint = 65536 + (codePoint - 55296 << 10) + (second - 56320);
        index += 1;
      } else {
        codePoint = 65533;
      }
    } else if (codePoint >= 56320 && codePoint <= 57343) {
      codePoint = 65533;
    }
    if (codePoint <= 127) {
      bytes.push(codePoint);
    } else if (codePoint <= 2047) {
      bytes.push(192 | codePoint >> 6, 128 | codePoint & 63);
    } else if (codePoint <= 65535) {
      bytes.push(224 | codePoint >> 12, 128 | codePoint >> 6 & 63, 128 | codePoint & 63);
    } else {
      bytes.push(
        240 | codePoint >> 18,
        128 | codePoint >> 12 & 63,
        128 | codePoint >> 6 & 63,
        128 | codePoint & 63
      );
    }
  }
  return Uint8Array.from(bytes);
}
function secureRandomId() {
  const values = new Uint8Array(16);
  if (!globalThis.crypto?.getRandomValues) throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u5B89\u5168\u968F\u673A\u6570");
  globalThis.crypto.getRandomValues(values);
  values[6] = values[6] & 15 | 64;
  values[8] = values[8] & 63 | 128;
  const hex = Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function parseIdentity(value) {
  if (typeof value !== "string") return void 0;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed.clientId === "string" && parsed.clientId && typeof parsed.keyAlias === "string" && parsed.keyAlias && typeof parsed.publicKey === "string" && parsed.publicKey) return parsed;
  } catch {
  }
  return void 0;
}
function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function requireNonEmpty(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`\u8BBE\u5907\u7BA1\u7406\u5B57\u6BB5\u65E0\u6548\uFF1A${field}`);
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}

// host.mjs
var actions = ["state", "account.sendSMS", "account.login", "account.logout", "devices.list", "ota.status", "ota.request", "transfers.list", "transfers.create", "transfers.accept", "support.list", "support.create", "support.revoke", "clients.list", "clients.revoke", "factory.reset"];
var fields = {
  device: ["deviceId", "deviceName", "role", "scopes", "ownershipEpoch", "status", "online", "lastHeartbeat", "currentVersion", "currentSecurityVersion", "updateAvailable", "updateBlockReason"],
  client: ["clientId", "platform", "deviceModel", "displayName", "status", "current", "createdAt", "lastSeenAt", "revokedAt"],
  transfer: ["transferId", "deviceId", "state", "direction", "retainData", "ownershipEpoch", "createdAt", "expiresAt", "completedAt"],
  support: ["sessionId", "deviceId", "scopes", "reason", "status", "createdAt", "expiresAt", "revokedAt"],
  update: ["updateId", "deviceId", "releaseId", "status", "securityVersion", "currentVersion", "targetVersion", "progressPercent", "errorCode", "updatedAt"],
  release: ["releaseId", "version", "securityVersion", "target", "targetArch", "hardwareProfile", "publishedAt"],
  otaDevice: ["deviceId", "component", "currentVersion", "currentSecurityVersion", "availableVersion", "availableSecurityVersion", "updateAvailable", "blockReason"],
  reset: ["commandId", "deviceId", "status", "ownershipEpoch", "expiresAt"]
};
var pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== void 0).map((key) => [key, value[key]]));
var list = (value, keys) => {
  if (!Array.isArray(value)) throw new Error("INVALID_PLATFORM_RESPONSE");
  return value.map((item) => pick(item, keys));
};
var text = (input, key, max = 200) => {
  if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > max) throw new Error("INVALID_INPUT");
  return input[key].trim();
};
var phone = (input, key) => {
  const value = text(input, key, 11);
  if (!/^1\d{10}$/.test(value)) throw new Error("INVALID_INPUT");
  return value;
};
var code = (input) => {
  const value = text(input, "verificationCode", 6);
  if (!/^\d{6}$/.test(value)) throw new Error("INVALID_INPUT");
  return value;
};
var confirmed = (input) => {
  if (input.confirmed !== true) throw new Error("CONFIRMATION_REQUIRED");
};
function createBoxManagementHost({ baseURL, request, allowLoopback = false } = {}) {
  const base = new URL(baseURL || "https://boss.nexusaos.qitus.cn/prod-api");
  if (base.username || base.password || base.search || base.hash || base.protocol !== "https:" && !(allowLoopback && base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) throw new Error("INVALID_PLATFORM_URL");
  const users = /* @__PURE__ */ new Map();
  async function network(options) {
    if (request) return request(options);
    const url = new URL(options.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, "") + "/app-api/")) throw new Error("INVALID_PLATFORM_URL");
    const response = await fetch(url, { method: options.method, headers: { "Content-Type": "application/json", ...options.headers }, ...options.data === void 0 ? {} : { body: typeof options.data === "string" ? options.data : JSON.stringify(options.data) }, redirect: "error", signal: AbortSignal.timeout(15e3) });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return { statusCode: response.status, data: body ? JSON.parse(body) : {} };
  }
  function context(actor) {
    if (!Number.isSafeInteger(actor) || actor < 1) throw new Error("INVALID_ACTOR");
    if (users.has(actor)) return users.get(actor);
    const values = /* @__PURE__ */ new Map(), keys = /* @__PURE__ */ new Map();
    const storage = { get: (key) => values.get(key), set: (key, value) => values.set(key, value), remove: (key) => values.delete(key) };
    const keyAdapter = {
      async generate(alias) {
        const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        keys.set(alias, pair);
        return { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
      },
      async getPublicKey(alias) {
        return keys.get(alias)?.publicKey.export({ type: "spki", format: "pem" }).toString();
      },
      async sign(alias, payload) {
        if (!keys.has(alias)) throw new Error("KEY_UNAVAILABLE");
        return sign("sha256", payload, keys.get(alias).privateKey).toString("base64");
      }
    };
    const sdk = createUniDeviceManagementClient({ baseUrl: base.href, request: network, storage, keyAdapter });
    const ctx = { sdk, storage, keyAdapter, tail: Promise.resolve(), lastUsed: Date.now() };
    users.set(actor, ctx);
    return ctx;
  }
  async function run(ctx, action, input) {
    const sdk = ctx.sdk;
    if (action === "state") {
      const session = loadConsumerSession(ctx.storage);
      return { configured: true, sdkVersion: "1.0.1", identity: session ? { accountId: session.accountId, clientId: session.clientId } : null };
    }
    if (action === "account.sendSMS") {
      const result = await sdk.sendSmsCode(phone(input, "phone"));
      return { expiresIn: result.expiresIn };
    }
    if (action === "account.login") {
      const identity = await loadOrCreateClientIdentity({ storage: ctx.storage, keyAdapter: ctx.keyAdapter });
      const session = await sdk.loginWithSms(phone(input, "phone"), code(input), { clientId: identity.clientId, clientPublicKey: identity.publicKey, platform: "unknown", deviceModel: "WANX Server", displayName: "WANX Box Management" });
      if (session.clientId !== identity.clientId) {
        clearConsumerSession(ctx.storage);
        throw new Error("INVALID_PLATFORM_RESPONSE");
      }
      return run(ctx, "state", {});
    }
    if (action === "account.logout") {
      await sdk.logout();
      return { identity: null };
    }
    if (!loadConsumerSession(ctx.storage)) throw new Error("LOGIN_REQUIRED");
    if (action === "devices.list") return list(await sdk.getDevices(), fields.device);
    if (action === "clients.list") return list(await sdk.getClients(), fields.client);
    if (action === "clients.revoke") {
      confirmed(input);
      await sdk.revokeClient(text(input, "clientId"));
      return {};
    }
    if (action === "transfers.list") return list(await sdk.getOwnershipTransfers(), fields.transfer);
    if (action === "transfers.accept") {
      confirmed(input);
      const transferId = text(input, "transferId");
      const rows = await sdk.getOwnershipTransfers();
      if (!rows.some((row) => row.transferId === transferId && row.direction === "incoming" && !row.completedAt)) throw new Error("DEVICE_NOT_AUTHORIZED");
      return pick(await sdk.acceptOwnershipTransfer(transferId), fields.transfer);
    }
    if (action === "transfers.create") confirmed(input);
    const deviceId = text(input, "deviceId");
    const devices = await sdk.getDevices();
    const device = devices.find((item) => item.deviceId === deviceId && item.role === "owner");
    if (!device) throw new Error("DEVICE_NOT_AUTHORIZED");
    if (action === "transfers.create") {
      confirmed(input);
      return pick(await sdk.createOwnershipTransfer(text(input, "deviceId"), { ownerPhone: phone(input, "ownerPhone"), verificationCode: code(input), targetPhone: phone(input, "targetPhone"), retainData: input.retainData === true }), fields.transfer);
    }
    if (action === "ota.status") {
      const result = await sdk.getOtaStatus(deviceId);
      return { updates: list(result.updates, fields.update), ...result.availableRelease ? { availableRelease: pick(result.availableRelease, fields.release) } : {}, ...result.device ? { device: pick(result.device, fields.otaDevice) } : {} };
    }
    if (action === "ota.request") {
      confirmed(input);
      const status = await sdk.getOtaStatus(deviceId);
      if (!device.online || !status.availableRelease || status.device?.blockReason) throw new Error("UPDATE_UNAVAILABLE");
      return pick(await sdk.requestOta(deviceId, { releaseId: status.availableRelease.releaseId, currentVersion: device.currentVersion, currentSecurityVersion: device.currentSecurityVersion, idempotencyKey: randomUUID() }), fields.update);
    }
    if (action === "support.list") return list(await sdk.getSupportSessions(deviceId), fields.support);
    if (action === "support.create") {
      confirmed(input);
      const scopes = input.scopes;
      if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !["support.logs", "support.ssh", "support.vnc"].includes(s))) throw new Error("INVALID_INPUT");
      if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 120) throw new Error("INVALID_INPUT");
      return pick(await sdk.createSupportSession(deviceId, { scopes, reason: text(input, "reason", 500), durationMinutes: input.durationMinutes }), fields.support);
    }
    if (action === "support.revoke") {
      confirmed(input);
      await sdk.revokeSupportSession(deviceId, text(input, "sessionId"));
      return {};
    }
    if (action === "factory.reset") {
      confirmed(input);
      if (input.confirmation !== "ERASE") throw new Error("CONFIRMATION_REQUIRED");
      return pick(await sdk.requestFactoryReset(deviceId, { ownerPhone: phone(input, "ownerPhone"), verificationCode: code(input), confirmation: "ERASE" }), fields.reset);
    }
    throw new Error("UNKNOWN_ACTION");
  }
  return {
    async action(actor, action, input = {}) {
      if (!actions.includes(action)) throw new Error("UNKNOWN_ACTION");
      const ctx = context(actor);
      const next = ctx.tail.then(() => run(ctx, action, { ...input, actor }));
      ctx.tail = next.catch(() => {
      });
      ctx.lastUsed = Date.now();
      return next;
    },
    close() {
      users.clear();
    }
  };
}
export {
  actions,
  createBoxManagementHost
};
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)
*/
