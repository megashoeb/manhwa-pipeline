// Webtoon panel slicer.
//
// Manhwa chapters often arrive as PDFs where each page is a single
// vertical scroll-format strip containing 3-15 panels stacked on top of
// each other with white/uniform-color "gutter" gaps between them. The
// downstream pipeline (curator, narrator, beat-alignment) assumes
// 1 image = 1 panel, so without slicing we end up with 2 huge strip
// images for an entire chapter and the script can't be aligned to
// individual panels.
//
// This module takes a rendered PDF page canvas and returns rectangles
// (one per detected panel). Algorithm:
//
//   1. Aspect-ratio gate. If height / width < ``minAspectRatio`` (~2.5),
//      it's a traditional manga page, NOT a webtoon strip — return the
//      whole canvas as a single slice (backward compatible).
//
//   2. Detect background color from 8 corner/edge samples. Webtoons
//      typically have white gutters but dark-mode chapters use black.
//      We auto-detect so both work.
//
//   3. Walk every row top-to-bottom. Sample 1-in-N columns and count
//      pixels within ``colorTolerance`` of the background. If
//      ``blankRowThreshold`` (95%) of sampled pixels match, the row is
//      part of a gutter.
//
//   4. Find runs of >= ``minGutterHeight`` (~20 px) consecutive blank
//      rows. Each run is a real gutter; thin 1-3 px panel borders are
//      ignored.
//
//   5. Slice at gutter midpoints. Filter out slices shorter than
//      ``minPanelHeight`` (~400 px) — those are usually slivers caused
//      by noise rather than real panels; we either skip or merge them
//      into adjacent panels.

export interface SliceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SliceOptions {
  /**
   * Aspect ratio (height / width) above which the page is treated as a
   * vertical webtoon strip. Pages below this ratio are returned as a
   * single slice — preserves behaviour for traditional manga PDFs.
   */
  minAspectRatio?: number;
  /**
   * Minimum number of consecutive "blank" rows to count as a real
   * gutter. Thin 1-3 px panel borders fall below this.
   */
  minGutterHeight?: number;
  /**
   * Minimum height (px) for an output slice. Smaller slices are merged
   * into neighbours so noise / partial slivers don't pollute the output.
   */
  minPanelHeight?: number;
  /**
   * Per-channel color tolerance (0-255). A row pixel within this
   * distance of the detected background color counts as "blank".
   */
  colorTolerance?: number;
  /**
   * Fraction of sampled pixels in a row that must be blank for the row
   * itself to count as blank. 0.95 is robust against speech bubbles
   * that briefly bridge a gutter.
   */
  blankRowThreshold?: number;
  /**
   * Sample every Nth column when scanning a row. 4 = 25% of pixels —
   * fast and accurate; webtoon gutters are wide so partial sampling
   * doesn't miss them.
   */
  sampleStep?: number;
}

const DEFAULTS: Required<SliceOptions> = {
  // Slightly lower so 2.5:1 webtoons still trigger but landscape covers
  // never do.
  minAspectRatio: 2.2,
  // Thinner gutters (12 px) still count — many webtoons use compact
  // gutters between sequential close-ups.
  minGutterHeight: 12,
  // 300 px allows close-up / reaction panels through. Smaller chunks
  // get merged into neighbours by the sliver-collapse pass.
  minPanelHeight: 300,
  // 40/255 tolerance handles tinted gutters (beige, soft gray, slight
  // gradient) and JPEG noise that the earlier 25/255 threshold rejected.
  colorTolerance: 40,
  // 88% — speech bubbles and floating SFX that briefly cross a gutter
  // no longer kill detection. Below this is asking for trouble.
  blankRowThreshold: 0.88,
  sampleStep: 4,
};

/** Looser thresholds for the recovery pass over still-too-tall slices. */
const RECOVERY_OVERRIDES: Required<SliceOptions> = {
  ...DEFAULTS,
  minGutterHeight: 8,
  colorTolerance: 55,
  blankRowThreshold: 0.82,
  minPanelHeight: 250,
};

interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Find panel rectangles within a rendered PDF page canvas.
 *
 * Returns a single full-canvas rectangle when the page isn't a webtoon
 * strip (preserves traditional manga behaviour). Otherwise runs:
 *   1. Primary slice pass with default thresholds.
 *   2. Recovery pass — any slice taller than 2× the median gets a
 *      second slicing attempt with looser thresholds (catches gutters
 *      with tinted backgrounds or noisy compression).
 *   3. Sliver collapse — fragments shorter than ``minPanelHeight / 2``
 *      get merged into the adjacent slice rather than emitted as
 *      noise.
 */
export function sliceCanvasIntoPanels(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  options: SliceOptions = {},
): SliceRect[] {
  const opts: Required<SliceOptions> = { ...DEFAULTS, ...options };
  const W = canvas.width;
  const H = canvas.height;

  // -- 1. Aspect-ratio gate -----------------------------------------
  if (H / W < opts.minAspectRatio) {
    return [{ x: 0, y: 0, width: W, height: H }];
  }

  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) {
    return [{ x: 0, y: 0, width: W, height: H }];
  }

  // -- 2. Read the full image once (vastly faster than per-row reads).
  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data; // Uint8ClampedArray length W*H*4

  // -- 3. Detect background color from a wider sample. -------------
  // Old version used 6 fixed corner points which often hit content on
  // pages with full-bleed art. New version samples the top + bottom
  // 5% of rows and finds the dominant near-uniform color across them.
  const bg = detectBackgroundColor(data, W, H);

  // -- 4. Primary slice pass ----------------------------------------
  const blankRows = buildBlankRowMask(data, W, H, bg, opts);
  let slices = sliceFromBlankMask(blankRows, W, H, opts);

  // -- 5. Recovery pass: re-slice tall outliers --------------------
  // After the first pass, look at the median slice height. Any slice
  // taller than 2× the median is a strong candidate for an
  // un-detected gutter (likely tinted/noisy). Run it through a looser
  // detector and replace if we find new cuts.
  if (slices.length >= 2) {
    const heights = [...slices.map((s) => s.height)].sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const tallThreshold = Math.max(median * 2, opts.minPanelHeight * 3);

    const refined: SliceRect[] = [];
    for (const slice of slices) {
      if (slice.height >= tallThreshold) {
        const sub = reslice(data, W, slice, RECOVERY_OVERRIDES, bg);
        if (sub.length > 1) {
          refined.push(...sub);
          continue;
        }
      }
      refined.push(slice);
    }
    slices = refined;
  }

  // -- 6. Sliver collapse -------------------------------------------
  // Any slice shorter than half the min-panel threshold is too tight
  // to be a useful panel (think: 0018 in our test output — just a
  // floating speech bubble). Merge into its closer neighbour.
  slices = collapseSlivers(slices, opts.minPanelHeight / 2);

  // -- 7. Trim leading/trailing whitespace within each slice -------
  slices = slices.map((s) => trimSliceToContent(s, blankRows));

  // -- 8. Drop "blank/noise" slices — any slice >90% bg colour gets
  // dropped (canonical case: a thin gutter strip that survived the
  // slicing pass). Horizontal trim has been removed by request: all
  // output keeps the page's full portrait width for consistent aspect.
  slices = slices.filter((s) => {
    if (s.height < 80) return false;
    return !isSliceMostlyBlank(data, W, s, bg);
  });

  // -- 9. Drop "text-only" slices — panels with very few unique colours
  // AND a high background ratio are almost always speech-bubble-only
  // or title-card-only fragments (the manhwa equivalent of "End of
  // chapter" cards). They show up as nearly-blank images with floating
  // text and look terrible on a video timeline.
  slices = slices.filter((s) => !hasInsufficientContent(data, W, s, bg));

  // -- 10. Merge thin landscape strips into neighbours --------------
  // Slices with width/height > 2.5 are title cards, SFX bars, partial
  // panel cuts — they look terrible on a 16:9 video timeline because
  // there's barely any content to fill the frame. Merge them into the
  // closer neighbour so the absorbed content rides along with a
  // properly-sized panel instead of becoming its own image.
  slices = mergeThinStrips(slices, 2.5);

  // -- 11. Final guard — anything STILL with aspect > 4 gets dropped.
  // These are edge cases where mergeThinStrips couldn't fix it (e.g.
  // page contains a single 8:1 banner with no adjacent panel to merge
  // into). Better to drop than ship a useless sliver.
  slices = slices.filter((s) => s.width / s.height <= 4.0);

  // -- 12. Force-split TALL outputs that escaped gutter detection ---
  // Some pages have packed panels with no white gutter at all (color
  // backgrounds bleeding into adjacent panels, or art touching art
  // directly). Gutter scanning can't find a cut so the whole multi-
  // panel strip ends up as one tall image. Catch this last-resort:
  // any output with aspect H/W > 2.0 gets divided into N equal chunks
  // of roughly 1.5:1 aspect each. The cuts may not land on real
  // panel boundaries — that's OK; in a video each chunk gets its
  // own animation so the slight content overlap reads as motion.
  slices = forceSplitTallSlices(slices, opts.minPanelHeight);

  // If everything got filtered out (edge case: misdetected background
  // colour painted the whole page as "blank") fall back to a single
  // full-page slice so the chapter isn't lost.
  if (slices.length === 0) {
    return [{ x: 0, y: 0, width: W, height: H }];
  }

  return slices;
}

