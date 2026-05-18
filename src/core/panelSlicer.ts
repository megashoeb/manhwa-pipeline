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
  minAspectRatio: 2.5,
  minGutterHeight: 20,
  minPanelHeight: 400,
  colorTolerance: 25,
  blankRowThreshold: 0.95,
  sampleStep: 4,
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
 * strip (preserves traditional manga behaviour). Otherwise returns one
 * rectangle per detected panel, in top-to-bottom order.
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

  // -- 2. Detect background color from corner/edge samples ---------
  const bg = detectBackgroundColor(ctx, W, H);

  // -- 3. Read the full image once (vastly faster than per-row reads)
  const imageData = ctx.getImageData(0, 0, W, H);
  const data = imageData.data; // Uint8ClampedArray length W*H*4

  // -- 4. Mark each row as blank / content -------------------------
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

  // -- 5. Find gutter runs + slice -----------------------------------
  // Walk top-to-bottom. Track current panel start. When we hit a
  // qualifying gutter run, close the current panel at the gutter's
  // midpoint and start the next panel after it.
  const slices: SliceRect[] = [];
  let panelStart = 0;
  let blankStart = -1;

  for (let y = 0; y < H; y++) {
    if (blankRows[y]) {
      if (blankStart < 0) blankStart = y;
      continue;
    }
    // Row is content. Did we just finish a blank run?
    if (blankStart >= 0) {
      const blankLen = y - blankStart;
      if (blankLen >= opts.minGutterHeight) {
        const cutY = Math.floor((blankStart + y) / 2);
        const sliceH = cutY - panelStart;
        if (sliceH >= opts.minPanelHeight) {
          slices.push({ x: 0, y: panelStart, width: W, height: sliceH });
          panelStart = cutY;
        }
        // Sub-min slice: don't push; the small chunk will be absorbed
        // into the NEXT panel (panelStart stays where it was).
      }
      blankStart = -1;
    }
  }

  // Tail panel from panelStart to H. If it's too short and we already
  // have at least one slice, merge it into the previous one rather
  // than emit a sliver.
  const tailH = H - panelStart;
  if (tailH >= opts.minPanelHeight || slices.length === 0) {
    slices.push({ x: 0, y: panelStart, width: W, height: tailH });
  } else {
    slices[slices.length - 1].height += tailH;
  }

  // Trim leading/trailing whitespace within each slice so each output
  // image is tightly cropped to its panel content. Saves bytes and
  // keeps thumbnails clean.
  return slices.map((s) => trimSliceToContent(s, blankRows));
}

/**
 * Sample 8 edge pixels and average them. Robust enough for the simple
 * "is the gutter white or black" question we're asking. We average in
 * RGB space; for nuanced cases (sepia tones, gradients) the
 * ``colorTolerance`` setting picks up the slack.
 */
function detectBackgroundColor(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  W: number,
  H: number,
): RGB {
  const xs = [0, Math.floor(W / 2), W - 1];
  const ys = [0, Math.floor(H / 2), H - 1];
  // Use 6 edge-only points (skip the center; it's almost never gutter).
  const samples: Array<[number, number]> = [
    [xs[0], ys[0]],
    [xs[2], ys[0]],
    [xs[0], ys[2]],
    [xs[2], ys[2]],
    [xs[1], ys[0]],
    [xs[1], ys[2]],
  ];
  let r = 0,
    g = 0,
    b = 0;
  for (const [x, y] of samples) {
    const d = ctx.getImageData(x, y, 1, 1).data;
    r += d[0];
    g += d[1];
    b += d[2];
  }
  const n = samples.length;
  return {
    r: Math.round(r / n),
    g: Math.round(g / n),
    b: Math.round(b / n),
  };
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
