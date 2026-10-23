import { open } from "node:fs/promises";

/** The renderer selects no path. Only a trusted native file picker can supply it. */
export async function readAvatar(file, nativeImage) {
  const handle = await open(file, "r");
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error("PROFILE_AVATAR_TOO_LARGE");
    bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("PROFILE_INVALID_AVATAR");
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error("PROFILE_INVALID_AVATAR");
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("PROFILE_INVALID_AVATAR");
  const { width, height } = image.getSize();
  if (width < 1 || height < 1 || width > 16384 || height > 16384) throw new Error("PROFILE_INVALID_AVATAR");
  const size = Math.min(width, height);
  const normalized = image.crop({ x: Math.floor((width - size) / 2), y: Math.floor((height - size) / 2), width: size, height: size })
    .resize({ width: 256, height: 256, quality: "best" }).toPNG();
  if (!normalized.length || normalized.length > 380000) throw new Error("PROFILE_INVALID_AVATAR");
  return `data:image/png;base64,${normalized.toString("base64")}`;
}
