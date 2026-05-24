// Bulk-queue orchestrator — runs the full pipeline against many PDFs.
//
// Designed for 30-40 chapter overnight runs. Key properties:
//
//   • SEQUENTIAL processing — one chapter at a time. The browser only
//     ever holds one chapter's pages in memory at once, so RAM stays
//     flat even at large scales.
//
//   • Master bible threaded through — every chapter after the first
//     gets the cumulative master bible as context, so character names
//     stay consistent across the whole series.
//
//   • Auto-ZIP-and-download per chapter — finished outputs land in the
//     user's Downloads folder as they complete, so even if the run is
//     cancelled mid-queue, finished chapters are already saved.
//
//   • Per-item failure isolation — a corrupt PDF or a Gemini safety
//     refusal on chapter 7 doesn't kill chapters 8-40; the failure
//     gets recorded on item 7 and the loop continues.

import {
  extractPdfPages,
  revokeExtractedPages,
} from "./pdfToImages";
import {
  runFilterPipeline,
  revokeFilterResult,
} from "./filterPipeline";
import {
  applyTitlePageExclusions,
  generateScript,
} from "./scriptPipeline";
import { downloadFullOutputs } from "./downloads";
import {
  downloadCombinedRecap,
  type CombinedChapterEntry,
} from "./combinedDownload";
import type { CuratorTierLog, PanelScore } from "./panelCurator";
import type { QualityWarning } from "./qualityScan";
import {
  asCharacterBible,
  loadMasterBible,
  mergeBible,
  saveMasterBible,
} from "./masterBible";
import { generateBridgeSentence } from "./continuityBridge";
import { MODEL_TIERS } from "./modelTiers";
import {
  type ChapterTiming,
  EMPTY_TIMING,
  formatTiming,
  stopwatch,
} from "./stageTiming";
import {
  deleteSession,
  fingerprintFile,
  loadCheckpoints,
  newSessionId,
  saveCheckpoint,
  saveSession,
} from "./sessionStore";
import {
  appendChaptersToSeries,
  loadSeries,
  updateSeries,
} from "./seriesStore";

import type {
  CharacterBible,
  FilterSettings,
  MasterBible,
  PipelineStage,
  QueueItem,
} from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

export interface BulkProgressUpdate {
  itemIndex: number;
  stage: PipelineStage;
  current: number;
  total: number;
  message: string;
}

/**
 * Cooperative pause primitive. Workers in the bulk pipeline call
 * ``waitWhilePaused()`` between chapters (and during retry backoffs);
 * the UI controls ``pause()`` / ``resume()`` from its Pause/Resume
 * buttons.
 *
 * Pause is between-chapter — an in-flight chapter finishes its current
 * pipeline stage before the worker idles. This avoids:
 *   1. Wasted Gemini calls (a half-processed chapter throws away its
 *      script).
 *   2. Inconsistent checkpoint state (we'd save a partial entry).
 *
 * Resume restarts ALL waiters at once via stored resolve callbacks —
 * no polling, no setTimeout dance.
 */
export class PauseController {
  private paused = false;
  private resolvers: Array<() => void> = [];

  /** Mark paused. Subsequent ``waitWhilePaused()`` calls block. */
  pause(): void {
    this.paused = true;
  }

  /** Resume — releases every waiter currently parked on this controller. */
  resume(): void {
    this.paused = false;
    const old = this.resolvers;
    this.resolvers = [];
    for (const r of old) r();
  }

