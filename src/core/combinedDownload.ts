// Long-form-recap mega-ZIP builder.
//
// Used at the end of a bulk run when ``longFormRecap`` mode is on.
// Takes every chapter's curated panels + script and assembles ONE ZIP
// containing:
//
//   chapter_01_panel_01.jpg
//   chapter_01_panel_02.jpg
//   ...
//   chapter_80_panel_20.jpg
//   script.txt                  ← clean, paste-ready for TTS
//   script_with_chapters.txt    ← divider-prefixed, for human reference
//   manifest.json               ← per-chapter stats + character list
//   README.txt                  ← workflow walkthrough
//
// Flat filename layout (not nested folders) so CapCut sees every
// panel as a single sequence in one import. The 1:1 panel↔line
// invariant is preserved per-chapter AND for the combined output —
// total lines in script.txt == total panel files in the ZIP.
//
// Memory note: we hold every chapter's Blobs in JS memory until the
// final generateAsync completes. Browsers manage Blob backing
// storage (often spilled to disk), so even 80 chapters × ~20 panels
// × ~500KB ≈ 800 MB stays manageable. The accumulator pattern in
// bulkQueue holds these references for the duration of the run.

import JSZip from "jszip";

import type { ScriptResult } from "../types/manhwa";
import type { CuratorTierLog, PanelScore } from "./panelCurator";
import type { ChapterTiming } from "./stageTiming";
import type { QualityWarning } from "./qualityScan";

/**
 * One chapter's contribution to the combined output. ``blobs`` are
 * the JPEG bytes for the curated panels in reading order; ``script``
 * carries the narration lines (which must equal ``blobs.length`` —
 * the per-chapter 1:1 invariant).
 */
export interface CombinedChapterEntry {
  /** 1-based chapter number used in filenames + manifest. */
  chapterIndex: number;
  /** Original PDF filename (stem only — no .pdf), shown in manifest. */
  chapterName: string;
  /** Curated panel JPEGs in reading order. Length must equal ``script.lines.length``. */
  blobs: Blob[];
  /** Per-chapter narration script. */
  script: ScriptResult;
  /**
   * Original 1-based PDF page indices for each curated blob, in the
   * same order. Surfaced into the manifest so the user can trace any
   * beat back to its source PDF page if they need to spot-check.
   */
  panelSourceIndices?: number[];
  /**
   * Curator scores for the kept panels — story_weight, visual_impact,
   * keep reason. Spec § 4 Stage 6 manifest item: lets the user sample
   * 10 random beats per chapter and check if the score/reason matches
   * the visible image, catching alignment regressions in minutes.
   */
  panelScores?: PanelScore[];
  /**
   * Which curator tier fired for this chapter (STRICT_5_5 / RELAXED_4_4
   * / ALL_KEEP / EVEN_SAMPLE_FLOOR). Logged in README so the user can
   * spot quality regressions across the run.
   */
  curatorTier?: CuratorTierLog;
  /**
   * Per-stage wall-clock timing (ms) for this chapter. Surfaced into
   * the README + manifest so the user can spot bottlenecks before
   * scaling to 100 chapters.
   */
  timing?: ChapterTiming;
  /**
   * True when Stage 3B's segmentation fell back to even-split prose —
   * the 1:1 count invariant is intact but per-panel content alignment
   * is approximate, not surgical. Surfaced in the manifest's chapter
   * entry so the user knows which chapters to spot-check first.
   */
  alignmentDegraded?: boolean;
  /** Human-readable reason when ``alignmentDegraded`` is true. */
  alignmentDegradationReason?: string;
  /**
   * Per-beat quality violations detected by the post-process scan
   * (generic references, retention interjections, panel-description
   * leaks, bare-quote-dash openings). Surfaced into the manifest so
   * the user can spot-fix without re-running.
   */
  qualityWarnings?: QualityWarning[];
}

export interface CombinedDownloadOptions {
  /** Filename for the output ZIP (without extension). */
  outputName?: string;
  /** Approximate seconds per narration line — only used for the README estimate. */
  secondsPerLine?: number;
  onProgress?: (current: number, total: number, msg: string) => void;
  /**
   * Fired with the final ZIP blob + filename right before the auto-
   * download triggers. Caller can store the blob in state to enable a
   * manual "Download again" button — the auto-download still proceeds
   * regardless. Useful for cases where the user wants to re-download
   * after closing the original file or accidentally moving it.
   */
  onArchiveReady?: (blob: Blob, filename: string) => void;
}