/**
 * Merge any slice whose aspect ratio (width / height) exceeds
 * ``maxAspect`` into its closest neighbour. Thin landscape strips —
 * title cards, SFX bars, partial top/bottom cuts — render terribly on
 * a 16:9 video canvas: the content barely fills any vertical space
 * after the editor's zoom animation, leaving big black bands. Folding
 * them into the next/previous panel keeps the chapter's content
 * intact while ensuring every output image has at least roughly
 * portrait-ish dimensions.
 *
 * Forward-merge for everything past index 0; backward-merge for slice
 * 0 if it's thin and there's a slice 1 to absorb it.
 */
function mergeThinStrips(slices: SliceRect[], maxAspect: number): SliceRect[] {
  if (slices.length <= 1) return slices;
  const out: SliceRect[] = [];
  for (const s of slices) {
    const aspect = s.width / s.height;
    const last = out[out.length - 1];
    if (aspect > maxAspect && last) {
      // Merge this thin strip into the previous slice by extending
      // its height to swallow the current strip's footprint.
      last.height = s.y + s.height - last.y;
    } else {
      out.push({ ...s });
    }
  }
  // If the leading slice is still a thin strip (no previous to merge
  // into), absorb it forward into out[1].
  if (out.length >= 2 && out[0].width / out[0].height > maxAspect) {
    out[1] = {
      x: out[1].x,
      y: out[0].y,
      width: out[1].width,
      height: out[1].y + out[1].height - out[0].y,
    };
    out.shift();
  }
  return out;
}

/**
 * Build the row mask (1 = blank, 0 = content) for a given background
 * colour and thresholds. Pulled out so the recovery pass can reuse it
 * with looser settings.
 */
function buildBlankRowMask(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  bg: RGB,
  opts: Required<SliceOptions>,
): Uint8Array {
  const blankRows = new Uint8Array(H);
  const sampleCount = Math.max(1, Math.floor(W / opts.sampleStep));
  const required = sampleCount * opts.blankRowThreshold;
  for (let y = 0; y < H; y++) {
    const rowStart = y * W * 4;
    let matches = 0;
    for (let x = 0; x < W; x += opts.sampleStep) {
      const i = rowStart + x * 4;
      if (
        Math.abs(data[i] - bg.r) <= opts.colorTolerance &&
        Math.abs(data[i + 1] - bg.g) <= opts.colorTolerance &&
        Math.abs(data[i + 2] - bg.b) <= opts.colorTolerance
      ) {
        matches++;
      }
    }
    if (matches >= required) blankRows[y] = 1;
  }
  return blankRows;
}

