// Group a flat list of kept panels into scene-sized chunks.
//
// We don't ask Gemini to detect scenes — that would burn an extra call
// per chapter for a problem that a simple ~6-panels-per-scene rule
// solves just as well. The narrator step then turns each chunk into a
// coherent paragraph of N sentences (one per panel) so the 1:1
// panel↔line sync invariant survives.
//
// The chunker tries to keep chunk sizes balanced so the last chunk
// isn't an awkward singleton. For example 43 panels at ideal=6 →
// seven chunks of (7,6,6,6,6,6,6), not (6,6,6,6,6,6,6,1).

import type { FilteredPage } from "../types/manhwa";

export interface ChunkerOptions {
  /** Target panels per scene. 6 is a good default for YouTube-style pacing. */
  idealSize?: number;
}

/**
 * Split ``pages`` into a sequence of scene-sized arrays.
 *
 * Returns at least one chunk (the input itself) even if ``pages`` is
 * smaller than ``idealSize``. Preserves the input order — chunks are
 * contiguous slices of ``pages``.
 */
export function chunkIntoScenes(
  pages: FilteredPage[],
  { idealSize = 6 }: ChunkerOptions = {},
): FilteredPage[][] {
  if (pages.length === 0) return [];
  if (pages.length <= idealSize) return [pages];

  // Round to nearest so 7-panel chapters become 1 chunk (not 2).
  const numChunks = Math.max(1, Math.round(pages.length / idealSize));
  const baseSize = Math.floor(pages.length / numChunks);
  const remainder = pages.length % numChunks;

  const chunks: FilteredPage[][] = [];
  let idx = 0;
  for (let i = 0; i < numChunks; i++) {
    // Distribute the remainder across the first ``remainder`` chunks
    // so any "extra" panels land at the start (not as a lone trailing one).
    const size = baseSize + (i < remainder ? 1 : 0);
    chunks.push(pages.slice(idx, idx + size));
    idx += size;
  }
  return chunks;
}
