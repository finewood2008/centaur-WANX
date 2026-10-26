import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";

export const MAX_CLIENT_BLOCKMAP_SIZE_BYTES = 16 * 1024 * 1024;

async function readBlockMap(file) {
  const sizeBytes = (await stat(file)).size;
  if (sizeBytes <= 0 || sizeBytes > MAX_CLIENT_BLOCKMAP_SIZE_BYTES)
    throw new Error("增量更新 blockmap 大小必须介于 1 字节与 16 MiB 之间。");
  const bytes = await readFile(file);
  return { bytes, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function createClientBlockMap(artifactPath) {
  const blockMapPath = `${artifactPath}.blockmap`;
  // An explicit output path keeps the already signed/notarized artifact unchanged.
  await buildBlockMap(artifactPath, "gzip", blockMapPath);
  const { sizeBytes, sha256 } = await readBlockMap(blockMapPath);
  return { path: blockMapPath, sizeBytes, sha256 };
}

export async function verifyClientBlockMap(report, artifactSizeBytes) {
  if (!report || typeof report.path !== "string" || !report.path ||
      !Number.isSafeInteger(report.sizeBytes) || report.sizeBytes <= 0 || report.sizeBytes > MAX_CLIENT_BLOCKMAP_SIZE_BYTES ||
      !/^[a-f0-9]{64}$/.test(report.sha256 || ""))
    throw new Error("增量更新 blockmap 验证报告无效。");
  const { bytes, sizeBytes, sha256 } = await readBlockMap(report.path);
  if (sizeBytes !== report.sizeBytes || sha256 !== report.sha256)
    throw new Error("增量更新 blockmap 与构建验证报告不一致。");
  let map;
  try { map = JSON.parse(gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })); }
  catch { throw new Error("增量更新 blockmap 必须为 gzip 压缩的 v2 块映射。"); }
  const file = map?.files?.[0];
  if (map?.version !== "2" || !Array.isArray(map.files) || map.files.length !== 1 ||
      file?.name !== "file" || file.offset !== 0 || !Array.isArray(file.sizes) || !Array.isArray(file.checksums) ||
      file.sizes.length !== file.checksums.length || !file.sizes.length ||
      file.sizes.some(size => !Number.isSafeInteger(size) || size <= 0) ||
      file.checksums.some(checksum => typeof checksum !== "string" || !/^[A-Za-z0-9+/]{24}$/.test(checksum)) ||
      file.sizes.reduce((sum, size) => sum + size, 0) !== artifactSizeBytes)
    throw new Error("增量更新 blockmap 必须完整覆盖最终更新制品的 v2 块映射。");
  return { sizeBytes, sha256 };
}
