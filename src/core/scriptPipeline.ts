// Stage 4 orchestrator — turns filtered panels into a finished script.
//
//   1. Character bible (one multi-image Gemini call).
//   2. Chunk kept panels into scene-sized groups (local, no API call).
//   3. Per-scene narration — one Gemini call per chunk, threading
//      the bible + a 2-line recap of the previous scene.
//   4. Flatten into ``lines`` (1:1 with kept panels) and ``scriptText``
//      (the file the user pastes into the MegaShoeb TTS server).

import type {
  CharacterBible,
  FilteredPage,
  FilterResult,
  SceneOutput,
  ScriptResult,
} from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

import { extractCharacterBible } from "./characterBible";
import { chunkIntoScenes } from "./sceneChunker";
import { narrateScene } from "./narrator";
import { curatePanels, type CuratorTierLog, type PanelScore } from "./panelCurator";
import { comprehendChapter } from "./comprehend";
import { segmentIntoBeats } from "./segment";
import { polishScript } from "./scriptPolisher";
import { structurallyEditScript } from "./scriptStructuralEditor";
import { checkAndCorrectScript } from "./scriptAccuracyChecker";
import { type ChapterTiming, stopwatch } from "./stageTiming";
import {
  scanChapterQuality,
  summarizeWarnings,
  type QualityWarning,
} from "./qualityScan";

