import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";

export async function writeApplicationZip(file, entries) {
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(file));
  for (const { name, body = "", mode = 0o100644 } of entries)
    zip.addBuffer(Buffer.from(body), name, { mode, compress: false });
  zip.end();
  await writing;
}