  /** Snapshot of the paused state — read by the UI for label flipping. */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Resolves immediately if not paused. Otherwise returns a Promise
   * that resolves the next time ``resume()`` is called. Workers
   * ``await`` this between chapters; if multiple workers are parked
   * they all release together when the user clicks Resume.
   */
  waitWhilePaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

export interface RunBulkQueueOptions {
  files: File[];
  rotator: KeyRotator;
  model: string;
  filterSettings: FilterSettings;
  /**
   * Long-form recap mode. When ``true``:
   *   • Each chapter runs an additional AI panel-curation stage that
   *     keeps only 10-35 story-driving panels (instead of all ~40-50).
   *   • Per-chapter ZIPs are NOT downloaded individually. Instead,
   *     curated panels + scripts are accumulated in memory until the
   *     queue finishes, then a single combined ZIP is built with flat
   *     ``chapter_NN_panel_MM.jpg`` naming and ONE master script.txt.
   *   • Use case: 70-80 chapters condensed into a single 2-3 hour video.
   */
  longFormRecap?: boolean;
  /**
   * Parallel worker count. When omitted, auto-computed = number of
   * enabled API keys (capped at file count). One key per worker keeps
   * rate-limit contention low and gives roughly N× speedup with N keys.
   *
   * Set to 1 to force fully sequential processing (slower but
   * preserves strict cross-chapter master-bible ordering).
   */
  concurrency?: number;
  /** Called whenever a QueueItem field needs patching (status, timings, etc.). */
  onItemUpdate: (index: number, patch: Partial<QueueItem>) => void;
  /** Fine-grained progress within a single chapter. */
  onProgress: (update: BulkProgressUpdate) => void;
  /** Fired after each chapter completes and the master bible is merged. */
  onMasterBibleUpdate: (bible: MasterBible) => void;
  /**
   * Fired with the final combined-ZIP blob + filename right before
   * the auto-download triggers. Lets the UI store a reference so the
   * user can click a "Download again" button later. Only fires in
   * long-form mode (no combined ZIP in single-chapter mode).
   */
  onArchiveReady?: (blob: Blob, filename: string) => void;
  /**
   * Per-chapter ZIP delivery in NORMAL (non-long-form) mode. When
   * provided, the chapter's ZIP blob is surfaced through this
   * callback instead of being auto-downloaded — the UI can stash
   * each blob and offer manual "Download chapter N" buttons. When
   * omitted, per-chapter ZIPs auto-download as before.
   */
  onChapterArchive?: (
    fileIndex: number,
    blob: Blob,
    filename: string,
  ) => void;
  /** Lets the UI display which API key handled the current request. */
  onKeyUsed?: (masked: string) => void;
  /** Aborted between chapters (mid-chapter aborts are not supported). */
  abortSignal: AbortSignal;
  /**
   * Resume an existing session by ID. When provided, completed
   * chapters are loaded from IndexedDB and skipped — only the
   * remaining files in the queue are processed. When omitted, a
   * fresh session is created and checkpointed after every chapter
   * for power-cut recovery.
   */
  sessionId?: string;
  /**
   * Append this batch's chapters to the given series instead of
   * triggering a combined ZIP download. Used by the "Add to series"
   * UI toggle — lets the user accumulate a 50-chapter project across
   * multiple processing sessions over days/weeks, then finalize once
   * via the "Finalize series" button (which produces the mega-ZIP
   * with AI-generated outro). Long-form mode only.
   */
  appendToSeriesId?: string;
  /**
   * Optional pause controller. When provided, workers will idle
   * between chapters whenever ``pauseController.isPaused`` is true.
   * Pause is cooperative and between-chapter only — the current
   * chapter finishes its pipeline before the worker waits, so no
   * half-processed checkpoint or wasted Gemini call.
   */
  pauseController?: PauseController;
}

/**
 * Run the full pipeline against a queue of PDFs.
 *
 * Returns once every file has been processed (or skipped via abort).
 * Individual chapter failures are surfaced via ``onItemUpdate`` and
 * do not throw — the caller can inspect the queue at the end for a
 * "X of Y succeeded" summary.
 */
export async function runBulkQueue(
  opts: RunBulkQueueOptions,
): Promise<void> {
  const {
    files,
    rotator,
    model,
    filterSettings,
    longFormRecap = false,
    concurrency: concurrencyOverride,
    onItemUpdate,
    onProgress,
    onMasterBibleUpdate,
    onArchiveReady,
    onChapterArchive,
    onKeyUsed,
    abortSignal,
    sessionId: resumedSessionId,
    appendToSeriesId,
    pauseController,
  } = opts;

  let masterBible = loadMasterBible();

  // --- Session checkpointing setup ---------------------------------
  // Either resume an existing session (caller passes ``sessionId``) or
  // create a fresh one. The session record + per-chapter checkpoints
  // live in IndexedDB so a power cut mid-run doesn't waste completed
  // work — on restart we pre-populate ``accumulated[]`` from saved
  // checkpoints and the chapter loop simply skips them.
  const sessionId = resumedSessionId ?? newSessionId();
  const sessionMeta = {
    id: sessionId,
    startedAt: Date.now(),
    pdfFingerprints: files.map(fingerprintFile),
    options: {
      longFormRecap,
      concurrency: concurrencyOverride,
    },
    isComplete: false,
    checkpointCount: 0,
  };
  await saveSession(sessionMeta).catch((err) =>
    console.warn("Session save failed (continuing without checkpoints):", err),
  );

  // Bumps the session metadata after each successful checkpoint so
  // the resume banner always reflects the LATEST progress. The lock
  // chain ensures two parallel workers don't race-overwrite each
  // other's count.
  let sessionMetaLock: Promise<unknown> = Promise.resolve();
  const bumpSessionMeta = async (newCount: number): Promise<void> => {
    await sessionMetaLock;
    sessionMetaLock = (async () => {
      try {
        sessionMeta.checkpointCount = Math.max(
          sessionMeta.checkpointCount,
          newCount,
        );
        await saveSession({ ...sessionMeta });
      } catch (err) {
        console.warn("Session metadata bump failed:", err);
      }
    })();
    await sessionMetaLock;
  };

  // SLOT-INDEXED accumulator preserves chapter ORDER regardless of
  // which worker finishes first in parallel mode. ``accumulated[i]``
  // is the entry for file index ``i``; undefined slots are skipped
  // failures or aborts.
  const accumulated: (CombinedChapterEntry | undefined)[] = new Array(
    files.length,
  );

  // Best-effort previous-chapter hook. In sequential mode this is the
  // exact previous chapter. In parallel mode it's the most-recently-
  // completed chapter at the moment a new chapter starts — close
  // enough to keep hook templates from cloning, which is the goal.
  let lastCompletedHook = "";

  // Cross-chapter ROLLING_CONTEXT handoff — last 4 polished beats of
  // the previously-completed chapter, joined with double newlines.
  // The next chapter's narrator seeds its first scene with this so
  // narration continues seamlessly instead of restarting cold.
  let lastCompletedTail = "";

  // --- Resume: pre-populate from checkpoints if applicable ---------
  if (resumedSessionId) {
    try {
      const checkpoints = await loadCheckpoints(resumedSessionId);
      const sortedChapterNums = [...checkpoints.keys()].sort((a, b) => a - b);
      for (const chapNum of sortedChapterNums) {
        const entry = checkpoints.get(chapNum)!;
        const slot = chapNum - 1;
        if (slot < 0 || slot >= accumulated.length) continue;
        accumulated[slot] = entry;
        // Notify UI so the queue row immediately renders as "done"
        // instead of "waiting" — feels like an instant skip.
        onItemUpdate(slot, {
          status: "done",
          stage: "done",
          keptCount: entry.blobs.length,
          lineCount: entry.script.lines.length,
          finishedAt: Date.now(),
        });
      }
      // Seed lastCompletedHook/Tail from the highest-numbered
      // checkpoint so the next freshly-processed chapter continues
      // its narrative smoothly instead of restarting cold.
      if (sortedChapterNums.length > 0) {
        const lastNum = sortedChapterNums[sortedChapterNums.length - 1];
        const lastEntry = checkpoints.get(lastNum)!;
        if (lastEntry.script.lines.length > 0) {
          lastCompletedHook = lastEntry.script.lines[0] ?? "";
          lastCompletedTail = lastEntry.script.lines.slice(-4).join("\n\n");
        }
      }
      console.log(
        `[RESUME] Loaded ${sortedChapterNums.length} chapter checkpoint(s) from session ${resumedSessionId}`,
      );
    } catch (err) {
      console.warn(
        "Resume failed — proceeding as fresh run. Reason:",
        err,
      );
    }
  }

  // Pipeline-overlap prefetch cache. When a worker finishes a chapter
  // it speculatively starts extraction of its NEXT likely chapter
  // (current index + concurrency). The next time a worker claims
  // chapter N, extraction is already done or in-flight — saving 1-2 min
  // per chapter on big runs. Memory cost: ~50-150 MB held in-flight
  // (1-2 chapters' page blobs), manageable on modern browsers.
  //
  // Values are PROMISES so concurrent callers asking for the same
  // chapter share one extraction instead of double-running it.
  const pageCache = new Map<
    number,
    Promise<Awaited<ReturnType<typeof extractPdfPages>>>
  >();

  const getOrPrefetchPages = (
    i: number,
    withProgress: boolean,
  ): Promise<Awaited<ReturnType<typeof extractPdfPages>>> => {
    const cached = pageCache.get(i);
    if (cached) return cached;
    const extractScale = longFormRecap ? 2.78 : 2.0;
    const promise = extractPdfPages(files[i], {
      scale: extractScale,
      quality: 0.85,
      // Prefetches run silently (no UI noise — they're speculative).
      // Real consumption shows progress events normally.
      onProgress: withProgress
        ? (current, total) =>
            onProgress({
              itemIndex: i,
              stage: "extracting",
              current,
              total,
              message: `Extracting ${files[i].name}`,
            })
        : undefined,
    });
    pageCache.set(i, promise);
    return promise;
  };

  // Atomic master-bible commit via a chained promise lock. JS is
  // single-threaded so there's no true race, but multiple workers
  // can interleave at ``await`` points — the lock ensures every
  // commit reads the latest state, merges, and writes back without
  // another commit slipping in mid-update.
  let bibleLock: Promise<unknown> = Promise.resolve();
  const commitBible = async (
    newBible: CharacterBible,
    fileName: string,
  ): Promise<void> => {
    await bibleLock;
    bibleLock = (async () => {
      masterBible = mergeBible(masterBible, newBible, fileName);
      saveMasterBible(masterBible);
      onMasterBibleUpdate(masterBible);
    })();
    await bibleLock;
  };

  // Concurrency — DEFAULT 1 (sequential per-chapter) for spec
  // compliance. Sequential is required for cross-chapter continuity
  // handoff: chapter N+1's narrator needs chapter N's last 4 beats
  // as ROLLING_CONTEXT, and chapter N+1's polish needs chapter N's
  // polished tail as PREV_TAIL. Parallel processing would break both.
  //
  // Multiple keys are still useful — they rotate within sequential
  // processing for quota distribution (free Gemini 500 RPD per key
  // × N keys = N× headroom).
  //
  // The override lets advanced users force parallelism, but at the
  // cost of continuity quality. Most users should leave it default.
  //
  // HARD MEMORY CAP: even when the override says 10, we cap at
  // MEMORY_SAFE_MAX_CONCURRENCY. Browser/Electron memory is the
  // bottleneck, NOT API quota — a 25-chapter run with concurrency=10
  // was peaking at 19 GB RAM on the user's Mac (PDF.js heaps + raw
  // canvases + accumulated blobs all live simultaneously). Cap of 3
  // keeps peak under ~3-4 GB while still giving a healthy speedup.
  const MEMORY_SAFE_MAX_CONCURRENCY = 3;
  const concurrency = Math.max(
    1,
    Math.min(
      concurrencyOverride ?? 1,
      Math.max(1, files.length),
      MEMORY_SAFE_MAX_CONCURRENCY,
    ),
  );

  // Shared claim counter — workers atomically grab the next file
  // index. JS single-threaded so ``nextClaim++`` is safe between
  // ``await`` points.
  let nextClaim = 0;
  const claimNext = (): number => {
    if (abortSignal.aborted) return -1;
    if (nextClaim >= files.length) return -1;
    return nextClaim++;
  };

  // Per-chapter processing — same logic as the old sequential loop,
  // now callable from any worker. ``i`` is the file-index slot.
  //
  // Wrapped in a 4-attempt retry loop (initial + 3 retries with
  // 30s/90s/180s backoff between attempts) so transient Gemini
  // failures don't kill the chapter for the whole bulk run. Common
  // recoverable failures: 429 rate limit cascades, 503 model
  // overload, network timeouts caught by geminiClient's 180s
  // AbortController, JSON parse failures from a flaky response.
  // Aggressive backoffs (was 30s/90s/180s = up to 5 min wasted per
  // failed chapter). With OpenRouter paid + Qwen3.5-Flash + the
  // jsonRepair layer, most failures are now transient network blips
  // that clear within seconds, not provider quota exhaustion.
  const CHAPTER_RETRY_BACKOFFS_MS = [5_000, 15_000, 30_000];
  const CHAPTER_MAX_ATTEMPTS = CHAPTER_RETRY_BACKOFFS_MS.length + 1;
  const processChapter = async (i: number): Promise<void> => {
    // Skip chapters already loaded from a resumed session's checkpoints.
    // The UI was notified of their "done" status during the resume
    // bootstrap; nothing else to do here.
    if (accumulated[i]) {
      return;
    }

    let lastErr: unknown = null;
    let succeeded = false;

    for (let attempt = 0; attempt < CHAPTER_MAX_ATTEMPTS; attempt++) {
      if (abortSignal.aborted) return;
      // Backoff sleep before retry attempts (not before the first one).
      // Sleeps in 1-second slices so abort signal stays responsive.
      if (attempt > 0) {
        const delayMs = CHAPTER_RETRY_BACKOFFS_MS[attempt - 1];
        onProgress({
          itemIndex: i,
          stage: "extracting",
          current: 0,
          total: 0,
          message:
            `Chapter ${i + 1} failed — retrying in ${delayMs / 1000}s ` +
            `(attempt ${attempt + 1}/${CHAPTER_MAX_ATTEMPTS})`,
        });
        // Sleep in 1s slices so abort signal stays responsive.
        // If the user clicks Pause during the backoff, the paused
        // duration does NOT count against ``delayMs`` — when they
        // hit Resume the backoff continues from where it left off,
        // so the rate-limit cooldown still gets its full elapsed
        // wall-clock (otherwise pause would be a free quota bypass).
        let elapsed = 0;
        while (elapsed < delayMs) {
          if (abortSignal.aborted) return;
          if (pauseController) await pauseController.waitWhilePaused();
          if (abortSignal.aborted) return;
          const sliceStart = Date.now();
          await new Promise((r) => setTimeout(r, 1000));
          elapsed += Date.now() - sliceStart;
        }
      }

      const file = files[i];
    // Snapshot at claim time. In sequential mode (default for spec)
    // these are the strict previous chapter's values. In parallel
    // mode they're best-effort from whichever sibling chapter
    // completed last.
    const previousChapterHook = lastCompletedHook;
    const previousChapterTail = lastCompletedTail;
    // CRITICAL: use FILE INDEX not completedCount. In parallel mode
    // every worker starts with completedCount=0, so the old logic
    // made EVERY chapter think it was the first → every chapter
    // added a hook. File index is stable across parallel scheduling:
    // file index 0 is always the first chapter regardless of when
    // it runs.
    const isFirstChapter = i === 0;

    onItemUpdate(i, {
      status: "processing",
      startedAt: Date.now(),
      stage: "extracting",
      error: undefined,
    });

    let pages: Awaited<ReturnType<typeof extractPdfPages>> | null = null;
    let filterResult: Awaited<ReturnType<typeof runFilterPipeline>> | null = null;
    // Per-chapter curator capture — surfaces into the combined manifest.
    let chapterCuratorScores: PanelScore[] | undefined;
    let chapterCuratorTier: CuratorTierLog | undefined;
    // Per-stage timing (spec § 6 acceptance criterion). bulkQueue fills
    // extract_ms + filter_ms directly; scriptPipeline fires onTiming
    // with the Gemini-side stages and we merge them here.
    const timing: ChapterTiming = { ...EMPTY_TIMING };
    const chapterTimer = stopwatch();
    // If Stage 3B's segmentation fell back to even-splitting (i.e.
    // Gemini couldn't return the right beat count after retry), the
    // 1:1 count is intact but per-panel content alignment is fuzzy.
    // We record the reason here and surface it in the manifest so the
    // user knows which chapters to spot-check first.
    let chapterAlignmentDegraded = false;
    let chapterAlignmentReason = "";
    // Post-process quality warnings (generic references, retention
    // interjections, panel-description leaks, bare quote-dash). Surfaced
    // into the manifest so the user can spot-fix flagged beats without
    // re-running the chapter.
    let chapterQualityWarnings: QualityWarning[] = [];

    try {
      // ---- Stage 1: extract PDF pages -------------------------------
      onProgress({
        itemIndex: i,
        stage: "extracting",
        current: 0,
        total: 0,
        message: `Reading ${file.name}`,
      });
      // Pipeline overlap — speculatively prefetch the IMMEDIATELY
      // NEXT chapter (i + 1). Old code did ``i + concurrency`` ahead
      // which, with concurrency=3 and 3 workers, kept up to ~3
      // chapters' page blobs pinned in the cache in addition to the
      // ones actively being processed. Holding +1 keeps the
      // pipeline-overlap benefit (extraction overlaps Gemini calls)
      // without the memory amplification. Fire-and-forget; prefetch
      // errors are ignored so a bad PDF down the line can't kill
      // this chapter.
      const nextLikelyIndex = i + 1;
      if (nextLikelyIndex < files.length && !pageCache.has(nextLikelyIndex)) {
        getOrPrefetchPages(nextLikelyIndex, false).catch(() => {
          /* ignore prefetch failure; the worker will retry on real consumption */
        });
      }

      // Get pages for THIS chapter. If a previous worker prefetched
      // it (or we did on a previous iteration), this resolves
      // instantly. Otherwise extract proceeds normally with progress.
      const extractTimer = stopwatch();
      onProgress({
        itemIndex: i,
        stage: "extracting",
        current: 0,
        total: 0,
        message: `Reading ${file.name}`,
      });
      pages = await getOrPrefetchPages(i, true);
      // Drop the promise reference from the cache once consumed —
      // ``pages`` is now owned by this chapter and will be revoked in
      // the finally block. Without this delete, the Map would hold
      // stale promises indefinitely.
      pageCache.delete(i);
      timing.extract_ms = extractTimer();

      // ---- Stage 2: filter (crop + blank + phash) -------------------
      onItemUpdate(i, { stage: "filtering" });
      const filterTimer = stopwatch();
      filterResult = await runFilterPipeline(
        pages,
        filterSettings,
        (current, total, message) =>
          onProgress({
            itemIndex: i,
            stage: "filtering",
            current,
            total,
            message,
          }),
      );
      timing.filter_ms = filterTimer();

      // ---- Stage 3: generate script (with master bible as context) -
      onItemUpdate(i, {
        stage: "bible",
        keptCount: filterResult.stats.kept,
      });
      const script = await generateScript(filterResult.pages, {
        model,
        rotator,
        // Only pass previous bible if we actually have one — for the
        // very first chapter we want Gemini to do a fresh extraction
        // (passing an empty bible context would just waste tokens).
        previousBible:
          masterBible.chapterCount > 0 ? asCharacterBible(masterBible) : undefined,
        longFormRecap,
        // Empty for chapter 1; populated from the previous successful
        // chapter. Polish uses hook to avoid template cloning. Tail
        // seeds the narrator's first scene so chapter 2+ continues
        // smoothly from chapter N's last 4 beats (no restart).
        previousChapterHook: previousChapterHook || undefined,
        previousChapterTail: previousChapterTail || undefined,
        // First chapter of THIS bulk run gets the hook; later chapters
        // are forbidden from generating their own (hook uniqueness).
        isFirstChapter,
        // Per-stage models (long-form only). MODEL_TIERS values
        // updated 2026-05-16 to reflect this key's verified-working
        // model access:
        //   curator     → gemini-3.1-flash-lite  (works; spec's 2.0-flash-lite quota-burned today)
        //   3A + 3B     → gemini-2.5-flash       (works; better narration than flash-lite)
        //   polish      → gemini-2.5-flash       (works; spec's 3.1-pro doesn't exist, 2.5-pro quota-burned)
        //   structural  → gemini-2.5-flash       (skipped in long-form anyway)
        // geminiClient's 429/403/404 fallback chain takes over if a
        // primary becomes unavailable mid-run.
        curatorModel: longFormRecap ? MODEL_TIERS.filler : undefined,
        comprehendModel: longFormRecap ? MODEL_TIERS.script : undefined,
        segmentModel: longFormRecap ? MODEL_TIERS.script : undefined,
        polishModel: longFormRecap ? MODEL_TIERS.polish : undefined,
        structuralModel: longFormRecap ? MODEL_TIERS.structural : undefined,
        // Capture curator output for the combined manifest. These
        // surface story_weight + visual_impact + tier so the user can
        // spot-check 10 random beats per chapter.
        onCuratorScores: (scores) => {
          chapterCuratorScores = scores;
        },
        onCuratorTier: (log) => {
          chapterCuratorTier = log;
        },
        // Merge Gemini-side stage timings into our local accumulator.
        // bulkQueue already filled extract_ms + filter_ms above.
        onTiming: (partial) => {
          if (partial.bible_ms != null) timing.bible_ms = partial.bible_ms;
          if (partial.classify_ms != null)
            timing.classify_ms = partial.classify_ms;
          if (partial.comprehend_ms != null)
            timing.comprehend_ms = partial.comprehend_ms;
          if (partial.segment_ms != null)
            timing.segment_ms = partial.segment_ms;
          if (partial.polish_ms != null) timing.polish_ms = partial.polish_ms;
        },
        onAlignmentDegraded: (reason) => {
          chapterAlignmentDegraded = true;
          chapterAlignmentReason = reason;
        },
        onQualityWarnings: (warnings) => {
          chapterQualityWarnings = warnings;
        },
        onProgress: (stage, current, total, message) =>
          onProgress({ itemIndex: i, stage, current, total, message }),
        onKeyUsed,
      });

      // Save THIS chapter's tail + hook for whichever chapter starts
      // next. ``lastCompletedTail`` = last 4 paragraphs joined with
      // double newlines — used as ROLLING_CONTEXT for the next
      // chapter's first scene so narration flows across the boundary.
      // ``lastCompletedHook`` = paragraph 1 — used to ban hook
      // template repetition. In sequential mode both reflect the
      // strict previous chapter; in parallel they're best-effort.
      if (script.lines.length > 0) {
        lastCompletedHook = script.lines[0];
        lastCompletedTail = script.lines.slice(-4).join("\n\n");
      }

      // ---- Stage 4: atomic master-bible commit ---------------------
      // Lock serializes writes across workers so two chapters never
      // race-condition the merge logic.
      await commitBible(script.bible, file.name);

      // ---- Stage 4.5: apply AI-detected title-page exclusions -----
      // These were flagged by Gemini during bible extraction. Trim
      // them from the filterResult so the ZIP doesn't include them.
      const trimmed =
        script.titlePageIndices.length > 0
          ? applyTitlePageExclusions(filterResult, script.titlePageIndices)
          : filterResult;

      // ---- Stage 5: ZIP + download (mode-dependent) ---------------
      if (longFormRecap) {
        // Accumulate this chapter's curated panels and script. The
        // mega-ZIP is built after the loop finishes. Curated panels
        // are the ones referenced by ``script.scenes`` — anything
        // outside that set was dropped by the AI curator at Stage 3.5.
        const curatedSet = new Set(
          script.scenes.flatMap((s) => s.panelIndices),
        );
        const curatedBlobs: Blob[] = [];
        const curatedSourceIndices: number[] = [];
        // Preserve reading order: iterate trimmed.pages in index order
        // (it already is), and pick the ones in curatedSet. We also
        // record the original PDF page index of each kept blob so the
        // combined manifest can show "beat 47 came from chapter 3's
        // page 142" for spot-check debugging.
        for (const p of trimmed.pages) {
          if (p.kept && curatedSet.has(p.index)) {
            curatedBlobs.push(p.blob);
            curatedSourceIndices.push(p.index);
          }
        }
        // Level 3 of the 1:1 recovery chain. By this point both the
        // polish AND the structural editor have validated their own
        // counts (each falls back to unpolished narration on drift),
        // so a mismatch here is truly anomalous — the narrator
        // produced wrong count, or applyTitlePageExclusions removed
        // a panel after curation. ERROR LOUDLY and skip this chapter
        // from the combined output, but DON'T abort the run — chapters
        // 5/100 stay intact even if chapter 47 went sideways.
        if (curatedBlobs.length !== script.lines.length) {
          console.error(
            `❌ 1:1 INVARIANT BROKEN — Chapter ${i + 1} (${file.name}): ` +
              `${curatedBlobs.length} curated panels vs ${script.lines.length} ` +
              `narration lines. Polish retry + unpolished fallback also failed. ` +
              `Skipping this chapter from combined output. ` +
              `Run continues with remaining chapters intact.`,
          );
          onItemUpdate(i, {
            status: "failed",
            stage: "done",
            finishedAt: Date.now(),
            error:
              `1:1 broken — ${curatedBlobs.length} panels vs ${script.lines.length} lines ` +
              `(after polish retry + unpolished fallback). Chapter excluded from combined ZIP.`,
          });
        } else {
          // SLOT-INDEXED assignment (not push) so ``accumulated[i]``
          // sits at this chapter's original position. Filtering later
          // preserves chapter order even when workers finish out of order.
          // Stamp total wall-clock + console-log the per-stage
          // breakdown so the user can spot bottlenecks at 100-chapter
          // scale (spec § 6 acceptance criterion).
          timing.total_ms = chapterTimer();
          console.log(
            `[CHAPTER ${i + 1} TIMING] ${file.name}: ${formatTiming(timing)}`,
          );
          accumulated[i] = {
            chapterIndex: i + 1,
            chapterName: file.name.replace(/\.pdf$/i, ""),
            blobs: curatedBlobs,
            script,
            panelSourceIndices: curatedSourceIndices,
            panelScores: chapterCuratorScores,
            curatorTier: chapterCuratorTier,
            timing,
            alignmentDegraded: chapterAlignmentDegraded,
            alignmentDegradationReason: chapterAlignmentDegraded
              ? chapterAlignmentReason
              : undefined,
            qualityWarnings: chapterQualityWarnings,
          };

          // Persist this chapter to IndexedDB for power-cut recovery.
          // Fire-and-forget — we don't await because IDB writes are
          // <50ms and we don't want to block the worker from claiming
          // the next chapter. If it fails, this chapter just won't be
          // resumable; the run itself continues fine.
          saveCheckpoint(sessionId, i + 1, accumulated[i]!).catch((err) =>
            console.warn(
              `Checkpoint save failed for chapter ${i + 1}:`,
              err,
            ),
          );
          // ALSO bump the session metadata's checkpointCount + bumps
          // updatedAt so the resume banner shows accurate progress even
          // when listing without loading each chapter checkpoint.
          const completedSoFar = accumulated.filter(
            (e) => e !== undefined,
          ).length;
          bumpSessionMeta(completedSoFar).catch(() => {});
          onItemUpdate(i, {
            status: "done",
            stage: "done",
            keptCount: curatedBlobs.length,
            lineCount: script.lines.length,
            finishedAt: Date.now(),
          });
          succeeded = true;
        }
      } else {
        // Standard per-chapter download path.
        onItemUpdate(i, {
          stage: "packaging",
          keptCount: trimmed.stats.kept,
          lineCount: script.lines.length,
        });
        onProgress({
          itemIndex: i,
          stage: "packaging",
          current: 0,
          total: 1,
          message: `Zipping ${file.name}`,
        });
        // When the UI provided ``onChapterArchive``, capture the
        // blob there instead of auto-downloading. This is how the
        // "manual-only download" mode works in BulkMode.
        await downloadFullOutputs(
          trimmed.pages,
          script,
          trimmed.stats,
          file.name,
          onChapterArchive
            ? {
                onArchiveReady: (blob, fname) =>
                  onChapterArchive(i, blob, fname),
              }
            : undefined,
        );

        onItemUpdate(i, {
          status: "done",
          stage: "done",
          finishedAt: Date.now(),
        });
        succeeded = true;
      }
    } catch (err) {
      lastErr = err;
      console.warn(
        `[CHAPTER ${i + 1}] attempt ${attempt + 1}/${CHAPTER_MAX_ATTEMPTS} failed:`,
        err,
      );
      // Safety-filter blocks (status -2) are DETERMINISTIC — the
      // same content will always trigger the same filter. Retrying
      // 3 more times with 30/90/180s backoff just burns 5 minutes
      // for no reason. Break out of the retry loop immediately so
      // the chapter gets marked failed and the queue moves on to
      // the next file. Fallback model was already tried inside
      // geminiClient before this exception escaped.
      const isSafety =
        err != null &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: unknown }).status === -2;
      if (isSafety) {
        try {
          if (filterResult) revokeFilterResult(filterResult);
          if (pages) revokeExtractedPages(pages);
        } catch {
          /* ignore */
        }
        break; // exit retry loop — fall through to "mark failed" below
      }
      // Don't mark failed here — the retry loop will handle final
      // failure marking after all attempts are exhausted.
    } finally {
      // Free this chapter's memory before the next one begins.
      // Catching here so a revoke failure can't strand the queue.
      //
      // Note for long-form mode: revoking URLs does NOT free the
      // underlying Blob objects. The curated Blobs we pushed into
      // ``accumulated`` stay alive as long as that array references
      // them — the browser only GCs them after the final ZIP is
      // built and ``accumulated`` is cleared.
      try {
        if (filterResult) revokeFilterResult(filterResult);
        if (pages) revokeExtractedPages(pages);
      } catch {
        /* ignore */
      }
    }

      if (succeeded) return;
    } // end retry loop