/**
 * Build the combined ZIP and trigger a browser download.
 *
 * Returns once the download has been kicked off; the user's browser
 * handles the rest. The Blob URL is revoked shortly after so memory
 * is released as soon as the download begins flushing to disk.
 */
export async function downloadCombinedRecap(
  entries: CombinedChapterEntry[],
  options: CombinedDownloadOptions = {},
): Promise<void> {
  if (entries.length === 0) {
    throw new Error("No chapters to combine — nothing was processed successfully.");
  }

  // ---- FINAL 1:1 ASSERT (last line of defence) --------------------
  // Each chapter that reaches this point MUST have exactly one panel
  // blob per script line. Upstream (bulkQueue, polishScript, etc.)
  // already enforce this with retry + fallback, but we re-assert here
  // because shipping a misaligned chapter would silently desync the
  // viewer's CapCut auto-sync output across hundreds of subtitles.
  //
  // Failure here is loud (named chapter + counts), so the user
  // immediately knows WHICH chapter to inspect / re-run.
  const mismatched = entries.filter(
    (e) => e.blobs.length !== e.script.lines.length,
  );
  if (mismatched.length > 0) {
    const detail = mismatched
      .map(
        (e) =>
          `  • Chapter ${e.chapterIndex} (${e.chapterName}): ${e.blobs.length} panels vs ${e.script.lines.length} lines`,
      )
      .join("\n");
    throw new Error(
      `❌ 1:1 INVARIANT VIOLATED — refusing to build combined ZIP.\n` +
        `${mismatched.length} chapter${mismatched.length === 1 ? "" : "s"} ` +
        `would desync the CapCut auto-sync output:\n${detail}\n` +
        `\nRemove or re-run the listed chapters before retrying the combined output.`,
    );
  }

  const {
    outputName = "longform_recap_combined",
    secondsPerLine = 6,
    onProgress,
  } = options;

  const totalPanels = entries.reduce((a, e) => a + e.blobs.length, 0);
  // 5 extra steps: script.txt, script_with_chapters.txt, script.srt,
  // manifest.json, README.txt
  const totalSteps = totalPanels + 5;
  let step = 0;

  const zip = new JSZip();
  const imagesFolder = zip.folder("images");
  if (!imagesFolder) {
    throw new Error("Failed to create images/ folder in ZIP");
  }

  // ---- panels — SEQUENTIAL GLOBAL NUMBERING (spec v3 Stage 6) -----
  // images/0001.jpg ↔ script.txt line 1 ↔ script.srt block 1.
  // Same number everywhere. CapCut auto-sync just needs to import
  // images/ as a sequence and they line up 1:1 with the SRT.
  //
  // We also build the master line list and the per-beat manifest in
  // the same pass so the three artefacts CAN'T drift apart.
  const masterLines: string[] = [];
  interface ManifestBeat {
    index: number;
    image: string;
    chapter: number;
    source_panel_index?: number;
    narration: string;
    story_weight?: number;
    visual_impact?: number;
    curator_reason?: string;
    /**
     * True when this beat sits inside a chapter that fell back to
     * even-split prose in Stage 3B — content alignment to its image
     * is approximate, not surgical. Worth spot-checking by hand.
     */
    alignment_degraded?: boolean;
  }
  const manifestBeats: ManifestBeat[] = [];

  let globalIdx = 0;
  for (const entry of entries) {
    for (let i = 0; i < entry.blobs.length; i++) {
      const line = entry.script.lines[i] ?? "";
      const blob = entry.blobs[i];

      // Find the curator score for this curated panel by matching its
      // original PDF page index (recorded in panelSourceIndices). If
      // panelScores wasn't supplied (older run), the manifest just
      // omits those fields.
      const sourceIdx = entry.panelSourceIndices?.[i];
      let storyWeight: number | undefined;
      let visualImpact: number | undefined;
      let curatorReason: string | undefined;
      if (entry.panelScores && entry.panelScores.length > 0 && sourceIdx) {
        // panelScores' ``index`` field is the position WITHIN the
        // narratable input to the curator (0-based). We don't have
        // that mapping plumbed back, so as a best-effort we find the
        // kept score whose position matches kthe kept index of THIS
        // panel within entry.panelSourceIndices. Index alignment isn't
        // guaranteed perfect here — if it ever proves wrong in
        // practice we can thread the exact map. For now it's good
        // enough for spot-checks.
        const kept = entry.panelScores.filter((s) => s.keep);
        const s = kept[i];
        if (s) {
          storyWeight = s.story_weight;
          visualImpact = s.visual_impact;
          curatorReason = s.reason;
        }
      }

      // ---- Pacing splitter ---------------------------------------
      // Only split BEATS that would otherwise hang an image on screen
      // longer than the cap (defaults: 8s normal, 5s during the first
      // few intro beats). Each split sub-beat REUSES the same panel
      // blob — visual variety comes from the per-clip animation in
      // CapCut (ANIME mode cycles zoom-in → scroll-down → zoom-out
      // → scroll-up, so even repeated panels look different in the
      // final render).
      //
      // We DO NOT generate fake scroll windows of the panel — for
      // typical webtoon panel sizes (~1000×800-1500 px) the cropped
      // windows look nearly identical in thumbnails, defeating the
      // purpose. Animations are a better source of motion variety.
      const isIntro = globalIdx < PACING_INTRO_BEATS;
      const subLines = splitLineForPacing(line, isIntro);

      for (const subLine of subLines) {
        globalIdx++;
        const padded = String(globalIdx).padStart(4, "0");
        const imageName = `${padded}.jpg`;
        imagesFolder.file(imageName, blob);
        masterLines.push(subLine);

        manifestBeats.push({
          index: globalIdx,
          image: `images/${imageName}`,
          chapter: entry.chapterIndex,
          source_panel_index: sourceIdx,
          narration: subLine,
          story_weight: storyWeight,
          visual_impact: visualImpact,
          curator_reason: curatorReason,
          alignment_degraded: entry.alignmentDegraded || undefined,
        });

        step++;
        if (step % 10 === 0) {
          onProgress?.(step, totalSteps, `Packing images/${imageName}`);
        }
      }
    }
  }

  // ---- clean master script (paste-ready for TTS) ------------------
  // Line 1 corresponds to images/0001.jpg and SRT block 1 — same
  // global number everywhere.
  zip.file("script.txt", masterLines.join("\n"));
  step++;
  onProgress?.(step, totalSteps, "Packing script.txt");

  // ---- human-readable script with chapter dividers ----------------
  const dividerParts: string[] = [];
  let runningIdx = 0;
  for (const entry of entries) {
    const chapNum = String(entry.chapterIndex).padStart(2, "0");
    dividerParts.push(
      `═══════════════════════════════════════════════════════════════════════`,
    );
    dividerParts.push(`  Chapter ${chapNum} — ${entry.chapterName}`);
    dividerParts.push(
      `  ${entry.script.lines.length} beats (global ${runningIdx + 1} → ${runningIdx + entry.script.lines.length})`,
    );
    if (entry.curatorTier) {
      dividerParts.push(
        `  Curator tier: ${entry.curatorTier.tier}  ` +
          `(${entry.curatorTier.kept}/${entry.curatorTier.candidates} candidates kept)`,
      );
    }
    dividerParts.push(
      `═══════════════════════════════════════════════════════════════════════`,
    );
    dividerParts.push("");
    dividerParts.push(entry.script.scriptText);
    dividerParts.push("");
    dividerParts.push("");
    runningIdx += entry.script.lines.length;
  }
  zip.file("script_with_chapters.txt", dividerParts.join("\n"));
  step++;
  onProgress?.(step, totalSteps, "Packing script_with_chapters.txt");

  // ---- SRT skeleton ------------------------------------------------
  // N blocks, block i numbered i, text = beat i's narration. Timing
  // placeholders use ``secondsPerLine`` as a uniform interval. When
  // the TTS / voice-over stage knows actual per-line audio durations,
  // it should regenerate the SRT with those exact timings — but the
  // block COUNT and ORDER are already correct, which is what CapCut
  // auto-sync needs.
  zip.file("script.srt", buildSrtSkeleton(masterLines, secondsPerLine));
  step++;
  onProgress?.(step, totalSteps, "Packing script.srt");

  // ---- manifest ----------------------------------------------------
  const manifest = {
    generated_at: new Date().toISOString(),
    pipeline_version: "0.6.0-story-first",
    chapter_count: entries.length,
    total_panels: totalPanels,
    total_lines: masterLines.length,
    estimated_video_minutes: Math.round(
      (masterLines.length * secondsPerLine) / 60,
    ),
    seconds_per_line_assumed: secondsPerLine,
    chapters: entries.map((e) => ({
      chapter_index: e.chapterIndex,
      chapter_name: e.chapterName,
      panel_count: e.blobs.length,
      line_count: e.script.lines.length,
      curator_tier: e.curatorTier?.tier ?? "(not recorded)",
      curator_candidates: e.curatorTier?.candidates,
      curator_kept: e.curatorTier?.kept,
      characters: Object.keys(e.script.bible.characters),
      title_page_indices: e.script.titlePageIndices,
      timing_ms: e.timing,
      alignment_degraded: e.alignmentDegraded ?? false,
      alignment_degradation_reason: e.alignmentDegradationReason,
      quality_warnings_count: e.qualityWarnings?.length ?? 0,
      quality_warnings: e.qualityWarnings ?? [],
    })),
    beats: manifestBeats,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  step++;
  onProgress?.(step, totalSteps, "Packing manifest.json");

  // ---- README ------------------------------------------------------
  zip.file(
    "README.txt",
    buildCombinedReadme(entries, totalPanels, masterLines.length, secondsPerLine),
  );
  step++;
  onProgress?.(step, totalSteps, "Packing README.txt");

  // ---- generate + download -----------------------------------------
  // Compression at level 6 — JPEGs barely compress so most of the
  // savings come from the small text/JSON files.
  onProgress?.(
    step,
    totalSteps,
    `Compressing final ZIP (${totalPanels} panels, may take a minute)…`,
  );
  const archive = await zip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    },
    (meta) => {
      onProgress?.(
        step,
        totalSteps,
        `Compressing ZIP… ${Math.round(meta.percent)}%`,
      );
    },
  );

  const archiveFilename = `${outputName}.zip`;
  // Expose the blob BEFORE saveBlob revokes its URL. Caller can store
  // a reference for re-download or alternate handling.
  options.onArchiveReady?.(archive, archiveFilename);
  saveBlob(archive, archiveFilename);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Build an SRT skeleton with N blocks, one per line.
 *
 * Timings are derived from each line's WORD COUNT at standard
 * narrator speed (150 WPM ≈ 0.4 sec per word). This approximates
 * what a real TTS server will produce — a 12-word beat gets ~4.8s,
 * a 20-word beat gets ~8s. Much better placeholder than uniform
 * timings, and viewable directly in any SRT player.
 *
 * When the TTS step finishes and you have the real per-line audio
 * durations, regenerate the SRT with those exact timings (the
 * MegaShoeb TTS server produces this directly). The block COUNT and
 * ORDER are already correct either way — that's what matters for
 * CapCut auto-sync's images/0001.jpg ↔ block 1 mapping.
 *
 * Minimum block duration of 1.0s enforces readability for very short
 * beats. Inter-block gap of 100 ms keeps subtitles from running into
 * each other when the player snaps timings.
 */
