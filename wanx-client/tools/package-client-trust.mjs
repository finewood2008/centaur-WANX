import { createHash, createPublicKey } from "node:crypto";

export function validateClientTrust(trust) {
  try {
    if (trust?.schemaVersion !== 1 || !trust.keys || typeof trust.keys !== "object" || Array.isArray(trust.keys) ||
        !Object.keys(trust.keys).length) throw new Error();
    for (const [id, pem] of Object.entries(trust.keys)) {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || typeof pem !== "string" || pem.includes("PRIVATE KEY") ||
          createPublicKey(pem).asymmetricKeyType !== "ed25519") throw new Error();
    }
  } catch {
    throw new Error("生产信任文件必须包含有效的 Ed25519 公钥映射，不能包含私钥。");
  }
  return trust;
}

export function clientTrustFingerprints(trust) {
  validateClientTrust(trust);
  return Object.fromEntries(Object.entries(trust.keys).map(([id, pem]) => [id,
    createHash("sha256").update(createPublicKey(pem).export({ type: "spki", format: "der" })).digest("hex") ]));
}
