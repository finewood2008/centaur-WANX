import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("NSIS artwork uses valid uncompressed 24-bit bitmaps with expected dimensions", async () => {
  for (const [name, width, height] of [["header", 150, 57], ["sidebar", 164, 314],
    ["feature-1", 720, 400], ["feature-2", 720, 400], ["feature-3", 720, 400], ["overview", 720, 190]]) {
    const data = await readFile(new URL(`../resources/installer/${name}.bmp`, import.meta.url));
    assert.equal(data.toString("ascii", 0, 2), "BM", name);
    assert.equal(data.readUInt32LE(2), data.length, `${name}: file size`);
    assert.equal(data.readInt32LE(18), width, `${name}: width`);
    assert.equal(data.readInt32LE(22), height, `${name}: height`);
    assert.equal(data.readUInt16LE(28), 24, `${name}: native bitmap depth`);
    assert.equal(data.readUInt32LE(30), 0, `${name}: no compression`);
    const stride = Math.ceil(width * 3 / 4) * 4;
    assert.equal(data.readUInt32LE(10) + stride * height, data.length, `${name}: complete pixels`);
  }
});

test("installer source screenshots retain their recorded capture hashes and PNG dimensions", async () => {
  const base = new URL("../resources/installer/screenshots/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("provenance.json", base), "utf8"));
  assert.deepEqual(manifest.screenshots.map(item => item.file), ["apps.png", "space.png", "box.png"]);
  for (const item of manifest.screenshots) {
    const data = await readFile(new URL(item.file, base));
    assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(createHash("sha256").update(data).digest("hex"), item.sha256);
    assert.equal(data.readUInt32BE(16), item.width);
    assert.equal(data.readUInt32BE(20), item.height);
  }
});

function riffChunks(data, start = 12, end = data.length) {
  const chunks = [];
  for (let pos = start; pos + 8 <= end;) {
    const id = data.toString("ascii", pos, pos + 4), bytes = data.readUInt32LE(pos + 4);
    assert.ok(pos + 8 + bytes <= end, `complete ${id} chunk`);
    chunks.push({ id, start: pos + 8, end: pos + 8 + bytes });
    pos += 8 + bytes + (bytes % 2);
  }
  return chunks;
}

test("install-page loops are codec-free silent AVI with three posters held for 5.5 seconds each", async () => {
  for (const [density, width, height] of [[1, 280, 156], [2, 420, 234], [3, 560, 312]]) {
    const data = await readFile(new URL(`../resources/installer/poster-loop-${density}x.avi`, import.meta.url));
    assert.equal(data.toString("ascii", 0, 4), "RIFF");
    assert.equal(data.toString("ascii", 8, 12), "AVI ");
    assert.equal(data.readUInt32LE(4) + 8, data.length);
    const lists = riffChunks(data).filter(chunk => chunk.id === "LIST");
    const header = lists.find(chunk => data.toString("ascii", chunk.start, chunk.start + 4) === "hdrl");
    const headers = riffChunks(data, header.start + 4, header.end);
    const main = headers.find(chunk => chunk.id === "avih");
    assert.equal(data.readUInt32LE(main.start + 16), 3, "three frames");
    assert.equal(data.readUInt32LE(main.start + 24), 1, "video only, no audio stream");
    const streamList = headers.find(chunk => chunk.id === "LIST");
    const stream = riffChunks(data, streamList.start + 4, streamList.end);
    const sh = stream.find(chunk => chunk.id === "strh");
    assert.equal(data.toString("ascii", sh.start, sh.start + 4), "vids");
    assert.equal(data.readUInt32LE(sh.start + 20) / data.readUInt32LE(sh.start + 24), 5.5);
    const format = stream.find(chunk => chunk.id === "strf");
    assert.equal(data.readInt32LE(format.start + 4), width);
    assert.equal(data.readInt32LE(format.start + 8), height);
    assert.equal(data.readUInt16LE(format.start + 14), 24);
    assert.equal(data.readUInt32LE(format.start + 16), 0, "BI_RGB without an external codec");
    const movie = lists.find(chunk => data.toString("ascii", chunk.start, chunk.start + 4) === "movi");
    const frames = riffChunks(data, movie.start + 4, movie.end).filter(chunk => /^00d[bc]$/.test(chunk.id));
    assert.equal(frames.length, 3);
    for (const frame of frames) assert.equal(frame.end - frame.start, width * height * 3);
  }
});
