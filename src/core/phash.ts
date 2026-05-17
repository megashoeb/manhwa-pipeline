// Perceptual hash (pHash) for near-duplicate detection.
//
// Same algorithm as Python's ``imagehash.phash``:
//   1. Resize image to 32×32 grayscale (high-quality downsample).
//   2. Compute 2D DCT-II.
//   3. Keep the top-left 8×8 of the DCT (the low-frequency block).
//   4. Compute the median of those 64 values.
//   5. Build a 64-bit hash: bit_i = 1 if pixel_i > median, else 0.
//
// Two hashes are "similar" if their bitwise Hamming distance is
// small (typically ≤ 5 for manhwa filler).
//
// Returned as ``bigint`` so we get cheap XOR + popcount without
// worrying about JavaScript's 32-bit bitwise quirks.

const HASH_SIZE = 8;
const HIGHFREQ_FACTOR = 4;
const IMG_SIZE = HASH_SIZE * HIGHFREQ_FACTOR; // 32

/** Compute the 64-bit perceptual hash of a JPEG blob. */
export async function computePHash(blob: Blob): Promise<bigint> {
  const gray = await loadAsGrayscale(blob, IMG_SIZE);
  const dct = dct2d(gray, IMG_SIZE);

  // Pull out the top-left HASH_SIZE × HASH_SIZE (low-freq) block.
  const low = new Float32Array(HASH_SIZE * HASH_SIZE);
  for (let r = 0; r < HASH_SIZE; r++) {
    for (let c = 0; c < HASH_SIZE; c++) {
      low[r * HASH_SIZE + c] = dct[r * IMG_SIZE + c];
    }
  }

  const median = medianOf(low);

  // Build 64-bit hash. Bit ordering matches imagehash's row-major
  // serialization (matters only for human inspection — Hamming
  // distance is invariant to bit ordering).
  let hash = 0n;
  for (let i = 0; i < low.length; i++) {
    if (low[i] > median) hash |= 1n << BigInt(i);
  }
  return hash;
}

/**
 * Bitwise Hamming distance between two 64-bit phashes.
 *
 * Counts the number of differing bits — i.e. how many of the 64
 * features the two images disagree on. Small = similar.
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    if (x & 1n) count++;
    x >>= 1n;
  }
  return count;
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

async function loadAsGrayscale(
  blob: Blob,
  size: number,
): Promise<Float32Array> {
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: size,
    resizeHeight: size,
    resizeQuality: "high",
  });
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("2D canvas context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, size, size);
  const gray = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  canvas.width = 0;
  canvas.height = 0;
  return gray;
}

/**
 * Separable 2D DCT-II (matches ``scipy.fftpack.dct`` default type-2,
 * unnormalized). We apply 1D DCT along rows, then along columns.
 *
 * Complexity: O(N³). For N=32 that's 32,768 ops per page × 2 passes
 * = ~65K ops per phash. Sub-millisecond in modern V8.
 */
function dct2d(matrix: Float32Array, n: number): Float32Array {
  const rowResult = new Float32Array(n * n);
  const row = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < n; i++) row[i] = matrix[r * n + i];
    const out = dct1d(row, n);
    for (let i = 0; i < n; i++) rowResult[r * n + i] = out[i];
  }

  const result = new Float32Array(n * n);
  const col = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    for (let i = 0; i < n; i++) col[i] = rowResult[i * n + c];
    const out = dct1d(col, n);
    for (let i = 0; i < n; i++) result[i * n + c] = out[i];
  }
  return result;
}

/** Naive 1D DCT-II — O(N²), good enough for N=32. */
function dct1d(input: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  const piOver2N = Math.PI / (2 * n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos((2 * i + 1) * k * piOver2N);
    }
    out[k] = sum;
  }
  return out;
}

function medianOf(arr: Float32Array): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
