// Convert whatever the browser recorded (webm/opus on Android, mp4/aac on
// iPad) into a small 16 kHz mono WAV, a format Gemini always accepts.

const TARGET_RATE = 16000

export async function blobToWavBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext
  const ctx = new AC()
  let decoded: AudioBuffer
  try {
    decoded = await new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(buf, res, rej))
  } finally {
    ctx.close().catch(() => {})
  }

  const length = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OAC: typeof OfflineAudioContext = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext
  const off = new OAC(1, length, TARGET_RATE)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return toBase64(encodeWav(rendered.getChannelData(0), TARGET_RATE))
}

function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE')
  w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true)
  w(36, 'data'); out.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(out.buffer)
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