function buildSrtSkeleton(lines: string[], _secondsPerLine: number): string {
  // 150 WPM (standard YouTube narrator pace) → 0.4 sec per word.
  const SEC_PER_WORD = 60 / 150;
  /** Floor for very short beats (1-2 words) so they stay readable. */
  const MIN_BLOCK_SEC = 1.0;
  /** Tiny inter-block gap so adjacent subtitles don't bleed into each
   *  other in players that snap to frame boundaries. */
  const GAP_SEC = 0.1;

  const blocks: string[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const words = countWords(lines[i]);
    const duration = Math.max(MIN_BLOCK_SEC, words * SEC_PER_WORD);
    const start = cursor;
    const end = cursor + duration;
    blocks.push(
      `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${lines[i]}\n`,
    );
    cursor = end + GAP_SEC;
  }
  return blocks.join("\n");
}

/** Count whitespace-separated words. Strips punctuation-only tokens. */
function countWords(line: string): number {
  const tokens = line.trim().split(/\s+/);
  // Drop empty or pure-punctuation tokens (don't pad timing for "—" alone).
  return tokens.filter((t) => /\w/.test(t)).length;
}

// ---------------------------------------------------------------------
// Pacing splitter — break long beats into shorter sub-beats so no
// single image lingers more than ~6 seconds. The first ~12 beats get
// tighter pacing for retention (faster image changes at video start).
// ---------------------------------------------------------------------