export interface ScriptPipelineOptions {
  model: string;
  rotator: KeyRotator;
  idealSceneSize?: number;
  /**
   * Bible carried over from earlier chapters in the same series.
   * Passed through to the bible-extraction step so character names
   * stay consistent across a 30-40 chapter run.
   */
  previousBible?: CharacterBible;
  /**
   * Run the editor-style polish pass after narration (default ``true``).
   * Adds one extra Gemini call per chapter that strips AI tells,
   * rotates phrasing, injects a YouTube hook and retention markers,
   * and enforces paragraph-rhythm variety.
   */
  polish?: boolean;
  /**
   * Run the structural-editor pass after the phrase polish
   * (default ``true``). Adds one more Gemini call per chapter that
   * breaks cyclical beat patterns (shock→dominate→reveal→repeat),
   * enforces sentence-opener variety, and rotates paragraph shapes.
   * Phrase polish only catches surface-level repetition; this pass
   * catches the structural repetition that survives it.
   */
  structuralEdit?: boolean;
  /**
   * Long-form recap mode (default ``false``). When ``true`` an extra
   * Gemini call sits between bible extraction and scene chunking that
   * SELECTS only the story-driving panels (combat, reveals, character
   * intros) — typically 7-10 per chapter instead of all 40-50 kept
   * panels. Used when the user wants to cover 70-80 chapters in a
   * single 2-3 hour video; each chapter only gets a 2-3 minute slot.
   *
   * The flag is also threaded into the narrator, phrase polisher,
   * and structural editor so each stage produces short paragraphs
   * (30-45 words) rather than the standard 60-100.
   *
   * The 1:1 panel↔paragraph invariant is preserved on the curated
   * subset, so downstream SRT sync still works exactly the same.
   */
  longFormRecap?: boolean;
  /**
   * Hook line from the PREVIOUS chapter's polished script (paragraph 1).
   * Threaded into the phrase polisher so paragraph 1 of THIS chapter
   * doesn't reuse the same hook structure ("What if..." template etc.)
   * Empty for the first chapter of a run.
   */
  previousChapterHook?: string;
  /**
   * Last 4 beats (paragraphs) of the PREVIOUS chapter's polished script.
   * Joined with double newlines. Used as the ROLLING_CONTEXT seed for
   * the FIRST scene of this chapter, so chapter N+1's narration
   * continues seamlessly from chapter N's tail instead of restarting.
   * Empty for the first chapter of a run.
   */
  previousChapterTail?: string;
  /**
   * True for the very first chapter of a long-form recap run. Polish
   * uses this to decide whether to ADD a hook (chapter 1 only) vs
   * preserve smooth continuation (chapter 2+). Defaults to ``true``
   * for single-chapter mode (where every chapter is "first").
   */
  isFirstChapter?: boolean;
  /**
   * Optional model override for the POLISH stage (the phrase polish
   * pass that adds the hook + retention markers). Defaults to ``model``.
   * Spec-compliant long-form runs set this to ``gemini-3.1-pro`` for
   * premium polish quality (~1 call per chapter).
   */
  polishModel?: string;
  /**
   * Optional model override for the STRUCTURAL editor stage. Per spec,
   * defaults to ``gemini-2.5-flash`` (1K RPM / 10K RPD — abundant) so
   * polish's 3.1-pro budget (250 RPD) isn't burned twice per chapter.
   */
  structuralModel?: string;
  /**
   * Optional model override for the Stage-2 panel CURATOR. Per spec,
   * defaults to ``gemini-2.0-flash-lite`` (unlimited RPD, 4000 RPM) —
   * cheap classifier-grade calls at high volume.
   */
  curatorModel?: string;
  /**
   * Optional model override for Stage 3A (whole-chapter comprehension).
   * Defaults to ``model``. Spec assigns ``gemini-2.5-flash``.
   */
  comprehendModel?: string;
  /**
   * Optional model override for Stage 3B (beat segmentation).
   * Defaults to ``comprehendModel`` then ``model``. Same model as 3A
   * per spec (gemini-2.5-flash).
   */
  segmentModel?: string;
  /**
   * Fired with the per-panel score list from Stage 2 curator. Lets the
   * downstream packaging stage include scores in the manifest for
   * spot-check debugging.
   */
  onCuratorScores?: (scores: PanelScore[]) => void;
  /**
   * Fired with the curator tier verdict (STRICT_5_5 / RELAXED_4_4 /
   * ALL_KEEP / EVEN_SAMPLE_FLOOR). Surfaced for the README's tier-log.
   */
  onCuratorTier?: (log: CuratorTierLog) => void;
  /**
   * Fired ONCE after the chapter completes, with wall-clock ms spent
   * in each pipeline stage. Spec § 6 acceptance criterion — lets the
   * user spot bottlenecks before they bite at 100-chapter scale.
   * NB: does NOT include extract/filter (those run in bulkQueue, which
   * fills in those fields itself before logging).
   */
  onTiming?: (partial: Partial<ChapterTiming>) => void;
  /**
   * Fired if Stage 3B's segmentation fell back to even-splitting the
   * Stage 3A prose (i.e. Gemini failed the beat-count check after
   * retry). When this fires the 1:1 COUNT invariant is intact but the
   * BEAT-TO-PANEL CONTENT alignment is approximate, not surgical.
   * bulkQueue records this in the manifest so the user knows which
   * chapters need a manual spot-check.
   */
  onAlignmentDegraded?: (reason: string) => void;
  /**
   * Fired with the per-chapter quality warnings detected by the
   * post-process scan (qualityScan.ts). Categories include
   * generic-protagonist references ("this guy"), retention
   * interjections ("Now this is where things get insane"),
   * panel-description leaks ("the panel shows..."), and bare
   * quote-dash openings. Surfaced into the manifest so the user
   * can spot-fix without re-running the chapter.
   */
  onQualityWarnings?: (warnings: QualityWarning[]) => void;
  /**
   * Run the image-narration accuracy check (Stage 6) after polish and
   * structural edit (default ``true`` in long-form mode, ``false``
   * otherwise — single-chapter runs already have N=40-50 panels which
   * is too many for one accuracy call, and accuracy is less critical
   * for them since the user reviews the script anyway).
   *
   * The flag here defaults to ``undefined``; resolution to a boolean
   * happens inside the function (``longFormRecap ?? false``).
   */
  accuracyCheck?: boolean;
  onProgress?: (
    stage:
      | "bible"
      | "curating"
      | "narrating"
      | "polishing"
      | "structural"
      | "accuracy",
    current: number,
    total: number,
    msg: string,
  ) => void;
  onKeyUsed?: (masked: string) => void;
}

/**
 * Generate a finished narration script from filtered panels.
 *
 * The returned ``lines`` array has exactly as many entries as the
 * input has KEPT pages. Each line corresponds to one panel and will
 * become one SRT block when run through the MegaShoeb server.
 *
 * If Gemini returns a wrong number of lines for any scene, we pad or
 * truncate to keep the 1:1 invariant — the user can see the mismatch
 * in the per-scene previews and re-run that scene if quality matters.
 */