    // All attempts exhausted — mark chapter failed.
    onItemUpdate(i, {
      status: "failed",
      finishedAt: Date.now(),
      error:
        lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown"),
    });
  };

  // ---- Worker pool launch -----------------------------------------
  // ``concurrency`` workers each pull chapters from the shared
  // ``claimNext`` counter until the queue is drained. Per-item
  // failures stay isolated; Promise.all waits for ALL workers.
  //
  // Pause is checked BETWEEN chapters — an in-flight chapter finishes
  // its current pipeline before the worker idles. Means user clicking
  // Pause might still see one or more chapters complete (whichever
  // were mid-stage) before the queue actually stops claiming new ones.
  const worker = async (): Promise<void> => {
    while (true) {
      if (pauseController) {
        await pauseController.waitWhilePaused();
      }
      if (abortSignal.aborted) return;
      const i = claimNext();
      if (i === -1) return;
      await processChapter(i);
    }
  };
  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );

  // ---- Post-loop: combined-ZIP build (long-form mode only) --------
  // Filter out empty slots (failed / not-yet-started chapters). Since
  // ``accumulated`` is index-keyed, ``filter`` returns entries in
  // chapter order — even if workers finished out of order.
  const orderedEntries = accumulated.filter(
    (e): e is CombinedChapterEntry => e !== undefined,
  );

  // ---- Stage 4a: strip residual hook openings (safety net) ---------
  // Polish was told (via ``isFirstChapter=false``) not to add a hook
  // to chapters 2+. This post-process scan is a belt-and-suspenders
  // check that catches any restart that slipped through anyway —
  // patterns like "What if...", "By the end of this video...",
  // "This man just...", etc. Detected restarts get rewritten as a
  // plain continuation so the recap reads as ONE story.
  if (longFormRecap && orderedEntries.length >= 2 && !abortSignal.aborted) {
    for (let b = 1; b < orderedEntries.length; b++) {
      const entry = orderedEntries[b];
      const lines = entry.script.lines;
      if (lines.length === 0) continue;
      const stripped = stripHookOpening(lines[0]);
      if (stripped && stripped !== lines[0]) {
        lines[0] = stripped;
        entry.script.scriptText = lines.join("\n");
        const firstScene = entry.script.scenes[0];
        if (firstScene && firstScene.lines.length > 0) {
          firstScene.lines[0] = stripped;
        }
      }
    }
  }

  // ---- Stage 4: cross-chapter continuity bridges ------------------
  // Generate a 1-sentence bridge between every pair of consecutive
  // chapters and PREPEND it to the next chapter's first paragraph.
  // The 1:1 panel↔paragraph invariant stays intact (no new paragraphs
  // are added; we mutate the existing first paragraph in place).
  //
  // Best-effort: any bridge that fails to generate is silently
  // skipped — the chapter boundary just stays a hard cut for that
  // pair. Never breaks the rest of the pipeline.
  if (longFormRecap && orderedEntries.length >= 2 && !abortSignal.aborted) {
    const totalBridges = orderedEntries.length - 1;
    onProgress({
      itemIndex: -1,
      stage: "bridging",
      current: 0,
      total: totalBridges,
      message: `Stitching ${totalBridges} chapter bridge${totalBridges === 1 ? "" : "s"}…`,
    });
    for (let b = 0; b < totalBridges; b++) {
      if (abortSignal.aborted) break;
      const prevEntry = orderedEntries[b];
      const currEntry = orderedEntries[b + 1];
      const prevLines = prevEntry.script.lines;
      const currLines = currEntry.script.lines;
      if (prevLines.length === 0 || currLines.length === 0) continue;

      const lastBeat = prevLines[prevLines.length - 1];
      const firstBeat = currLines[0];

      const bridge = await generateBridgeSentence(lastBeat, firstBeat, {
        model,
        rotator,
        onKeyUsed,
      });
      if (bridge) {
        // Prepend bridge to first paragraph of the next chapter. Keeps
        // paragraph count unchanged — viewer hears bridge + first beat
        // as one paragraph, no SRT slot drift.
        currLines[0] = `${bridge} ${firstBeat}`;
        currEntry.script.scriptText = currLines.join("\n");
        // Also reflect into the scene the line came from so downstream
        // ``scenes[i].lines`` stays consistent with ``lines``.
        const firstScene = currEntry.script.scenes[0];
        if (firstScene && firstScene.lines.length > 0) {
          firstScene.lines[0] = currLines[0];
        }
      }
      onProgress({
        itemIndex: -1,
        stage: "bridging",
        current: b + 1,
        total: totalBridges,
        message:
          bridge.length > 0
            ? `Bridged chapter ${prevEntry.chapterIndex} → ${currEntry.chapterIndex}`
            : `Bridge skipped for chapter ${prevEntry.chapterIndex} → ${currEntry.chapterIndex}`,
      });
    }
  }

  // Build the combined ZIP whenever ANY chapter succeeded — even if
  // the run was cancelled or some chapters failed. The user can then
  // download the partial output via the manual button. Previously a
  // cancel mid-run threw away the 20 completed chapters' worth of
  // work, which the user explicitly called out as wrong:
  //   "manual download hai na ki maan lo jab error bhi aye tb bhi
  //    download option aaye"
  //
  // We only skip the combined-ZIP build when zero chapters succeeded
  // (nothing to put in the ZIP) OR long-form mode is off (per-chapter
  // mode delivers its own per-chapter ZIPs already).
  if (longFormRecap && orderedEntries.length > 0) {
    const wasAborted = abortSignal.aborted;
    if (appendToSeriesId) {
      // ---- Series-append mode ------------------------------------
      // Don't build a combined ZIP for this batch alone. Instead push
      // the chapters into the named series so a later "Finalize"
      // click can produce the mega-ZIP across ALL accumulated batches
      // (today's 10 + last week's 10 + …). The master bible also
      // gets merged into the series so character continuity carries
      // forward across batches.
      onProgress({
        itemIndex: -1,
        stage: "combining",
        current: 0,
        total: 1,
        message: `Appending ${orderedEntries.length} chapter${
          orderedEntries.length === 1 ? "" : "s"
        } to series…`,
      });
      try {
        const result = await appendChaptersToSeries(
          appendToSeriesId,
          orderedEntries,
        );
        // Persist the latest master bible onto the series so the next
        // batch starts with the accumulated character map intact.
        await updateSeries(appendToSeriesId, { masterBible });
        const series = await loadSeries(appendToSeriesId);
        const title = series?.title ?? "series";
        onProgress({
          itemIndex: -1,
          stage: "done",
          current: 1,
          total: 1,
          message:
            `Added ${result.addedCount} chapter${result.addedCount === 1 ? "" : "s"} to "${title}". ` +
            `Series now has ${result.newTotal} chapter${result.newTotal === 1 ? "" : "s"} — click Finalize when done.`,
        });
        // Session cleanup — this run is complete from the bulkQueue's
        // perspective even though the series isn't finalized yet.
        deleteSession(sessionId).catch((err) =>
          console.warn("Session cleanup failed:", err),
        );
      } catch (err) {
        console.error("Series append failed:", err);
        onProgress({
          itemIndex: -1,
          stage: "done",
          current: 0,
          total: 1,
          message: `Series append failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        throw err;
      } finally {
        accumulated.length = 0;
      }
      return;
    }

    const partialLabel = wasAborted ? "partial " : "";
    onProgress({
      itemIndex: -1,
      stage: "combining",
      current: 0,
      total: 1,
      message:
        `Combining ${orderedEntries.length} ${partialLabel}chapters into one ZIP…` +
        (wasAborted ? " (run was cancelled — saving what we have)" : ""),
    });
    try {
      const outputBase = wasAborted ? "longform_recap_PARTIAL" : "longform_recap";
      await downloadCombinedRecap(orderedEntries, {
        outputName: `${outputBase}_${orderedEntries.length}ch_${Date.now()}`,
        onProgress: (c, t, msg) =>
          onProgress({
            itemIndex: -1,
            stage: "combining",
            current: c,
            total: t,
            message: msg,
          }),
        // Bubble the final blob up to the UI. Auto-download is OFF —
        // the user explicitly asked to disable it; they download
        // manually via the DownloadAgainCard button using this blob.
        onArchiveReady,
        skipAutoDownload: true,
      });
      onProgress({
        itemIndex: -1,
        stage: "done",
        current: 1,
        total: 1,
        message: wasAborted
          ? `Partial ZIP ready — ${orderedEntries.length} chapters saved (run was cancelled). Click Download to save.`
          : `Combined ZIP ready — ${orderedEntries.length} chapters. Click Download to save.`,
      });
      // On a clean (non-aborted) run we wipe the checkpoint data —
      // it served its purpose. On an ABORTED run we KEEP checkpoints
      // so the user can resume next time by re-uploading the same
      // PDFs and picking up from where they stopped.
      if (!wasAborted) {
        deleteSession(sessionId).catch((err) =>
          console.warn("Session cleanup failed:", err),
        );
      }
    } catch (err) {
      // Combined-ZIP failure is loud — the user lost the chance to
      // grab per-chapter ZIPs (they were never created in this mode).
      console.error("Combined ZIP build failed:", err);
      onProgress({
        itemIndex: -1,
        stage: "done",
        current: 0,
        total: 1,
        message: `Combined ZIP failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    } finally {
      // Release Blob references so the browser can GC them.
      accumulated.length = 0;
    }
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Strip hook-style restart openings from a chapter-2+ first paragraph.
 *
 * Polish is instructed not to add hooks to chapters 2+, but Gemini
 * occasionally still produces them. This function detects common
 * hook patterns (Question hooks, Shock hooks, Tease hooks, Premise
 * restates) at the very start of the paragraph and removes JUST that
 * opening, preserving whatever follows. If the paragraph has no
 * hook-like opening, returns the input unchanged.
 *
 * Returns ``null`` if nothing should change, or the cleaned string.
 */
function stripHookOpening(paragraph: string): string | null {
  // Hook-pattern openers. Each pattern matches from the start of the
  // paragraph up through the end of its first sentence.
  //
  // Examples we catch (and remove the matched opener):
  //   "What if the weakest son was secretly the deadliest? Ghislain..."
  //     → "Ghislain..."
  //   "By the end of this video, you'll see exactly how a useless heir
  //    dismantled an entire kingdom. The Best Knight..."
  //     → "The Best Knight..."
  //   "This man just walked into a death trap on purpose. Ghislain..."
  //     → "Ghislain..."
  //
  // We're conservative: each pattern requires the hook-like phrase
  // AT THE VERY START (no leading whitespace tolerance beyond ^) and
  // requires a clear sentence boundary so we don't accidentally trim
  // legitimate prose that happens to start with similar words.
  // Also catch hook-only beats with no trailing whitespace (the beat
  // IS the hook). Same patterns, but without requiring \s+ at the end.
  const hookPatternsStrict: RegExp[] = [
    /^\s*What if\b[^.!?]*[.!?]\s+/i,
    /^\s*Imagine if\b[^.!?]*[.!?]\s+/i,
    /^\s*In a world where\b[^.!?]*[.!?]\s+/i,
    /^\s*By the end of (?:this video|this clip|this recap)\b[^.!?]*[.!?]\s+/i,
    /^\s*This man just\b[^.!?]*[.!?]\s+/i,
    /^\s*This is the story of\b[^.!?]*[.!?]\s+/i,
    /^\s*Welcome (?:back )?to\b[^.!?]*[.!?]\s+/i,
    /^\s*Today we're (?:looking at|covering|recapping)\b[^.!?]*[.!?]\s+/i,
  ];
  for (const re of hookPatternsStrict) {
    const m = paragraph.match(re);
    if (m) {
      const stripped = paragraph.slice(m[0].length).trim();
      // Only commit the strip if what's left is still a meaningful
      // paragraph (≥ 8 words). Otherwise the hook IS the paragraph
      // and we fall through to the "entire-beat-is-hook" case below.
      if (stripped.split(/\s+/).length >= 8) {
        return stripped;
      }
    }
  }

  // Entire-beat-is-hook case: the paragraph IS a hook with no trailing
  // story content (e.g. "What if the family's failure was their
  // deadliest weapon?" with nothing after). Stripping would leave
  // nothing useful. Replace the whole beat with a plain transition
  // placeholder — the upcoming bridge stage will then prepend a real
  // bridge sentence to it for smooth continuity.
  //
  // Patterns are lighter (no trailing whitespace requirement) so we
  // catch beats that are ONLY a question hook.
  const wholeBeatHookPatterns: RegExp[] = [
    /^\s*What if\b[^.!?]*\??\s*$/i,
    /^\s*Imagine if\b[^.!?]*\??\s*$/i,
    /^\s*In a world where\b[^.!?]*[.!?]?\s*$/i,
    /^\s*By the end of (?:this video|this clip|this recap)\b[^.!?]*[.!?]?\s*$/i,
    /^\s*This man just\b[^.!?]*[.!?]?\s*$/i,
    /^\s*Welcome (?:back )?to\b[^.!?]*[.!?]?\s*$/i,
  ];
  for (const re of wholeBeatHookPatterns) {
    if (re.test(paragraph)) {
      // Generic transition placeholder. The continuity bridge stage
      // running right after this will prepend a real bridge sentence,
      // producing a fully natural transition.
      return "The story moves on.";
    }
  }
  return null;
}