/**
 * Walk the row mask top→bottom and slice at gutter midpoints.
 * Pulled out so primary + recovery passes share the logic.
 */
function sliceFromBlankMask(
  blankRows: Uint8Array,
  W: number,
  H: number,
  opts: Required<SliceOptions>,
  yOffset = 0,
): SliceRect[] {
  const slices: SliceRect[] = [];
  let panelStart = 0;
  let blankStart = -1;

  for (let y = 0; y < H; y++) {
    if (blankRows[y]) {
      if (blankStart < 0) blankStart = y;
      continue;
    }
    if (blankStart >= 0) {
      const blankLen = y - blankStart;
      if (blankLen >= opts.minGutterHeight) {
        const cutY = Math.floor((blankStart + y) / 2);
        const sliceH = cutY - panelStart;
        if (sliceH >= opts.minPanelHeight) {
          slices.push({
            x: 0,
            y: panelStart + yOffset,
            width: W,
            height: sliceH,
          });
          panelStart = cutY;
        }
      }
      blankStart = -1;
    }
  }
  const tailH = H - panelStart;
  if (tailH >= opts.minPanelHeight || slices.length === 0) {
    slices.push({
      x: 0,
      y: panelStart + yOffset,
      width: W,
      height: tailH,
    });
  } else {
    slices[slices.length - 1].height += tailH;
  }
  return slices;
}

/**
 * Re-slice a tall slice using a looser blank-row detector. Reads the
 * relevant rows out of the full-page image data (no extra getImageData
 * call). Returns either the original slice (if recovery found nothing)
 * or the new finer-grained slices.
 */
function reslice(
  data: Uint8ClampedArray,
  W: number,
  slice: SliceRect,
  opts: Required<SliceOptions>,
  bg: RGB,
): SliceRect[] {
  const H = slice.height;
  const rowMask = new Uint8Array(H);
  const sampleCount = Math.max(1, Math.floor(W / opts.sampleStep));
  const required = sampleCount * opts.blankRowThreshold;
  for (let y = 0; y < H; y++) {
    const rowStart = (slice.y + y) * W * 4;
    let matches = 0;
    for (let x = 0; x < W; x += opts.sampleStep) {
      const i = rowStart + x * 4;
      if (
        Math.abs(data[i] - bg.r) <= opts.colorTolerance &&
        Math.abs(data[i + 1] - bg.g) <= opts.colorTolerance &&
        Math.abs(data[i + 2] - bg.b) <= opts.colorTolerance
      ) {
        matches++;
      }
    }
    if (matches >= required) rowMask[y] = 1;
  }
  return sliceFromBlankMask(rowMask, W, H, opts, slice.y);
}

/**
 * Merge slices smaller than ``threshold`` into whichever neighbour is
 * closer in height. Prevents stray floating-bubble fragments from
 * landing as their own image.
 */
function collapseSlivers(slices: SliceRect[], threshold: number): SliceRect[] {
  if (slices.length <= 1) return slices;
  const out: SliceRect[] = [];
  for (const s of slices) {
    const last = out[out.length - 1];
    if (s.height < threshold && last) {
      // Merge into previous (extending its height to swallow this).
      last.height = s.y + s.height - last.y;
    } else if (s.height < threshold && !last && slices.length > 1) {
      // Slice 0 is a sliver — push and let the next iteration merge
      // BACKWARDS by extending its top.
      out.push({ ...s });
    } else {
      out.push({ ...s });
    }
  }
  // Second pass: collapse forward — if out[0] is still a sliver and
  // out[1] exists, swallow it INTO out[1].
  if (out.length >= 2 && out[0].height < threshold) {
    out[1] = {
      x: out[1].x,
      y: out[0].y,
      width: out[1].width,
      height: out[1].y + out[1].height - out[0].y,
    };
    out.shift();
  }
  return out;
}

/**
 * Detect the dominant background colour of the page.
 *
 * Old version sampled 6 fixed corner/edge pixels — fragile on pages
 * with full-bleed art that reaches the edges. New version scans the
 * top + bottom 5% of rows AND looks for rows where the pixel variance
 * is very low (uniform colour rows are almost always gutters). The
 * dominant colour across those uniform rows is taken as the gutter
 * tone.
 *
 * Falls back to white if no uniform rows are found (better than
 * "average of mixed content" which corrupts the tolerance test).
 */