export async function generateScript(
  pages: FilteredPage[],
  options: ScriptPipelineOptions,
): Promise<ScriptResult> {
  const {
    model,
    rotator,
    idealSceneSize,
    previousBible,
    polish = true,
    structuralEdit = true,
    longFormRecap = false,
    previousChapterHook,
    previousChapterTail,
    isFirstChapter = true,
    polishModel,
    structuralModel,
    curatorModel,
    comprehendModel,
    segmentModel,
    onCuratorScores,
    onCuratorTier,
    onTiming,
    onAlignmentDegraded,
    onQualityWarnings,
    onProgress,
    onKeyUsed,
  } = options;
  // Per-stage wall-clock accumulators. Filled as each stage completes,
  // fired through ``onTiming`` once at chapter end. extract+filter are
  // measured by the bulkQueue caller — we only fill the Gemini-side
  // stages here.
  const timing: Partial<ChapterTiming> = {
    bible_ms: 0,
    classify_ms: 0,
    comprehend_ms: 0,
    segment_ms: 0,
    polish_ms: 0,
  };
  // In long-form mode the story-first flow (Stage 3A + 3B) replaces
  // the per-scene narrator AND obsoletes the structural editor /
  // accuracy checker, which existed to clean up problems the per-scene
  // narrator introduced (cyclic beat patterns + panel-description
  // hallucinations). Story-first avoids both at the source so we skip
  // those stages by default. ``accuracyCheck`` can still be force-
  // enabled per spec config in single-chapter mode.
  const accuracyCheck =
    options.accuracyCheck ?? (longFormRecap ? false : false);
  // Per-stage model resolution: each falls back to the main ``model``
  // if not overridden. Spec assignment is set up in bulkQueue.ts.
  const polishStageModel = polishModel ?? model;
  const structuralStageModel = structuralModel ?? polishStageModel;
  const curatorStageModel = curatorModel ?? model;
  const comprehendStageModel = comprehendModel ?? model;
  const segmentStageModel = segmentModel ?? comprehendStageModel;

  const kept = pages.filter((p) => p.kept);
  if (kept.length === 0) {
    throw new Error("No kept pages to narrate. Adjust filter settings.");
  }

  // ---- Stage 4a: character bible ----------------------------------
  onProgress?.("bible", 0, 1, "Reading character bible from the first panels…");
  const bibleTimer = stopwatch();
  const bible = await extractCharacterBible(kept, {
    model,
    rotator,
    previousBible,
    onKeyUsed,
  });
  timing.bible_ms = bibleTimer();
  onProgress?.("bible", 1, 1, "Character bible ready.");

  // ---- Stage 4a.5: drop title/credits pages -----------------------
  // Gemini flags scanlation-credits pages and chapter-title cards as
  // part of the bible call. We exclude them from narration so the
  // script starts with actual story content and doesn't waste lines
  // on team names / studio logos.
  const titlePageIndices = bible.titlePageIndices ?? [];
  const titleSet = new Set(titlePageIndices);
  const narratable = kept.filter((p) => !titleSet.has(p.index));

  // ---- Stage 3.5: panel curation (long-form recap only) -----------
  // When the user is condensing 70-80 chapters into a 2-3 hour video,
  // each chapter only gets a ~2-3 minute slot. Ask Gemini to keep
  // only the story-driving panels (combat, reveals, character intros)
  // and skip filler. AI auto-decides 10-35 panels per chapter based
  // on density. Downstream narration runs over this curated subset.
  let curated = narratable;
  if (longFormRecap && narratable.length > 0) {
    onProgress?.(
      "curating",
      0,
      1,
      `Curating ${narratable.length} panels for long-form recap…`,
    );
    const classifyTimer = stopwatch();
    curated = await curatePanels(narratable, {
      model: curatorStageModel,
      rotator,
      bible,
      onKeyUsed,
      onProgress: (c, t, msg) => onProgress?.("curating", c, t, msg),
      onScores: onCuratorScores,
      onTier: onCuratorTier,
    });
    timing.classify_ms = classifyTimer();
    onProgress?.(
      "curating",
      1,
      1,
      `Curated ${curated.length} of ${narratable.length} panels.`,
    );
  }

  // ---- Stage 3: narration ----------------------------------------
  // Two completely different narration architectures based on mode:
  //
  //   LONG-FORM (story-first, spec v3):
  //     3A. comprehend whole chapter (ONE call, all curated panels) →
  //         flowing prose with full setup/motivation/stakes.
  //     3B. segment prose into exactly N beats (ONE call) where
  //         beat i ↔ panel i.
  //     Result: lines.length == curated.length, but each line was
  //     written WITH AWARENESS of the entire chapter, not in isolation.
  //
  //   SINGLE-CHAPTER (panel-first, legacy):
  //     Chunk panels into scenes of ~6, call narrateScene per chunk
  //     with rolling context. Better for single-chapter "render one
  //     full chapter as one video" use case where depth per panel
  //     matters more than cross-chapter continuity.
  const scenes: SceneOutput[] = [];
  const allLines: string[] = [];

  if (longFormRecap) {
    // === Stage 3A: whole-chapter comprehension ===================
    onProgress?.(
      "narrating",
      0,
      2,
      `Stage 3A — reading whole chapter (${curated.length} panels)…`,
    );
    const comprehendTimer = stopwatch();
    const prose = await comprehendChapter(curated, {
      model: comprehendStageModel,
      rotator,
      bible,
      previousChapterTail,
      onKeyUsed,
      onProgress: (c, t, msg) => onProgress?.("narrating", c, t, msg),
    });
    timing.comprehend_ms = comprehendTimer();

    // === Stage 3B: beat segmentation + panel matching ============
    onProgress?.(
      "narrating",
      1,
      2,
      `Stage 3B — segmenting story into ${curated.length} beats…`,
    );
    const segmentTimer = stopwatch();
    const segmentOut = await segmentIntoBeats(prose, curated, {
      model: segmentStageModel,
      rotator,
      onKeyUsed,
      onProgress: (c, t, msg) => onProgress?.("narrating", c, t, msg),
    });
    timing.segment_ms = segmentTimer();

    // Surface the alignment-degraded signal upward so bulkQueue can
    // record it in the manifest. When fired, the chapter still has
    // the right BEAT COUNT (1:1 invariant intact) but beat-to-panel
    // content alignment is approximate — flagged for spot-check.
    if (segmentOut.alignmentDegraded) {
      console.warn(
        `⚠️  Chapter alignment degraded: ${segmentOut.degradationReason}`,
      );
      onAlignmentDegraded?.(segmentOut.degradationReason);
    }

    // segment.ts guarantees beats.length == curated.length via its
    // own retry+fallback chain (even-split prose if Gemini fails the
    // count check twice). Defensive reconcile here is belt-and-
    // suspenders only.
    const adjusted = reconcileLineCount(segmentOut.beats, curated.length);

    // One synthetic "scene" containing all beats — keeps the
    // ScriptResult.scenes structure consistent for downstream code.
    scenes.push({
      sceneIndex: 0,
      panelIndices: curated.map((p) => p.index),
      lines: adjusted,
    });
    allLines.push(...adjusted);
    onProgress?.("narrating", 2, 2, "Story-first narration complete.");
  } else {
    // === Legacy per-scene narration (single-chapter mode) ========
    const sceneChunks = chunkIntoScenes(curated, {
      idealSize: idealSceneSize ?? 6,
    });

    for (let i = 0; i < sceneChunks.length; i++) {
      const chunk = sceneChunks[i];
      onProgress?.(
        "narrating",
        i,
        sceneChunks.length,
        `Narrating scene ${i + 1} / ${sceneChunks.length} (${chunk.length} panels)…`,
      );
      const rollingContext =
        i === 0 && previousChapterTail && previousChapterTail.trim().length > 0
          ? previousChapterTail
          : allLines.slice(-6).join("\n\n");

      const lines = await narrateScene(chunk, {
        model,
        rotator,
        bible,
        prevSceneSummary: rollingContext,
        longFormRecap,
        onKeyUsed,
      });
      const adjusted = reconcileLineCount(lines, chunk.length);

      scenes.push({
        sceneIndex: i,
        panelIndices: chunk.map((p) => p.index),
        lines: adjusted,
      });
      allLines.push(...adjusted);
    }
    onProgress?.(
      "narrating",
      sceneChunks.length,
      sceneChunks.length,
      "All scenes narrated.",
    );
  }

  // ---- Stage 4d: editor-style polish pass --------------------------
  // One additional Gemini call. Strips AI tells, rotates phrasing,
  // adds the YouTube hook + retention markers, enforces rhythm.
  // The polish output count is validated to equal allLines.length;
  // any mismatch falls back to the unpolished draft so we never
  // break the downstream SRT 1:1 invariant.
  let finalLines = allLines;
  let finalScenes = scenes;

  if (polish && allLines.length > 0) {
    onProgress?.(
      "polishing",
      0,
      1,
      "Polishing script (anti-repetition + YouTube retention pass)…",
    );
    try {
      const polishTimer = stopwatch();
      const polished = await polishScript(allLines, {
        model: polishStageModel,
        rotator,
        bible,
        longFormRecap,
        previousChapterHook,
        isFirstChapter,
        onKeyUsed,
        onProgress: (c, t, msg) => onProgress?.("polishing", c, t, msg),
      });
      timing.polish_ms = polishTimer();
      if (polished.length === allLines.length) {
        finalLines = polished;
        // Re-thread polished lines back into their scene buckets so
        // ``scenes[i].lines`` stays aligned with the final ``lines`` array.
        let cursor = 0;
        finalScenes = scenes.map((s) => {
          const slice = polished.slice(cursor, cursor + s.lines.length);
          cursor += s.lines.length;
          return { ...s, lines: slice };
        });
      }
    } catch (err) {
      // Polish is best-effort. A failure here doesn't poison the
      // unpolished draft we already have in hand.
      console.warn("Polish pass failed; keeping unpolished script.", err);
    }
    onProgress?.("polishing", 1, 1, "Polish complete.");
  }

  // ---- Stage 4e: structural editor pass ---------------------------
  // Phrase polish caught surface-level AI tells. This pass catches
  // the deeper problem: same EMOTIONAL BEAT skeleton repeating
  // (shock → dominate → "underestimated" → realization → humiliation
  // → loop). Same plot, new angles. Same paragraph count (validated
  // with one retry, then falls back to the phrase-polished script
  // so the SRT 1:1 invariant is never broken).
  // Skip structural edit in long-form mode — the story-first flow
  // (Stage 3A + 3B) writes coherent prose from whole-chapter context,
  // which doesn't develop the cyclic beat patterns the structural
  // editor exists to break. Running it adds latency and a small
  // sync-drift risk without quality upside.
  const runStructural = structuralEdit && !longFormRecap;
  if (runStructural && finalLines.length > 0) {
    onProgress?.(
      "structural",
      0,
      1,
      "Structural edit (breaking cyclical beat patterns)…",
    );
    try {
      const edited = await structurallyEditScript(finalLines, {
        model: structuralStageModel,
        rotator,
        bible,
        longFormRecap,
        onKeyUsed,
        onProgress: (c, t, msg) => onProgress?.("structural", c, t, msg),
      });
      if (edited.length === finalLines.length) {
        // Re-thread the structurally-edited lines back into their
        // scene buckets so ``scenes[i].lines`` stays aligned.
        let cursor = 0;
        finalScenes = finalScenes.map((s) => {
          const slice = edited.slice(cursor, cursor + s.lines.length);
          cursor += s.lines.length;
          return { ...s, lines: slice };
        });
        finalLines = edited;
      }
    } catch (err) {
      // Structural edit is best-effort. A failure here keeps the
      // phrase-polished draft we already have in hand.
      console.warn(
        "Structural edit failed; keeping phrase-polished script.",
        err,
      );
    }
    onProgress?.("structural", 1, 1, "Structural edit complete.");
  }

  // ---- Stage 6: image ↔ narration accuracy verification -----------
  // Sends the curated panels back to Gemini along with the final
  // script and asks "does each paragraph accurately describe the
  // image?". Corrects inaccurate ones, leaves accurate ones alone.
  // Catches narrator hallucinations (described an attack but image
  // shows defense, etc.) and blank-panel improvisations.
  //
  // Only runs when accuracyCheck is true AND we have a 1:1 mapping
  // between curated panels and finalLines. Falls back gracefully on
  // count mismatch or empty output — never breaks SRT sync.
  if (accuracyCheck && finalLines.length > 0 && curated.length === finalLines.length) {
    onProgress?.(
      "accuracy",
      0,
      1,
      `Fact-checking ${curated.length} panel-narration matches…`,
    );
    try {
      const corrected = await checkAndCorrectScript(curated, finalLines, {
        model,
        rotator,
        bible,
        longFormRecap,
        onKeyUsed,
        onProgress: (c, t, msg) => onProgress?.("accuracy", c, t, msg),
      });
      if (corrected.length === finalLines.length) {
        // Re-thread corrected lines into scene buckets to keep
        // ``scenes[i].lines`` aligned with the final ``lines`` array.
        let cursor = 0;
        finalScenes = finalScenes.map((s) => {
          const slice = corrected.slice(cursor, cursor + s.lines.length);
          cursor += s.lines.length;
          return { ...s, lines: slice };
        });
        finalLines = corrected;
      }
    } catch (err) {
      console.warn(
        "Accuracy check failed; keeping pre-check script.",
        err,
      );
    }
    onProgress?.("accuracy", 1, 1, "Accuracy check complete.");
  }

  // ---- Post-process quality scan ----------------------------------
  // Runs over the FINAL beats just before return. Does NOT modify
  // anything — only detects and surfaces violations (generic
  // references, retention interjections, panel-description leaks,
  // bare quote-dash openings) so the manifest can flag them for
  // spot-fix. Each chapter is independent here; cross-chapter
  // patterns (e.g. duplicate retention phrases across chapters)
  // surface in the combined manifest.
  if (onQualityWarnings) {
    const warnings = scanChapterQuality(finalLines);
    if (warnings.length > 0) {
      console.warn(
        `[QUALITY] ${summarizeWarnings(warnings)} — see manifest for per-beat detail.`,
      );
    }
    onQualityWarnings(warnings);
  }

  // Fire the timing callback so the caller (bulkQueue) can merge
  // extract+filter measurements with our Gemini-side stages and log
  // the full breakdown to console + manifest.
  if (onTiming) onTiming(timing);

  return {
    bible,
    scenes: finalScenes,
    lines: finalLines,
    scriptText: finalLines.join("\n"),
    titlePageIndices,
  };
}

