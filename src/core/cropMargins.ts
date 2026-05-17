// Crop a fraction off the top and bottom of an image.
//
// Designed for browser print-to-PDF artifacts — date/title headers at
// the top, URL/page-number footers at the bottom (e.g. Asura Scans
// print PDFs). Pure browser code: ``createImageBitmap`` + ``<canvas>``.

const JPEG_QUALITY = 0.85;

/**
 * Return a new JPEG ``Blob`` with the requested percentage stripped
 * from the top and bottom. If both percentages are 0, the input
 * blob is returned unchanged (no copy, no re-encode).
 *
 * The combined margin is clamped so we never produce a zero-height
 * image; if the math says we'd crop everything, the original blob
 * is returned untouched.
 */
export async function cropBlobMargins(
  blob: Blob,
  topPct: number,
  bottomPct: number,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (topPct <= 0 && bottomPct <= 0) {
    // Cheap path: decode just enough to report dimensions, then re-use
    // the original encoded bytes. Saves a JPEG round-trip per page.
    const bm = await createImageBitmap(blob);
    const out = { blob, width: bm.width, height: bm.height };
    bm.close();
    return out;
  }

  const bitmap = await createImageBitmap(blob);
  const topPx = Math.max(0, Math.round(bitmap.height * topPct));
  const botPx = Math.max(0, Math.round(bitmap.height * bottomPct));
  const newH = bitmap.height - topPx - botPx;

  if (newH <= 0) {
    // Combined margins eat the whole page — refuse to crop, return original.
    const out = { blob, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return out;
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = newH;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("2D canvas context unavailable");
  }
  ctx.drawImage(
    bitmap,
    /* sx */ 0, /* sy */ topPx,
    /* sw */ bitmap.width, /* sh */ newH,
    /* dx */ 0, /* dy */ 0,
    /* dw */ bitmap.width, /* dh */ newH,
  );
  bitmap.close();

  const out = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });

  const result = { blob: out, width: canvas.width, height: canvas.height };
  // Free canvas backing store immediately — some browsers (Safari)
  // hold onto it otherwise.
  canvas.width = 0;
  canvas.height = 0;

  return result;
}