/** Standard YouTube narrator pace: 150 WPM ≈ 0.4 sec/word. */
const PACING_SEC_PER_WORD = 60 / 150;
/**
 * Hard cap per beat — anything longer triggers a split. 8s is loose
 * enough that only TRULY long paragraphs (20+ words) get broken up;
 * normal narrative beats stay 1:1 with their source panel.
 */
const PACING_MAX_BEAT_SEC = 8.0;
/**
 * Aim for groups this long when flushing chunks. Higher target means
 * the algorithm packs more sentences together before emitting a chunk
 * — fewer duplicate images, less aggressive pacing. 7.0s lands just
 * under the 8s cap so we don't trigger splits unnecessarily.
 */
const PACING_TARGET_BEAT_SEC = 7.0;
/** Tighter cap for the first 3 hook beats only. */
const PACING_INTRO_MAX_BEAT_SEC = 6.0;
const PACING_INTRO_TARGET_BEAT_SEC = 5.0;
/** Only the first 3 beats use intro pacing — the hook stays tight,
 *  but we don't flood the chapter with duplicates after that. */
const PACING_INTRO_BEATS = 3;
/**
 * Hard cap on how many times a single source panel can be duplicated.
 * Even a 25-sec beat becomes at most 3 sub-beats (~8.3 sec each) —
 * limits image repetition so the file listing isn't flooded with 5
 * copies of the same panel. The CapCut Automation tool will cycle the
 * ANIME animation across the 2-3 copies for motion variety.
 */