function detectBackgroundColor(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): RGB {
  // 16-bucket-per-channel histogram (4096 buckets total) of pixels
  // from likely-gutter rows. Picking the modal bucket gives a robust
  // dominant colour without sorting / sklearn-style clustering.
  const buckets = new Uint32Array(16 * 16 * 16);
  const sampleStep = 8;

  const scanRow = (y: number) => {
    const rowStart = y * W * 4;
    // Variance check: take min/max for each channel along the row.
    let minR = 255,
      minG = 255,
      minB = 255;
    let maxR = 0,
      maxG = 0,
      maxB = 0;
    for (let x = 0; x < W; x += sampleStep) {
      const i = rowStart + x * 4;
      const r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (g < minG) minG = g;
      if (g > maxG) maxG = g;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    // Uniform rows: span ≤ 30 per channel.
    if (maxR - minR <= 30 && maxG - minG <= 30 && maxB - minB <= 30) {
      for (let x = 0; x < W; x += sampleStep) {
        const i = rowStart + x * 4;
        const bucket =
          ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        buckets[bucket]++;
      }
    }
  };

  // Top 5% + bottom 5% of rows.
  const edge = Math.max(10, Math.floor(H * 0.05));
  for (let y = 0; y < edge; y++) scanRow(y);
  for (let y = H - edge; y < H; y++) scanRow(y);

  // Also probe a few rows from the middle in case top/bottom are
  // content-heavy (e.g. cover/title pages).
  const midProbes = 12;
  for (let p = 0; p < midProbes; p++) {
    const y = Math.floor(((p + 1) / (midProbes + 1)) * H);
    scanRow(y);
  }

  // Find dominant bucket.
  let bestBucket = -1;
  let bestCount = 0;
  for (let b = 0; b < buckets.length; b++) {
    if (buckets[b] > bestCount) {
      bestCount = buckets[b];
      bestBucket = b;
    }
  }

  if (bestBucket < 0) {
    return { r: 255, g: 255, b: 255 }; // safe fallback
  }
  // Decode bucket → mid-of-bucket RGB.
  const r = ((bestBucket >> 8) & 0xf) * 16 + 8;
  const g = ((bestBucket >> 4) & 0xf) * 16 + 8;
  const b = (bestBucket & 0xf) * 16 + 8;
  return { r, g, b };
}

/**
 * Tighten a slice by removing leading/trailing blank rows that didn't
 * qualify as their own gutter (e.g. the few px of whitespace inside a
 * panel above/below the artwork). Keeps the cropping flush.
 */
function trimSliceToContent(slice: SliceRect, blankRows: Uint8Array): SliceRect {
  let top = slice.y;
  const bottom = slice.y + slice.height;
  while (top < bottom - 1 && blankRows[top]) top++;
  let bot = bottom - 1;
  while (bot > top + 1 && blankRows[bot]) bot--;
  // Add 2 px padding on each side so we don't graze panel borders.
  top = Math.max(slice.y, top - 2);
  bot = Math.min(bottom - 1, bot + 2);
  return {
    x: slice.x,
    y: top,
    width: slice.width,
    height: bot - top + 1,
  };
}

/**
 * Detect text-only / title-card panels by sampling colour variety.
 *
 * Real art panels contain rich, varied colour content. Text-only
 * panels (speech-bubble-only fragments, "End of chapter" cards) have
 * very few distinct colours — usually just background + 1-2 text
 * shades. Quantising sampled pixels to 4 bits per channel (16 levels)
 * gives us a 4096-bucket histogram; if the slice fills fewer than ~40
 * buckets AND most pixels are background-coloured, it's a text-only
 * fragment and shouldn't be emitted as its own video frame.
 *
 * Tuned against the user's chapter where images 27, 28, 29, 34 were
 * floating speech bubbles with no character or action.
 */
function hasInsufficientContent(
  data: Uint8ClampedArray,
  W: number,
  slice: SliceRect,
  bg: RGB,
): boolean {
  const x0 = slice.x;
  const x1 = slice.x + slice.width;
  const y0 = slice.y;
  const y1 = slice.y + slice.height;
  const stepX = Math.max(3, Math.floor(slice.width / 80));
  const stepY = Math.max(3, Math.floor(slice.height / 80));

  const colorBuckets = new Set<number>();
  let bgPixels = 0;
  let totalPixels = 0;

  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * W + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // 4-bit/channel quantisation → 4096 possible buckets.
      colorBuckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));

      // Background match (loose tolerance — text panels often have
      // slight off-white shading around bubbles).
      if (
        Math.abs(r - bg.r) <= 30 &&
        Math.abs(g - bg.g) <= 30 &&
        Math.abs(b - bg.b) <= 30
      ) {
        bgPixels++;
      }
      totalPixels++;
    }
  }

  if (totalPixels === 0) return false;
  const uniqueColors = colorBuckets.size;
  const bgRatio = bgPixels / totalPixels;

  // Text-only signature: few unique colours AND lots of background.
  // Both conditions required so a low-colour ART panel (e.g. a single
  // dark silhouette on snow) doesn't get filtered.
  return uniqueColors < 45 && bgRatio > 0.65;
}

