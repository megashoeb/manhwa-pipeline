// Browser-side audio stitching for the TTS tab.
//
// Each line of the user's script becomes one MP3 from ai33.pro. We
// fetch them all, decode via the Web Audio API, concatenate the
// samples with a configurable silence gap, and re-encode the result
// as a single WAV blob the user can download.
//
// Why WAV (not MP3): browsers don't ship an MP3 encoder. Encoding
// MP3 from raw samples needs a JS library (lamejs, ~150KB) — overkill
// for personal use. WAV is large but lossless; the user can convert
// to MP3 in CapCut on import if they care.

export interface DecodedLine {
  /** Source URL the MP3 was fetched from. */
  url: string;
  /** Mono float32 samples (downmixed from stereo if needed). */
  samples: Float32Array;
  /** Sample rate of the decoded audio. */
  sampleRate: number;
  /** Duration in ms — used for SRT timing. */
  durationMs: number;
}

/**
 * Fetch + decode a single MP3 URL into mono float32 samples.
 * Stereo input gets downmixed (avg of L+R channels).
 */
export async function decodeMp3(url: string): Promise<DecodedLine> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch audio ${url} (HTTP ${res.status})`);
  }
  const arrayBuf = await res.arrayBuffer();
  // Use a fresh AudioContext per call to avoid the user-gesture
  // requirement some browsers impose on shared contexts. Closed
  // immediately after decode.
  const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  let audioBuf: AudioBuffer;
  try {
    audioBuf = await ctx.decodeAudioData(arrayBuf);
  } finally {
    void ctx.close();
  }

  // Downmix to mono if necessary.
  let samples: Float32Array;
  if (audioBuf.numberOfChannels === 1) {
    samples = new Float32Array(audioBuf.length);
    samples.set(audioBuf.getChannelData(0));
  } else {
    const left = audioBuf.getChannelData(0);
    const right = audioBuf.getChannelData(1);
    samples = new Float32Array(audioBuf.length);
    for (let i = 0; i < audioBuf.length; i++) {
      samples[i] = (left[i] + right[i]) * 0.5;
    }
  }

  return {
    url,
    samples,
    sampleRate: audioBuf.sampleRate,
    durationMs: (audioBuf.length / audioBuf.sampleRate) * 1000,
  };
}

/**
 * Concatenate decoded lines with ``silenceMs`` of silence inserted
 * between each. Resamples are NOT performed — every input must
 * share the same sampleRate (it will be the ai33.pro standard 44100
 * for ``mp3_44100_128`` output). On mismatch, throws.
 */
export function concatenateLines(
  lines: DecodedLine[],
  silenceMs: number,
): { samples: Float32Array; sampleRate: number } {
  if (lines.length === 0) {
    return { samples: new Float32Array(0), sampleRate: 44100 };
  }
  const sampleRate = lines[0].sampleRate;
  for (const line of lines) {
    if (line.sampleRate !== sampleRate) {
      throw new Error(
        `Sample-rate mismatch: expected ${sampleRate}, got ${line.sampleRate}`,
      );
    }
  }

  const silenceSamples = Math.max(
    0,
    Math.round((silenceMs / 1000) * sampleRate),
  );
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += lines[i].samples.length;
    if (i < lines.length - 1) total += silenceSamples;
  }

  const out = new Float32Array(total);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    out.set(lines[i].samples, offset);
    offset += lines[i].samples.length;
    if (i < lines.length - 1) {
      // Silence is zeros — already initialised by Float32Array.
      offset += silenceSamples;
    }
  }
  return { samples: out, sampleRate };
}

/**
 * Encode mono float32 samples as a 16-bit PCM WAV blob. The header
 * uses the standard 44-byte RIFF/WAVE format that every player /
 * editor recognises (CapCut, Audacity, VLC, etc.).
 */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Blob {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeStringAt(view, 0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStringAt(view, 8, "WAVE");
  // fmt subchunk
  writeStringAt(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  // data subchunk
  writeStringAt(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Sample payload
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeStringAt(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Convenience wrapper — fetch + decode every URL, concatenate with
 * silence gap, encode WAV. Returns the final blob + per-line
 * durations so the SRT builder can compute timestamps.
 */
export interface StitchOptions {
  urls: string[];
  silenceMs: number;
  /** Fires for each line as it finishes decoding. */
  onLineDecoded?: (index: number, total: number, durationMs: number) => void;
}

export interface StitchResult {
  wavBlob: Blob;
  durationsMs: number[];
  totalDurationMs: number;
}

export async function fetchDecodeStitch(
  opts: StitchOptions,
): Promise<StitchResult> {
  const lines: DecodedLine[] = [];
  for (let i = 0; i < opts.urls.length; i++) {
    const decoded = await decodeMp3(opts.urls[i]);
    lines.push(decoded);
    opts.onLineDecoded?.(i + 1, opts.urls.length, decoded.durationMs);
  }
  const { samples, sampleRate } = concatenateLines(lines, opts.silenceMs);
  const wavBlob = encodeWav(samples, sampleRate);
  return {
    wavBlob,
    durationsMs: lines.map((l) => l.durationMs),
    totalDurationMs: (samples.length / sampleRate) * 1000,
  };
}