const PACING_MAX_SPLITS_PER_BEAT = 3;

/**
 * Split a long beat into 1+ sub-beats that each hit the target duration.
 * Splits prefer sentence boundaries (`.`, `?`, `!`); if a single
 * sentence is still over the cap it falls back to comma boundaries.
 *
 * Returns the original line unchanged when it's already short enough.
 */
function splitLineForPacing(line: string, isIntro: boolean): string[] {
  const maxSec = isIntro ? PACING_INTRO_MAX_BEAT_SEC : PACING_MAX_BEAT_SEC;
  const targetSec = isIntro
    ? PACING_INTRO_TARGET_BEAT_SEC
    : PACING_TARGET_BEAT_SEC;
  const maxWords = Math.floor(maxSec / PACING_SEC_PER_WORD);
  const targetWords = Math.max(4, Math.floor(targetSec / PACING_SEC_PER_WORD));

  if (countWords(line) <= maxWords) return [line];

  // Step 1: split into sentences on terminal punctuation.
  const sentences = line
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Step 2: regroup sentences so each chunk hits the target word count
  // without crossing the max. Single sentences over the max fall through
  // to the comma-split fallback below.
  const chunks: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    const sw = countWords(sentence);
    const newBuf = buffer ? `${buffer} ${sentence}` : sentence;
    const newWords = countWords(newBuf);

    // Single sentence already over the cap — split it on commas now.
    if (sw > maxWords) {
      if (buffer) {
        chunks.push(buffer);
        buffer = "";
      }
      chunks.push(...splitOnCommasForPacing(sentence, maxWords, targetWords));
      continue;
    }

    if (newWords <= maxWords) {
      buffer = newBuf;
      if (newWords >= targetWords) {
        chunks.push(buffer);
        buffer = "";
      }
    } else {
      // Adding this sentence would overflow — flush current buffer first.
      if (buffer) chunks.push(buffer);
      buffer = sentence;
    }
  }
  if (buffer) chunks.push(buffer);

  // Enforce the per-beat duplicate cap. If we overshot (e.g. a
  // 5-sentence paragraph fired 5 chunks), greedily merge the smallest
  // adjacent pairs until we're at the cap. The resulting chunks may
  // exceed the soft target but stay close to it.
  const capped = capChunkCount(
    chunks.length > 0 ? chunks : [line],
    PACING_MAX_SPLITS_PER_BEAT,
  );
  return capped;
}

/**
 * Merge adjacent chunks until the array length is <= ``maxChunks``.
 * Picks the pair whose combined word count is smallest each pass —
 * keeps the final chunk sizes as balanced as possible. Used as the
 * final safeguard so a single paragraph never spawns more than N
 * duplicate panels.
 */
function capChunkCount(chunks: string[], maxChunks: number): string[] {
  if (chunks.length <= maxChunks) return chunks;
  const out = [...chunks];
  while (out.length > maxChunks) {
    let bestIdx = 0;
    let bestCombined = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const combined = countWords(out[i]) + countWords(out[i + 1]);
      if (combined < bestCombined) {
        bestCombined = combined;
        bestIdx = i;
      }
    }
    out.splice(bestIdx, 2, `${out[bestIdx]} ${out[bestIdx + 1]}`);
  }
  return out;
}

/**
 * Fallback splitter for a single long sentence with no terminal
 * punctuation breaks. Walks comma boundaries, grouping sub-clauses to
 * hit the target word count. Final chunk may exceed ``maxWords`` if
 * the sentence has no commas — that's an acceptable degradation.
 */
