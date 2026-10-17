import { app, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAvatar } from '../../shell/avatar.mjs';
import { validateProfilePatch } from '../../account/profile.mjs';
async function verifyAvatar() {
await app.whenReady();
const dir = await mkdtemp(join(tmpdir(), 'wanx-avatar-'));
try {
  const original = nativeImage.createFromBitmap(Buffer.alloc(640 * 320 * 4, 180), { width: 640, height: 320 });
  for (const [extension, bytes] of [['png', original.toPNG()], ['jpg', original.toJPEG(90)]]) {
    const file = join(dir, `avatar.${extension}`); await writeFile(file, bytes);
    const data = await readAvatar(file, nativeImage);
    assert.deepEqual(nativeImage.createFromDataURL(data).getSize(), { width: 256, height: 256 });
    assert.equal(validateProfilePatch({ avatarDataUrl: data }).avatarDataUrl, data);
  }
  const bad = join(dir, 'bad.png');
  await writeFile(bad, '<svg onload="evil()"/>');
  await assert.rejects(readAvatar(bad, nativeImage), /PROFILE_INVALID_AVATAR/);
  await writeFile(bad, Buffer.from([137,80,78,71,13,10,26,10]));
  await assert.rejects(readAvatar(bad, nativeImage), /PROFILE_INVALID_AVATAR/);
  await writeFile(bad, Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(readAvatar(bad, nativeImage), /PROFILE_AVATAR_TOO_LARGE/);
  console.log('AVATAR_ELECTRON_PASS');
} finally { await rm(dir, { recursive: true, force: true }); }
app.quit();
}
void verifyAvatar().catch(error => { console.error(error); app.exit(1); });
