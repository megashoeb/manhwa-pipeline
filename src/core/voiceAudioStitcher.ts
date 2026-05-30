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

/**
 * Memory-safe STREAMING stitcher — single-pass decode + encode that
 * never holds the full mixed signal in memory.
 *
 * Why this exists: the legacy ``fetchDecodeStitch`` pipeline peaks at
 * 3-4x the final WAV size in memory because:
 *   1. All decoded Float32 samples are accumulated in ``lines: DecodedLine[]``
 *      (1441 lines × ~5s × 44100Hz × 4 bytes/sample ≈ 1.27 GB).
 *   2. ``concatenateLines`` allocates ANOTHER 1.27 GB Float32Array.
 *   3. ``encodeWav`` allocates ANOTHER ~640 MB ArrayBuffer.
 *
 * Total peak ~3.2 GB contiguous heap → crashes with "Array buffer
 * allocation failed" on macOS (stricter contiguous-allocation limits
 * than Windows Chrome).
 *
 * Streaming approach:
 *   • Decode ONE line at a time.
 *   • Encode its samples directly to int16 PCM as a small Uint8Array.
 *   • Push the chunk to a chunks array, then discard the Float32 samples.
 *   • Reuse a single silence chunk between lines.
 *   • At end, assemble via ``new Blob(chunks)`` — the Blob constructor
 *     doesn't require contiguous backing memory, so 1441 small chunks
 *     work fine.
 *
 * Peak memory: ~one decoded line (~5 MB) + accumulated int16 chunks
 * (~635 MB for 1441 lines at 44100Hz mono). Well under the 2 GB
 * single-allocation ceiling on macOS browsers.
 *
 * Note: we need ``totalSamples`` for the WAV header. Two-pass would
 * cost double the decode time; one-pass uses a sentinel header that
 * gets patched at the end via a tiny extra Blob slice.
 */
export async function fetchDecodeStitchStreamed(
  opts: StitchOptions,
): Promise<StitchResult> {
  if (opts.urls.length === 0) {
    return {
      wavBlob: new Blob([], { type: "audio/wav" }),
      durationsMs: [],
      totalDurationMs: 0,
    };
  }

  // Decode the first line so we know the sample rate. Most ai33.pro
  // calls return 44100 Hz mono — but verifying once is cheap.
  const first = await decodeMp3(opts.urls[0]);
  const sampleRate = first.sampleRate;
  opts.onLineDecoded?.(1, opts.urls.length, first.durationMs);

  // Reusable silence chunk (zero-filled int16). Same bytes between
  // every pair of lines — no need to re-allocate.
  const silenceSamples = Math.max(
    0,
    Math.round((opts.silenceMs / 1000) * sampleRate),
  );
  const silenceChunk =
    silenceSamples > 0 ? new Uint8Array(silenceSamples * 2) : null;

  // Accumulate per-line int16 PCM chunks. Each one is ~2× the decoded
  // line's duration × 44.1 KB/s ≈ ~440 KB for a 5-sec line — tiny.
  const chunks: BlobPart[] = [];
  const durationsMs: number[] = [];
  let totalSamples = 0;

  const pushLine = (samples: Float32Array, durationMs: number) => {
    const pcm = floatToInt16Chunk(samples);
    // Cast to satisfy TypeScript 5.7's stricter Uint8Array→BlobPart
    // variance check (Uint8Array<ArrayBufferLike> isn't auto-assignable
    // to BlobPart because the buffer could theoretically be Shared).
    chunks.push(pcm as unknown as BlobPart);
    totalSamples += samples.length;
    durationsMs.push(durationMs);
  };
  const pushSilence = () => {
    if (silenceChunk) {
      chunks.push(silenceChunk as unknown as BlobPart);
      totalSamples += silenceSamples;
    }
  };

  pushLine(first.samples, first.durationMs);

  for (let i = 1; i < opts.urls.length; i++) {
    pushSilence();
    const decoded = await decodeMp3(opts.urls[i]);
    if (decoded.sampleRate !== sampleRate) {
      throw new Error(
        `Sample-rate mismatch at line ${i + 1}: expected ${sampleRate}, got ${decoded.sampleRate}`,
      );
    }
    pushLine(decoded.samples, decoded.durationMs);
    opts.onLineDecoded?.(i + 1, opts.urls.length, decoded.durationMs);
    // Discard the decoded Float32 reference — GC will reclaim.
    (decoded as { samples?: Float32Array }).samples = undefined;
  }

  // Prepend the WAV header now that we know the final sample count.
  const header = buildWavHeader(totalSamples, sampleRate);
  const finalChunks: BlobPart[] = [header as unknown as BlobPart, ...chunks];

  const wavBlob = new Blob(finalChunks, { type: "audio/wav" });
  return {
    wavBlob,
    durationsMs,
    totalDurationMs: (totalSamples / sampleRate) * 1000,
  };
}

/**
 * Convert a Float32 mono samples buffer into a 16-bit PCM Uint8Array.
 * The output is byte-identical to what ``encodeWav`` writes into the
 * monolithic ArrayBuffer — just done one line at a time so we never
 * need a giant contiguous backing buffer.
 */
function floatToInt16Chunk(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/**
 * Build the 44-byte RIFF/WAVE header. Same byte layout as ``encodeWav``
 * — extracted into a helper so the streaming path can prepend it
 * without going through encodeWav (which assumes full Float32 input).
 */
function buildWavHeader(totalSamples: number, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  writeStringAt(view, 0, "RIFF");
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeStringAt(view, 8, "WAVE");
  writeStringAt(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStringAt(view, 36, "data");
  view.setUint32(40, totalSamples * 2, true);
  return new Uint8Array(buffer);
}
