// Per-stage timing measurement for the bulk pipeline.
//
// Spec § 6 acceptance criterion: log seconds in extract / classify /
// 3A / 3B / polish per chapter so the user can spot bottlenecks
// before they bite at 100-chapter scale.
//
// We use ``performance.now()`` (millisecond resolution, monotonic in
// browsers) and report milliseconds. Each stage's measurement
// includes its own retries and network waits — the goal is wall-clock
// time spent on that stage, not just the "happy path" call duration.

export interface ChapterTiming {
  /** Wall-clock ms in Stage 1: PDF → image extraction. */
  extract_ms: number;
  /** Wall-clock ms in the local image filter pipeline (crop+blank+phash). */
  filter_ms: number;
  /** Wall-clock ms in Stage 4a: character bible extraction. */
  bible_ms: number;
  /** Wall-clock ms in Stage 2: AI panel classifier (sum of all parallel batches). */
  classify_ms: number;
  /** Wall-clock ms in Stage 3A: whole-chapter comprehension. */
  comprehend_ms: number;
  /** Wall-clock ms in Stage 3B: beat segmentation. */
  segment_ms: number;
  /** Wall-clock ms in Stage 5: polish pass (incl. retry if fired). */
  polish_ms: number;
  /** Wall-clock ms across all stages for this chapter. */
  total_ms: number;
}

export const EMPTY_TIMING: ChapterTiming = {
  extract_ms: 0,
  filter_ms: 0,
  bible_ms: 0,
  classify_ms: 0,
  comprehend_ms: 0,
  segment_ms: 0,
  polish_ms: 0,
  total_ms: 0,
};

/** Start a stopwatch — returns a function that stops and returns ms. */
export function stopwatch(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}

/**
 * Pretty-format a ChapterTiming for console / README output.
 *
 * Example:
 *   "extract 8.2s | filter 4.1s | bible 3.5s | classify 6.0s | 3A 7.1s | 3B 5.4s | polish 11.3s | total 45.6s"
 */
export function formatTiming(t: ChapterTiming): string {
  const s = (ms: number) => (ms / 1000).toFixed(1) + "s";
  return [
    `extract ${s(t.extract_ms)}`,
    `filter ${s(t.filter_ms)}`,
    `bible ${s(t.bible_ms)}`,
    `classify ${s(t.classify_ms)}`,
    `3A ${s(t.comprehend_ms)}`,
    `3B ${s(t.segment_ms)}`,
    `polish ${s(t.polish_ms)}`,
    `total ${s(t.total_ms)}`,
  ].join(" | ");
}