/**
 * Force-split any slice whose H/W exceeds ``MAX_OUTPUT_ASPECT`` into
 * roughly-square portrait chunks. Last-resort safety net for pages
 * where the gutter detector failed entirely (no white space between
 * adjacent panels, e.g. full-bleed colour spreads with art touching
 * art directly).
 *
 * The cuts are even divisions — they won't always land on real panel
 * boundaries, but in a video each chunk gets its own animation so
 * the slight overlap reads as motion rather than misalignment.
 */
const MAX_OUTPUT_ASPECT = 2.0; // H / W

function forceSplitTallSlices(
  slices: SliceRect[],
  minChunkHeight: number,
): SliceRect[] {
  const out: SliceRect[] = [];
  for (const s of slices) {
    const aspect = s.height / s.width;
    if (aspect <= MAX_OUTPUT_ASPECT) {
      out.push(s);
      continue;
    }
    // Target chunk aspect of 1.5:1 (taller than square, less than 2:1).
    const targetChunkH = Math.max(minChunkHeight, Math.floor(s.width * 1.5));
    const nChunks = Math.min(8, Math.max(2, Math.round(s.height / targetChunkH)));
    const chunkH = Math.floor(s.height / nChunks);
    for (let i = 0; i < nChunks; i++) {
      const isLast = i === nChunks - 1;
      out.push({
        x: s.x,
        y: s.y + i * chunkH,
        width: s.width,
        // Last chunk eats any remainder so we don't lose pixels to
        // floor rounding.
        height: isLast ? s.height - i * chunkH : chunkH,
      });
    }
  }
  return out;
}

/**
 * True when 90%+ of the slice's sampled pixels are within tolerance
 * of the background colour — i.e. effectively an empty gutter strip
 * that survived slicing. The 0012 stripe in earlier test output is
 * the case this kills.
 */
function isSliceMostlyBlank(
  data: Uint8ClampedArray,
  W: number,
  slice: SliceRect,
  bg: RGB,
): boolean {
  const x0 = slice.x;
  const x1 = slice.x + slice.width;
  const y0 = slice.y;
  const y1 = slice.y + slice.height;
  const stepX = Math.max(4, Math.floor(slice.width / 60));
  const stepY = Math.max(4, Math.floor(slice.height / 60));
  let matches = 0;
  let total = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * W + x) * 4;
      const dr = Math.abs(data[i] - bg.r);
      const dg = Math.abs(data[i + 1] - bg.g);
      const db = Math.abs(data[i + 2] - bg.b);
      if (dr <= 50 && dg <= 50 && db <= 50) matches++;
      total++;
    }
  }
  return total > 0 && matches / total >= 0.9;
}
