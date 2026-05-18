// Browser-side PDF → JPEG extraction using PDF.js.
//
// Renders each page to an off-screen <canvas> at the requested scale,
// then encodes it as JPEG and wraps the resulting bytes in an
// ``ExtractedPage``. Reports per-page progress via the optional
// callback so the UI can show a live progress bar.

import * as pdfjsLib from "pdfjs-dist";
// `?url` is a Vite-specific import that returns a URL to the asset.
// PDF.js needs its worker on a separate thread; we just hand it the URL.
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

import type { ExtractedPage } from "../types/manhwa";
import { sliceCanvasIntoPanels, type SliceOptions } from "./panelSlicer";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface ExtractOptions {
  /**
   * Render scale relative to the PDF's intrinsic size.
   * Roughly: ``scale = dpi / 72``. ``2.0`` ≈ 144 DPI, plenty for
   * Gemini Vision + filler-hash. Bump to ``2.78`` for ~200 DPI if
   * Gemini misreads dense text panels.
   */
  scale?: number;
  /** JPEG quality 0–1. ``0.85`` is the small-file / clean-look sweet spot. */
  quality?: number;
  /** Fires once per finished page; both args are 1-based. */
  onProgress?: (current: number, total: number) => void;
  /**
   * Slice tall PDF pages into individual panels (webtoon-format support).
   * Pass ``false`` to keep the old 1-page = 1-image behaviour. Pass an
   * object to override slicer thresholds (aspect ratio, gutter height,
   * etc.). Default = enabled with sensible webtoon defaults.
   */
  slicePanels?: boolean | SliceOptions;
}

/**
 * Extract every page of ``file`` to an in-memory JPEG.
 *
 * Memory profile: each page holds onto a ~500 KB Blob and an ImageBitmap
 * object URL. The intermediate render canvas is released immediately
 * (its width/height are set to 0 after use). For a 250-page chapter,
 * peak memory is ~125 MB while extracting and then steady-state at the
 * same ~125 MB until the caller calls ``revokeExtractedPages``.
 */
export async function extractPdfPages(
  file: File,
  options: ExtractOptions = {},
): Promise<ExtractedPage[]> {
  const {
    scale = 2.0,
    quality = 0.85,
    onProgress,
    slicePanels = true,
  } = options;

  // Normalise the slice config — `true` → defaults, object → overrides,
  // `false` → off (preserves 1-page-per-image behaviour for legacy callers).
  const sliceOpts: SliceOptions | null =
    slicePanels === false
      ? null
      : slicePanels === true
        ? {}
        : slicePanels;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: ExtractedPage[] = [];

  // Running 1-based index across ALL panels in the document. With slicing
  // enabled this is bigger than ``pdf.numPages`` for webtoon-format PDFs.
  // Downstream code (curator, manifest) uses this as the unique panel id.
  let panelIndex = 0;

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas context unavailable in this browser");

      await page.render({
        canvasContext: ctx,
        viewport,
      }).promise;

      // Decide slice rectangles. With slicing disabled OR a non-webtoon
      // (square-ish) page, this returns a single full-canvas rect — same
      // output as the old code path.
      const slices = sliceOpts
        ? sliceCanvasIntoPanels(canvas, sliceOpts)
        : [{ x: 0, y: 0, width: canvas.width, height: canvas.height }];

      for (const rect of slices) {
        panelIndex++;
        // Reuse a single scratch canvas per slice — `drawImage` is cheap;
        // creating per-slice canvases would balloon memory on tall pages
        // with 10+ panels.
        const sliceCanvas =
          slices.length === 1
            ? canvas // fast path: whole page = whole slice
            : (() => {
                const c = document.createElement("canvas");
                c.width = rect.width;
                c.height = rect.height;
                const sctx = c.getContext("2d");
                if (!sctx) throw new Error("2D context unavailable for slice");
                sctx.drawImage(
                  canvas,
                  rect.x,
                  rect.y,
                  rect.width,
                  rect.height,
                  0,
                  0,
                  rect.width,
                  rect.height,
                );
                return c;
              })();

        const blob = await canvasToJpegBlob(sliceCanvas, quality);
        const url = URL.createObjectURL(blob);

        pages.push({
          index: panelIndex,
          width: rect.width,
          height: rect.height,
          blob,
          url,
        });

        // Release the per-slice scratch canvas (if any).
        if (sliceCanvas !== canvas) {
          sliceCanvas.width = 0;
          sliceCanvas.height = 0;
        }
      }

      // Free the canvas backing store immediately; some browsers
      // (notably Safari) hold onto it otherwise.
      canvas.width = 0;
      canvas.height = 0;

      // Release the page's PDF.js internals — keeps RAM flat across long docs.
      page.cleanup();

      onProgress?.(i, pdf.numPages);
    }
  } finally {
    await pdf.destroy();
  }

  return pages;
}

/** Wrap ``canvas.toBlob`` in a promise so it composes with ``await``. */
function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob returned null"));
      },
      "image/jpeg",
      quality,
    );
  });
}

/**
 * Release the object URLs held by a batch of extracted pages.
 *
 * Browsers won't garbage-collect the underlying Blob memory until every
 * URL referencing it is revoked. Call this when navigating away from a
 * chapter or starting a fresh extraction.
 */
export function revokeExtractedPages(pages: ExtractedPage[]): void {
  for (const p of pages) {
    URL.revokeObjectURL(p.url);
  }
}