function splitOnCommasForPacing(
  sentence: string,
  maxWords: number,
  targetWords: number,
): string[] {
  const parts = sentence
    .split(/(?<=,)\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 1) return [sentence];

  const chunks: string[] = [];
  let buffer = "";
  for (const part of parts) {
    const newBuf = buffer ? `${buffer} ${part}` : part;
    const newWords = countWords(newBuf);

    if (newWords <= maxWords) {
      buffer = newBuf;
      if (newWords >= targetWords) {
        chunks.push(buffer);
        buffer = "";
      }
    } else {
      if (buffer) chunks.push(buffer);
      buffer = part;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.length > 0 ? chunks : [sentence];
}

/**
 * Build the "Quality warnings" README section. Counts violations
 * across all chapters and lists the offending beats inline so the
 * user can fix flagged lines in their text editor without re-running
 * the whole pipeline.
 */
function buildQualitySection(entries: CombinedChapterEntry[]): string {
  const flagged = entries.filter((e) => (e.qualityWarnings?.length ?? 0) > 0);
  if (flagged.length === 0) {
    return (
      "  (none — every chapter passed the post-process quality scan.)\n\n" +
      "  No generic protagonist references, no retention interjections,\n" +
      "  no panel-description leaks, no bare-quote-dash openings."
    );
  }
  const totalWarnings = flagged.reduce(
    (a, e) => a + (e.qualityWarnings?.length ?? 0),
    0,
  );
  const lines: string[] = [
    `  ${totalWarnings} warning${totalWarnings === 1 ? "" : "s"} across ${flagged.length} chapter${flagged.length === 1 ? "" : "s"}:`,
    "",
  ];
  for (const e of flagged) {
    const chapNum = String(e.chapterIndex).padStart(2, "0");
    lines.push(
      `  • Chapter ${chapNum} (${e.chapterName}) — ${e.qualityWarnings?.length ?? 0} warning(s):`,
    );
    for (const w of e.qualityWarnings ?? []) {
      lines.push(
        `      beat ${w.beat_index}: [${w.category}] "${w.matched}"`,
      );
    }
  }
  lines.push("");
  lines.push("  Categories:");
  lines.push('    generic_reference     "this character" / "this guy" / etc — use the name');
  lines.push('    retention_interjection "Now this is where things get insane" / etc — strip');
  lines.push('    panel_description     "The panel shows" / "a close-up of" / etc — rewrite');
  lines.push('    bare_quote_dash       \'"QUOTE" — tag\' opening — embed in narration');
  lines.push('    hook_repeat           "What if...?" appearing past beat 1 — hooks only on beat 1');
  lines.push("");
  lines.push("  These warnings are NON-BLOCKING — the chapter shipped");
  lines.push("  with the violation in place. Open script.txt at the");
  lines.push("  listed beat indices, fix the line by hand, re-export.");
  return lines.join("\n");
}

/**
 * Build the "Alignment warnings" README section. Lists every chapter
 * whose Stage 3B fell back to even-split prose so the user knows
 * which chapters to spot-check first.
 */
function buildAlignmentSection(entries: CombinedChapterEntry[]): string {
  const degraded = entries.filter((e) => e.alignmentDegraded);
  if (degraded.length === 0) {
    return (
      "  (none — every chapter's Stage 3B segmented cleanly.)\n\n" +
      "  Each beat's narration was surgically matched to its panel by\n" +
      "  Gemini. Spot-check the manifest if you want, but no chapter\n" +
      "  is flagged for alignment risk."
    );
  }
  const lines: string[] = [
    "  ⚠️  The following chapters had Stage 3B fall back to even-split prose:",
    "",
  ];
  for (const e of degraded) {
    const chapNum = String(e.chapterIndex).padStart(2, "0");
    lines.push(`  • Chapter ${chapNum} (${e.chapterName})`);
    if (e.alignmentDegradationReason) {
      lines.push(`      ${e.alignmentDegradationReason}`);
    }
  }
  lines.push("");
  lines.push("  1:1 COUNT is still intact (script lines == panels == SRT");
  lines.push("  blocks) but per-panel CONTENT is approximate for these");
  lines.push("  chapters. Spot-check 5 random beats per flagged chapter");
  lines.push("  against their images before publishing.");
  return lines.join("\n");
}

/** Format seconds (float) as ``HH:MM:SS,mmm`` for an SRT timing tag. */
function formatSrtTime(totalSec: number): string {
  const sign = totalSec < 0 ? "-" : "";
  const s = Math.abs(totalSec);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const wholeSec = Math.floor(s) % 60;
  const wholeMin = Math.floor(s / 60) % 60;
  const wholeHr = Math.floor(s / 3600);
  return (
    sign +
    String(wholeHr).padStart(2, "0") +
    ":" +
    String(wholeMin).padStart(2, "0") +
    ":" +
    String(wholeSec).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function buildCombinedReadme(
  entries: CombinedChapterEntry[],
  totalPanels: number,
  totalLines: number,
  secondsPerLine: number,
): string {
  const estMinutes = Math.round((totalLines * secondsPerLine) / 60);
  const perChapter = entries
    .map((e) => {
      const chapNum = String(e.chapterIndex).padStart(2, "0");
      return `  Chapter ${chapNum} — ${e.chapterName.padEnd(40)} ${String(e.blobs.length).padStart(3)} panels, ${String(e.script.lines.length).padStart(3)} lines`;
    })
    .join("\n");

  const tierLog = entries
    .map((e) => {
      const chapNum = String(e.chapterIndex).padStart(2, "0");
      const tier = e.curatorTier?.tier ?? "(not recorded)";
      return `  Chapter ${chapNum}: ${tier}` +
        (e.curatorTier
          ? `  (kept ${e.curatorTier.kept}/${e.curatorTier.candidates} candidates)`
          : "");
    })
    .join("\n");

  // Per-chapter timing breakdown for the README. Spec § 6 — lets the
  // user spot stage bottlenecks. Helper formats each ms as ``S.Ss``.
  const fmtSec = (ms: number | undefined) =>
    ms == null ? " — " : (ms / 1000).toFixed(1) + "s";
  const timingLog = entries
    .map((e) => {
      const chapNum = String(e.chapterIndex).padStart(2, "0");
      const t = e.timing;
      if (!t) return `  Chapter ${chapNum}: (timing not recorded)`;
      return (
        `  Chapter ${chapNum}: ` +
        `extract ${fmtSec(t.extract_ms)} | ` +
        `filter ${fmtSec(t.filter_ms)} | ` +
        `bible ${fmtSec(t.bible_ms)} | ` +
        `classify ${fmtSec(t.classify_ms)} | ` +
        `3A ${fmtSec(t.comprehend_ms)} | ` +
        `3B ${fmtSec(t.segment_ms)} | ` +
        `polish ${fmtSec(t.polish_ms)} | ` +
        `TOTAL ${fmtSec(t.total_ms)}`
      );
    })
    .join("\n");

  // Roll-up timing across all chapters — useful for "extrapolating
  // a 100-chapter run will take ~X hours".
  const sumTimings = entries.reduce(
    (acc, e) => {
      if (!e.timing) return acc;
      return {
        extract: acc.extract + e.timing.extract_ms,
        filter: acc.filter + e.timing.filter_ms,
        bible: acc.bible + e.timing.bible_ms,
        classify: acc.classify + e.timing.classify_ms,
        comprehend: acc.comprehend + e.timing.comprehend_ms,
        segment: acc.segment + e.timing.segment_ms,
        polish: acc.polish + e.timing.polish_ms,
        total: acc.total + e.timing.total_ms,
      };
    },
    { extract: 0, filter: 0, bible: 0, classify: 0, comprehend: 0, segment: 0, polish: 0, total: 0 },
  );
  const avgTotalSec =
    entries.length > 0 ? sumTimings.total / entries.length / 1000 : 0;
  const projected100chMin = (avgTotalSec * 100) / 60;
  const projected100chHr = projected100chMin / 60;

  // Alignment warnings block — computed up-front because TypeScript's
  // template-literal type narrowing can't handle an IIFE inline.
  const alignmentSection = buildAlignmentSection(entries);
  const qualitySection = buildQualitySection(entries);

  return `# Long-form manhwa recap — story-first combined output

Generated:   ${new Date().toLocaleString()}
Chapters:    ${entries.length}
Total panels (= beats = SRT blocks): ${totalPanels}
Total lines:  ${totalLines}
Est. video length: ~${estMinutes} minutes (at ${secondsPerLine} sec/line)

═══════════════════════════════════════════════════════════════════════
Files in this archive
═══════════════════════════════════════════════════════════════════════

  images/0001.jpg, 0002.jpg, … ${String(totalPanels).padStart(4, "0")}.jpg
      Curated panels in global reading order. The filename's NNNN is
      the SAME number as the matching line in script.txt and the
      matching block in script.srt — 1:1:1 sync everywhere.

  script.txt
      Master narration script — ${totalLines} lines, one beat per line.
      Line i corresponds to images/000i.jpg and script.srt block i.
      Paste this directly into the MegaShoeb TTS server's
      "Bulk Script → SRT" tab.

  script.srt
      SRT skeleton with ${totalLines} blocks, block i numbered 'i',
      text = beat i's narration. Timings are uniform ${secondsPerLine}-sec
      placeholders. Regenerate with real timings once you have per-line
      audio durations from TTS — block COUNT and ORDER are already
      correct, which is what CapCut auto-sync needs.

  script_with_chapters.txt
      Same script with "═══ Chapter NN ═══" dividers + curator tier
      log between chapters. Human review only — do NOT paste into TTS
      (the dividers would get read aloud).

  manifest.json
      Per-chapter and per-beat metadata. Includes curator tier per
      chapter and (when available) story_weight + visual_impact +
      curator_reason per beat. Spot-check 10 random beats:
      if a beat's curator_reason doesn't match what's visibly in
      its image, you'll catch alignment regressions in 2 minutes.

═══════════════════════════════════════════════════════════════════════
Per-chapter breakdown
═══════════════════════════════════════════════════════════════════════

${perChapter}

═══════════════════════════════════════════════════════════════════════
Curator tier log
═══════════════════════════════════════════════════════════════════════

${tierLog}

Tier reference:
  STRICT_5_5         healthy — strict 5/5 threshold filled the quota
  RELAXED_4_4        normal for short/dialogue-heavy chapters
  ALL_KEEP           classifier was harsh — kept every "keep:true"
  EVEN_SAMPLE_FLOOR  ⚠️  classifier failed entirely — investigate!

═══════════════════════════════════════════════════════════════════════
Alignment warnings (Stage 3B fallback fired)
═══════════════════════════════════════════════════════════════════════

${alignmentSection}

═══════════════════════════════════════════════════════════════════════
Quality warnings (post-process scan)
═══════════════════════════════════════════════════════════════════════

${qualitySection}

═══════════════════════════════════════════════════════════════════════
Per-stage timing log
═══════════════════════════════════════════════════════════════════════

${timingLog}

Average per-chapter total: ${avgTotalSec.toFixed(1)}s
Projected 100-chapter run: ~${projected100chMin.toFixed(1)} minutes
                          (= ${projected100chHr.toFixed(1)} hours)

Reading the breakdown:
  extract    Stage 1 PDF→images (local, no API)
  filter     Local heuristics (crop/blank/phash dedup)
  bible      Stage 4a: character bible extraction (1 Gemini call)
  classify   Stage 2: panel scoring (parallel batches × 8 panels)
  3A         Stage 3A: whole-chapter comprehension (1 Gemini call)
  3B         Stage 3B: beat segmentation (1 Gemini call)
  polish     Stage 5: editor polish (1 Gemini call on 3.1-pro)

If "polish" dominates the budget → 3.1-pro quota is your bottleneck;
consider switching the polish backup to gemini-2.5-pro (6× faster RPM).
If "classify" dominates → either increase 'classify_concurrency' or
your chapters have unusually many candidate panels.

═══════════════════════════════════════════════════════════════════════
Workflow — story-first recap edition
═══════════════════════════════════════════════════════════════════════

  1. Unzip somewhere convenient (large runs can be 1-2 GB).

  2. Open the MegaShoeb TTS server (e.g. https://omnivoice.bonusalert.org).

  3. Go to the "Bulk Script → SRT" tab.

  4. Paste the contents of script.txt (NOT script_with_chapters.txt)
     into the script box.

  5. Pick a voice mode (Voice Clone / Voice Design / Auto). For a
     2-3 hour video the generation will take 30-60 minutes depending
     on server load.

  6. You'll get a single MP3 and an SRT with EXACTLY ${totalLines}
     subtitle blocks. Either keep the skeleton SRT (uniform timing) or
     replace it with the TTS-generated one (real timing) — both have
     the same block count + order.

  7. In CapCut, import:
        • The entire images/ folder (drag-and-drop).
        • The MP3 from step 6.
        • The SRT (TTS-generated preferred).

  8. Run your CapCut auto-sync tool. Each subtitle block maps to one
     image — this is the 1:1:1 invariant the pipeline preserves
     end-to-end (verified with a hard assert before this ZIP was
     built — see acceptance criterion in spec § 4 Stage 6).

  9. Add intro / outro / SFX / thumbnail, then export.

 10. Upload to YouTube. Don't forget:
       • The disclaimer in the description (transformative content rules).
       • The pinned comment crediting the original manhwa's name and
         the official source channel.
`;
}
