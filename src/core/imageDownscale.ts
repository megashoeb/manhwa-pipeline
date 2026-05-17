// Browser-side image downscaling for Gemini Vision uploads.
//
// Gemini's Vision encoder downscales every input image to ~768 px
// longest edge internally. Sending it 200 DPI panels (1500×2200 px,
// ~1-2 MB each) is pure upload waste — Gemini SEES the same content
// either way, but the user's network has to push ~3-5× more bytes.
//
// We downscale to ~768 px longest edge ONCE per panel using canvas
// (cheap ~50 ms/image on a modern laptop) and reuse the smaller blob
// across every Gemini call that needs that panel.

/** Default cap — matches Gemini's internal vision-tower resolution. */
export const DEFAULT_VISION_MAX_EDGE = 768;

/**
 * Resize a JPEG blob so its LONGEST edge is at most ``maxEdge`` px,
 * preserving aspect ratio. Re-encodes as JPEG at quality 0.85 (the
 * same level the pipeline uses everywhere else). Skips re-encoding
 * entirely when the source is already smaller than ``maxEdge``.
 *
 * Throws on canvas/decode failure — caller should ``try/catch`` and
 * fall back to the original blob.
 */
export async function downscaleBlob(
  blob: Blob,
  maxEdge: number = DEFAULT_VISION_MAX_EDGE,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    bitmap.close();
    return blob;
  }
  const scale = maxEdge / longest;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("2D canvas context unavailable for downscale");
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      "image/jpeg",
      0.85,
    );
  });
  // Free canvas backing store immediately.
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

/**
 * Concurrency-bounded parallel downscale of N blobs. Falls back to
 * the original blob on per-image failure (one bad decode doesn't kill
 * a whole chapter). Default concurrency = 4 — a balance between CPU
 * cost and not stalling on slow images.
 */
export async function downscaleBlobs(
  blobs: Blob[],
  maxEdge: number = DEFAULT_VISION_MAX_EDGE,
  concurrency = 4,
): Promise<Blob[]> {
  const out: Blob[] = new Array(blobs.length);
  let nextIdx = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIdx++;
      if (i >= blobs.length) return;
      try {
        out[i] = await downscaleBlob(blobs[i], maxEdge);
      } catch (err) {
        console.warn(
          `Downscale failed for image ${i}; using original: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        out[i] = blobs[i];
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, blobs.length || 1) }, () =>
      worker(),
    ),
  );
  return out;
}
