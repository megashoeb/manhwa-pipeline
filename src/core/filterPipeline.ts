// Filter pipeline orchestrator — wraps crop + blank + phash dedup.
//
// Mirrors ``stages/s3_dedupe.py`` from the Python reference: for each
// page we (1) crop margins, (2) check blank, (3) phash dedup against
// the previous N kept pages. Returns annotated ``FilteredPage`` records
// so the UI can show why each page was kept or dropped.

import type {
  ExtractedPage,
  FilteredPage,
  FilterResult,
  FilterSettings,
} from "../types/manhwa";

import { cropBlobMargins } from "./cropMargins";
import { checkBlank } from "./blankDetector";
import { computePHash, hammingDistance } from "./phash";

/** Progress callback signature — fires once per processed page. */
export type ProgressCb = (current: number, total: number, msg: string) => void;

/**
 * Run the full filter pipeline over a batch of extracted pages.
 *
 * Memory: produces NEW Blob objects for the cropped output rather than
 * mutating ``pages`` in place. The caller (App) is responsible for
 * revoking the previous filter result's object URLs before applying a
 * new ``FilterSettings``.
 */
export async function runFilterPipeline(
  pages: ExtractedPage[],
  settings: FilterSettings,
  onProgress?: ProgressCb,
): Promise<FilterResult> {
  // Tracks the phashes of the most recent KEPT pages so we can compare
  // upcoming pages against them within the configured lookback window.
  const recent: Array<{ hash: bigint; pageIndex: number }> = [];

  const filtered: FilteredPage[] = [];
  let droppedBlank = 0;
  let droppedDuplicate = 0;

  for (let i = 0; i < pages.length; i++) {
    const src = pages[i];
    onProgress?.(i + 1, pages.length, "Filtering");

    // ---- Step 1: crop margins ----
    const cropped = await cropBlobMargins(
      src.blob,
      settings.cropTopPct,
      settings.cropBottomPct,
    );

    // ---- Step 2: blank check ----
    let blankSummary = "";
    if (settings.blankStddev > 0) {
      const { isBlank, stddev, mean } = await checkBlank(
        cropped.blob,
        settings.blankStddev,
        settings.blankMean,
      );
      blankSummary = `stddev=${stddev.toFixed(1)}, mean=${mean.toFixed(1)}`;
      if (isBlank) {
        filtered.push({
          index: src.index,
          width: cropped.width,
          height: cropped.height,
          blob: cropped.blob,
          url: URL.createObjectURL(cropped.blob),
          kept: false,
          reason: `blank page (${blankSummary} < ${settings.blankStddev}/${settings.blankMean})`,
          phash: "",
        });
        droppedBlank++;
        continue;
      }
    }

    // ---- Step 3: phash dedup ----
    const hash = await computePHash(cropped.blob);
    let match: { pageIndex: number; distance: number } | null = null;
    const lookback = Math.max(1, settings.dedupeLookback);
    // Walk the most-recent kept pages backwards (most-recent first).
    for (let j = recent.length - 1; j >= Math.max(0, recent.length - lookback); j--) {
      const prev = recent[j];
      const dist = hammingDistance(hash, prev.hash);
      if (dist <= settings.dedupeThreshold) {
        match = { pageIndex: prev.pageIndex, distance: dist };
        break;
      }
    }

    if (match) {
      filtered.push({
        index: src.index,
        width: cropped.width,
        height: cropped.height,
        blob: cropped.blob,
        url: URL.createObjectURL(cropped.blob),
        kept: false,
        reason: `duplicate of page ${match.pageIndex} (dist=${match.distance})`,
        phash: hash.toString(16),
      });
      droppedDuplicate++;
    } else {
      recent.push({ hash, pageIndex: src.index });
      filtered.push({
        index: src.index,
        width: cropped.width,
        height: cropped.height,
        blob: cropped.blob,
        url: URL.createObjectURL(cropped.blob),
        kept: true,
        reason: i === 0 ? "first page" : "kept",
        phash: hash.toString(16),
      });
    }
  }

  return {
    pages: filtered,
    stats: {
      total: pages.length,
      kept: filtered.filter((p) => p.kept).length,
      droppedBlank,
      droppedDuplicate,
    },
  };
}

/** Release all object URLs held by a filter result. */
export function revokeFilterResult(result: FilterResult | null): void {
  if (!result) return;
  for (const p of result.pages) {
    URL.revokeObjectURL(p.url);
  }
}
