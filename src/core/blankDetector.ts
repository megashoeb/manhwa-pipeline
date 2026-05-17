// Blank-page detection — four-check ensemble.
//
// A page is "blank" if it falls into ANY of:
//   1. White blank:   stddev < T AND mean > meanThreshold        (empty paper)
//   2. Dark blank:    stddev < T AND mean < (255 - meanThreshold) (void/transition)
//   3. Solid blank:   stddev < (T * 0.4)                          (solid mid-tone)
//   4. Mostly empty:  >85% of pixels at the extremes (>220 or <35) (small figure
//                                                       in a vast empty frame)
//
// Why the fourth check? Pure stddev/mean fails on panels with a TINY
// content fragment in an otherwise empty page — a sliver of clothing
// in a corner, a dagger handle at the top, a single eye peeking from
// the dark. These panels have moderate stddev (the small content
// creates variance) and moderate mean (the content pulls it away
// from the white extreme), so checks 1-3 all miss. But >85% of the
// pixels are still pure white/black background — that's the signal
// we use.
//
// What still slips through: smooth gradients (low edge density but
// moderate stddev AND moderate pixel histogram). Those are caught
// downstream by the curator AI's "skip blank/gradient panels" rule.

const SAMPLE_WIDTH = 256;

/** Pixel-histogram threshold — luma above this counts as "near white". */
const NEAR_WHITE_LUMA = 220;
/** Pixel-histogram threshold — luma below this counts as "near black". */
const NEAR_BLACK_LUMA = 35;
/** Fraction of pixels at the extremes above which we call the panel "mostly empty". */
const MOSTLY_EMPTY_FRACTION = 0.85;

/**
 * Compute blank-detection stats for a JPEG blob.
 *
 * Returns the raw mean and stddev so the UI can show them for tuning,
 * plus the boolean verdict against the supplied thresholds.
 */
export async function checkBlank(
  blob: Blob,
  stddevThreshold: number,
  meanThreshold: number,
): Promise<{ isBlank: boolean; stddev: number; mean: number }> {
  // Decode + downsample in one shot via createImageBitmap.
  const probe = await createImageBitmap(blob);
  const aspect = probe.height / probe.width;
  const w = SAMPLE_WIDTH;
  const h = Math.max(1, Math.round(SAMPLE_WIDTH * aspect));
  probe.close();

  const bitmap = await createImageBitmap(blob, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: "medium",
  });

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("2D canvas context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, w, h);
  const n = w * h;

  // Walking-variance via running sums of x and x². This is one pass
  // over the pixels rather than the naive two-pass mean-then-stddev.
  // Same pass also accumulates the pixel-histogram counts for check #4.
  let sum = 0;
  let sumSq = 0;
  let nearWhite = 0;
  let nearBlack = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // ITU-R 601-2 luma (matches PIL's "L" mode conversion).
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += y;
    sumSq += y * y;
    if (y > NEAR_WHITE_LUMA) nearWhite++;
    else if (y < NEAR_BLACK_LUMA) nearBlack++;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  const stddev = Math.sqrt(Math.max(0, variance));
  const extremeFraction = (nearWhite + nearBlack) / n;

  // Free canvas backing store.
  canvas.width = 0;
  canvas.height = 0;

  // Symmetric dark threshold — if meanThreshold is 240 (must be VERY
  // white to count as white-blank), the mirror is 15 (must be VERY
  // dark to count as dark-blank). Both are about "extreme luma + low
  // variance".
  const darkMeanCeiling = 255 - meanThreshold;
  // Solid-fill cutoff — flatter than the standard threshold catches
  // mid-tone solids that don't trigger either extreme.
  const solidStddevCeiling = stddevThreshold * 0.4;

  const isWhiteBlank = stddev < stddevThreshold && mean > meanThreshold;
  const isDarkBlank = stddev < stddevThreshold && mean < darkMeanCeiling;
  const isSolidBlank = stddev < solidStddevCeiling;
  // Check #4: catches panels with a tiny figure in a vast empty frame.
  // The earlier checks miss these because the small figure pushes both
  // mean and stddev away from "obviously blank", but >85% of the pixels
  // are still at the extremes — the panel is visually empty.
  const isMostlyEmpty = extremeFraction > MOSTLY_EMPTY_FRACTION;

  return {
    isBlank:
      isWhiteBlank || isDarkBlank || isSolidBlank || isMostlyEmpty,
    stddev,
    mean,
  };
}