/**
 * Apply title-page exclusions to an existing FilterResult.
 *
 * Marks AI-detected title/credits pages as ``kept: false`` and shifts
 * the count from "kept" into a new ``droppedTitlePage`` stat. The
 * download ZIP and image grid both honour the updated ``kept`` flag,
 * so the title pages disappear from both immediately.
 *
 * Pure function — returns a new FilterResult, never mutates the input.
 */
export function applyTitlePageExclusions(
  filterResult: FilterResult,
  titleIndices: number[],
): FilterResult {
  if (titleIndices.length === 0) return filterResult;
  const titleSet = new Set(titleIndices);

  let newlyDropped = 0;
  const pages = filterResult.pages.map((p) => {
    if (titleSet.has(p.index) && p.kept) {
      newlyDropped++;
      return {
        ...p,
        kept: false,
        reason: "title / credits page (AI detected)",
      };
    }
    return p;
  });

  return {
    pages,
    stats: {
      ...filterResult.stats,
      kept: filterResult.stats.kept - newlyDropped,
      droppedTitlePage:
        (filterResult.stats.droppedTitlePage ?? 0) + newlyDropped,
    },
  };
}

/**
 * Make ``lines.length === expected`` by padding short or truncating long.
 *
 * Padding repeats the last line if Gemini gave us too few; truncation
 * keeps the first ``expected`` lines if it gave us too many. We log to
 * console so power users can spot it during dev — production should
 * see this fire essentially never with the current prompt.
 */
function reconcileLineCount(lines: string[], expected: number): string[] {
  if (lines.length === expected) return lines;
  if (lines.length === 0) {
    return Array.from({ length: expected }, (_, i) => `(scene panel ${i + 1})`);
  }
  console.warn(
    `Narration count mismatch: got ${lines.length}, expected ${expected}. Reconciling.`,
  );
  if (lines.length < expected) {
    const last = lines[lines.length - 1];
    return [...lines, ...Array(expected - lines.length).fill(last)];
  }
  return lines.slice(0, expected);
}
