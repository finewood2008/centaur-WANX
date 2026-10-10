const WAV_SAMPLE_RATE = 16000;

/**
 * Re-encode a recorded blob as 16kHz mono PCM16 WAV.
 *
 * Server STT providers reject browser recording containers (e.g. Tencent ASR
 * does not accept webm). Decoding via Web Audio and uploading plain WAV works
 * for every provider. Falls back to the original blob when the browser cannot
 * decode it. A duration limit crops the rendered sample count, avoiding timer
 * jitter producing a recording longer than a strict server/native limit.
 */
export async function recordedBlobToWav(
  blob: Blob,
  maxDurationSeconds?: number,
): Promise<Blob> {
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return blob;
  const ctx = new Ctor();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const decodedFrames = Math.round(decoded.duration * WAV_SAMPLE_RATE);
    const length = Math.max(
      1,
      maxDurationSeconds === undefined
        ? decodedFrames
        : Math.min(
            decodedFrames,
            Math.floor(maxDurationSeconds * WAV_SAMPLE_RATE),
          ),
    );
    const offline = new OfflineAudioContext(1, length, WAV_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeStr = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + pcm.byteLength, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, WAV_SAMPLE_RATE, true);
    view.setUint32(28, WAV_SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, pcm.byteLength, true);
    return new Blob([header, pcm.buffer], { type: "audio/wav" });
  } catch {
    return blob;
  } finally {
    void ctx.close();
  }
}

/** Pick the best MIME type supported by the current browser for recording. */
export function pickRecorderMimeType(): string {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg",
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}
