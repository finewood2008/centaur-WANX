import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";
import { TEST_APP_ID, TEST_PRODUCT_NAME, TEST_EXTENSION, isTestClientIdentity } from "../updates/test-build.mjs";
import { canonicalJSON, secureURL, verifyRelease } from "../updates/contracts.mjs";

export async function signClientRelease({ reportPath, artifactURL, keyId, privateKeyPath, releaseId,
  metadataSequence, supportedOsVersions, compatibleApplications, expiresAt, outputPath, channel, testOnly = false, now = Date.now() }) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const windows = report.platform === "windows";
  const testIdentity = { ...report.build, packaged: true };
  const verifiedPlatform = windows ? report.authenticodeVerified === true && typeof report.publisherName === "string" && report.publisherName &&
    report.build?.installationScope === "per-user" && report.updateArtifact?.kind === "nsis" :
    report.platform === "macos" && (testOnly || report.notarized === true && report.updateArtifact?.notarized === true) && report.updateArtifact?.kind === "mac-zip";
  const verifiedSource = testOnly
    ? isTestClientIdentity(testIdentity) && report.appId === TEST_APP_ID && report.name === TEST_PRODUCT_NAME &&
      /^[a-f0-9]{64}$/.test(report.build?.sourceSnapshot || "") && Boolean(semver.prerelease(report.version))
    : report.build?.sourceDirty === false && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(report.build?.sourceCommit || "");
  const distributionClass = testOnly ? "test-only" : "formal";
  if (report.distributionClass !== distributionClass || report.signed !== true || !verifiedPlatform ||
      report.build?.distributionClass !== distributionClass || !verifiedSource ||
      !["arm64", "x64"].includes(report.arch) || semver.valid(report.version) !== report.version)
    throw new Error(testOnly ? "只接受隔离测试包的真实系统签名与源码快照验证报告。" : "只接受已完成系统签名验证且包含构建身份的正式 macOS 或 Windows 客户端验证报告。");
  const releaseChannel = channel ?? report.build.channel;
  if (typeof releaseChannel !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(releaseChannel))
    throw new Error("发行渠道无效。");
  if (testOnly && releaseChannel !== testIdentity.channel)
    throw new Error("隔离测试发行只能使用构建报告中的专用测试渠道。");
  const artifact = report.updateArtifact;
  const sha256 = createHash("sha256"), sha512 = createHash("sha512");
  for await (const chunk of createReadStream(artifact.path)) { sha256.update(chunk); sha512.update(chunk); }
  const digest = sha256.digest("hex"), strongDigest = sha512.digest("base64");
  const sizeBytes = (await stat(artifact.path)).size;
  if (digest !== artifact.sha256 || strongDigest !== artifact.sha512 || sizeBytes !== artifact.sizeBytes)
    throw new Error("更新制品与构建验证报告不一致。");
  secureURL(artifactURL);
  if (!Array.isArray(supportedOsVersions) || !supportedOsVersions.length || supportedOsVersions.some(value => typeof value !== "string" || !value))
    throw new Error("必须明确列出经过验证的 os.release() 系统版本。");
  if (!Array.isArray(compatibleApplications) || compatibleApplications.some(rule => typeof rule.applicationId !== "string" ||
      !/^[a-z][a-z0-9._-]{1,63}$/.test(rule.applicationId) || !semver.validRange(rule.versionRange)) ||
      new Set(compatibleApplications.map(rule => rule.applicationId)).size !== compatibleApplications.length)
    throw new Error("应用兼容表无效。");
  const key = createPrivateKey(await readFile(privateKeyPath, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("发行签名必须使用单独的 Ed25519 密钥。");
  const signerFingerprint = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
  if (!Object.hasOwn(report.updateTrust || {}, keyId) || report.updateTrust[keyId] !== signerFingerprint)
    throw new Error("发行签名密钥不在安装包已验证的更新信任根中，请检查 key-id 与公钥配置。");
  const payload = { schemaVersion: 1, purpose: "wanx.release.v1", releaseId, product: "wanx-client", version: report.version,
    buildId: report.build.buildId, metadataSequence, securityEpoch: report.build.securityEpoch, channel: releaseChannel,
    ...(testOnly ? { sourceSnapshot: report.build.sourceSnapshot,
      testIsolation: { applicationId: TEST_APP_ID, testRunId: report.build.testRunId } } :
      { sourceCommits: { "wanx-client": { "centuarai-wanx": report.build.sourceCommit } } }),
    platform: { os: windows ? "win32" : "darwin", arch: report.arch, osVersion: supportedOsVersions[0] }, supportedOsVersions,
    backendContract: 1, hostProtocol: 1, dataPolicy: "backward-compatible", requiredExtensions: testOnly ? [TEST_EXTENSION] : [], compatibleApplications,
    components: { "wanx-client": { version: report.version, sha256: digest } },
    artifacts: [{ component: "wanx-client", url: artifactURL, sha256: digest, sha512: strongDigest, sizeBytes, kind: windows ? "nsis" : "mac-zip" }],
    createdAt: new Date(now).toISOString(), expiresAt };
  const envelope = { payload, signature: { algorithm: "ed25519", keyId,
    signatureBase64: sign(null, Buffer.from(canonicalJSON(payload)), key).toString("base64") } };
  verifyRelease(envelope, { product: "wanx-client", now, testIdentity: testOnly ? testIdentity : undefined, keys: { [keyId]: createPublicKey(key).export({ type: "spki", format: "pem" }) } });
  await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { releaseId, version: report.version, outputPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { "test-only": { type: "boolean" }, ...Object.fromEntries(["report", "url", "key-id", "private-key", "release-id", "sequence", "support", "expires-at", "out", "channel"].map(key => [key, { type: "string" }])) } });
    const support = JSON.parse(await readFile(values.support, "utf8"));
    const result = await signClientRelease({ reportPath: values.report, artifactURL: values.url, keyId: values["key-id"],
      privateKeyPath: values["private-key"], releaseId: values["release-id"], metadataSequence: Number(values.sequence),
      supportedOsVersions: support.supportedOsVersions, compatibleApplications: support.compatibleApplications,
      expiresAt: values["expires-at"], outputPath: values.out, channel: values.channel, testOnly: values["test-only"] === true });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
}
