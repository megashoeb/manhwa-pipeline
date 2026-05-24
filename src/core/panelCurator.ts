// Stage 2 — strong-panel selection (spec §5 Stage 2).
//
// Two-layer filter:
//   Layer A (cheap, local): imagehash dedup + blank detector.
//            (handled upstream in filterPipeline.ts via phash + blank
//             stats — by the time pages reach here they've passed.)
//
//   Layer B (this file): AI classifier. Each panel gets a JSON score
//            with story_weight (plot value) and visual_impact (art
//            strength). Strict threshold: keep ONLY if both axes ≥ 5.
//            If <8 panels survive strict, relax to ≥ 4 / ≥ 4 until
//            we have ≥ MIN_KEEP. Rank kept by combined score, take
//            top MAX_KEEP, preserve original reading order.
//
// Batching: spec calls for 35 images per call. Sending all panels in
// one shot is faster but blows past Gemini's per-call cap on dense
// chapters AND makes JSON parsing harder when the response is long.
// 35 hits the sweet spot per Google's vision throughput guidance.
//
// Model: gemini-2.0-flash-lite per spec — unlimited RPD, 4000 RPM.
// Cheap enough to run on every panel of every chapter.

import type { CharacterBible, FilteredPage } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

import { generateContent } from "./geminiClient";
import { downscaleBlobs } from "./imageDownscale";
import { tryJsonParse } from "./jsonRepair";

/**
 * Minimum panels to keep per chapter. 15 = floor for story-first
 * comprehension to have enough beats to convey setup + motivation +
 * stakes. Below this the recap reads as a skeleton.
 */
const MIN_KEEP = 15;
/**
 * Maximum panels per chapter. Tuned for SPEED — at 25 panels the
 * Stage 3A/3B uploads stay small (~6-8 MB) and Gemini compute drops
 * 30-40% vs 40 panels. Trade-off: chapters average ~2 min in final
 * video instead of ~3 min, but 80-chapter run finishes ~90 min faster.
 *
 * Math at the new pacing:
 *   25 panels × ~5 sec/beat = ~2 min per chapter
 *   80 chapters × 2 min = ~2.5 hr total video
 *   Per-chapter Gemini time drops from ~6 min to ~4.5 min
 */
const MAX_KEEP = 25;
/**
 * Strict threshold per spec. Either axis below this and the panel is
 * dropped. Both must clear ≥ 5 for "strong panel" classification.
 */
const STRICT_THRESHOLD = 5;
/**
 * Relaxed threshold — applied only if strict filtering leaves us with
 * <MIN_KEEP panels. Prevents tiny chapters from being over-filtered.
 */
const RELAXED_THRESHOLD = 4;
/**
 * Spec v3-defined batch size for classifier calls (§4 Stage 2):
 * 8 images/call. A flash-lite model returns reliable aligned JSON for
 * 8 panels; pushing to 35 like the older spec causes more count drift.
 * RPD is unlimited so the extra calls cost nothing.
 */
const IMAGES_PER_BATCH = 8;
/**
 * Spec v3 §6 — run classifier batches in parallel up to this many
 * concurrent calls. With 4 in flight, a chapter with 6-8 batches
 * finishes in ~2 wall-clock rounds instead of 8 sequential ones.
 * Cap is low because gemini-2.0-flash-lite has 4000 RPM headroom but
 * the key rotator + image upload latency benefit most from moderate
 * concurrency; higher numbers hit diminishing returns.
 */
const CLASSIFY_CONCURRENCY = 4;
/**
 * Longest edge to which classifier inputs are downscaled before upload.
 * Gemini Vision downscales inputs to ~768px internally anyway, so
 * sending the original 200-DPI panel (often 1500×2200 px) just burns
 * upload bandwidth. We pre-shrink so each classify call uploads ~10×
 * less data. High-res blobs stay untouched in ``pages`` for Stage 3A/3B
 * downstream — those calls DO need the dialogue text to be readable.
 */
const CLASSIFIER_DOWNSCALE_PX = 768;

/**
 * Per-panel score returned by the classifier. Mirrors the spec's JSON
 * schema in §5 Stage 2.
 */
export interface PanelScore {
  /** Position in the input ``pages`` array (0-based). */
  index: number;
  /** Gemini's keep/drop verdict. */
  keep: boolean;
  /** 0-10: plot/story value (action, reveal, dialogue, emotion turn). */
  story_weight: number;
  /** 0-10: art strength (clarity, composition, dramatic impact). */
  visual_impact: number;
  /** Short human-readable reason. Surfaced for debug/manifest. */
  reason: string;
}

/**
 * Which threshold tier ended up firing for this chapter's curation.
 * Surfaced to the manifest so the user can spot quality regressions:
 * if EVEN-SAMPLE-FLOOR fires regularly, the AI classifier is broken
 * or the chapters are systematically dropping below the strict bar.
 */
export type CuratorTier =
  | "STRICT_5_5" // ≥ 15 panels passed story_weight ≥ 5 AND visual_impact ≥ 5
  | "RELAXED_4_4" // strict left < 15, dropped to ≥ 4 AND ≥ 4
  | "ALL_KEEP" // even relaxed left < 15, kept everything Gemini said keep:true
  | "EVEN_SAMPLE_FLOOR"; // classifier returned nothing useful — evenly sampled

export interface CuratorTierLog {
  tier: CuratorTier;
  /** Final kept count after the tier resolution. */
  kept: number;
  /** Total panels the classifier was asked to score. */
  candidates: number;
}

export interface CurateOptions {
  model: string;
  rotator: KeyRotator;
  bible: CharacterBible;
  onKeyUsed?: (masked: string) => void;
  onProgress?: (current: number, total: number, msg: string) => void;
  /**
   * Optional callback fired with the full per-panel score list. The
   * pipeline can pass these into the manifest for debugging which
   * panels were dropped and why.
   */
  onScores?: (scores: PanelScore[]) => void;
  /**
   * Fired once per chapter with the tier that fired (STRICT / RELAXED
   * / ALL_KEEP / EVEN_SAMPLE_FLOOR). Spec acceptance criterion: the
   * EVEN-SAMPLE-FLOOR tier firing more than rarely is a bug indicator.
   */
  onTier?: (log: CuratorTierLog) => void;
}

/**
 * Curate a chapter's kept panels down to the long-form-recap subset.
 *
 * Returns the panels in original reading order. If the AI returns
 * unparseable garbage, we fall back to an evenly-spaced sample so
 * the chapter still contributes SOMETHING.
 */
export async function curatePanels(
  pages: FilteredPage[],
  options: CurateOptions,
): Promise<FilteredPage[]> {
  if (pages.length === 0) return pages;
  if (pages.length <= MIN_KEEP) {
    // Tiny chapter — no point classifying, keep everything.
    return pages;
  }

  options.onProgress?.(
    0,
    1,
    `Curating ${pages.length} panels (strong-panel filter)…`,
  );

  // ----- Dual-resolution (spec §1 Stage 1) -------------------------
  // Pre-downscale every panel to ~768px longest edge for the
  // classifier calls. Gemini Vision downscales to ~768 internally
  // anyway, so uploading 1500×2200 high-res panels here just burns
  // bandwidth. We do this ONCE up front so each batch reuses the
  // downscaled blobs.
  //
  // The original high-res ``pages`` array stays untouched — Stage 3A
  // and 3B downstream still receive the readable 200-DPI versions
  // they need to parse dialogue text.
  options.onProgress?.(0, 1, `Preparing ${pages.length} panels for classifier…`);
  const lowResBlobs = await prepareClassifierBlobs(pages);

  // Batch the panels into spec-defined groups of 8.
  const batches: { startIdx: number; pages: FilteredPage[]; blobs: Blob[] }[] =
    [];
  for (let i = 0; i < pages.length; i += IMAGES_PER_BATCH) {
    batches.push({
      startIdx: i,
      pages: pages.slice(i, i + IMAGES_PER_BATCH),
      blobs: lowResBlobs.slice(i, i + IMAGES_PER_BATCH),
    });
  }

  // ----- Parallel batch execution (spec §6 concurrency 4) ----------
  // Worker pool: at most CLASSIFY_CONCURRENCY classifier calls in
  // flight at once. Each batch's scores are written to its slot by
  // global position so the final ``allScores`` array is reading-order
  // aligned regardless of which batch finishes first.
  const allScores: PanelScore[] = new Array(pages.length);
  let nextBatch = 0;
  let finishedBatches = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const b = nextBatch++;
      if (b >= batches.length) return;
      const { startIdx, pages: batchPages, blobs: batchBlobs } = batches[b];

      options.onProgress?.(
        finishedBatches,
        batches.length,
        `Classifying batch ${b + 1}/${batches.length} (${batchPages.length} panels, ${CLASSIFY_CONCURRENCY} in parallel)…`,
      );

      const batchScores = await classifyBatch(batchPages, batchBlobs, options);
      for (let i = 0; i < batchPages.length; i++) {
        const s = batchScores[i] ?? defaultRejection(startIdx + i);
        s.index = startIdx + i;
        allScores[startIdx + i] = s;
      }
      finishedBatches++;
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(CLASSIFY_CONCURRENCY, batches.length) },
      () => runWorker(),
    ),
  );

  options.onScores?.(allScores);

  // ----- Filter / rank with tier tracking -------------------------
  let tier: CuratorTier = "STRICT_5_5";
  let kept = allScores.filter(
    (s) =>
      s.keep &&
      s.story_weight >= STRICT_THRESHOLD &&
      s.visual_impact >= STRICT_THRESHOLD,
  );

  if (kept.length < MIN_KEEP) {
    console.warn(
      `Curator STRICT_5_5 pass kept ${kept.length}/${pages.length} ` +
        `(needed ≥ ${MIN_KEEP}). Relaxing to ${RELAXED_THRESHOLD}/${RELAXED_THRESHOLD}.`,
    );
    tier = "RELAXED_4_4";
    kept = allScores.filter(
      (s) =>
        s.keep &&
        s.story_weight >= RELAXED_THRESHOLD &&
        s.visual_impact >= RELAXED_THRESHOLD,
    );
  }
  if (kept.length < MIN_KEEP) {
    console.warn(
      `Curator RELAXED_4_4 pass kept ${kept.length}/${pages.length}. ` +
        `Falling back to ALL_KEEP — every panel Gemini marked keep:true.`,
    );
    tier = "ALL_KEEP";
    kept = allScores.filter((s) => s.keep);
  }
  // Absolute floor — if classifier failed entirely, evenly sample.
  if (kept.length < MIN_KEEP) {
    console.warn(
      `Curator ALL_KEEP pass kept ${kept.length}/${pages.length}. ` +
        `EVEN_SAMPLE_FLOOR firing — classifier appears broken for this ` +
        `chapter. Sampling ${MIN_KEEP} panels evenly to keep run alive. ` +
        `If this fires regularly, investigate classifier health.`,
    );
    options.onTier?.({
      tier: "EVEN_SAMPLE_FLOOR",
      kept: MIN_KEEP,
      candidates: pages.length,
    });
    return evenSamplePages(pages, MIN_KEEP);
  }

  // Rank by combined score (descending), trim to MAX_KEEP.
  kept.sort(
    (a, b) =>
      b.story_weight + b.visual_impact - (a.story_weight + a.visual_impact),
  );
  if (kept.length > MAX_KEEP) kept = kept.slice(0, MAX_KEEP);

  // Restore reading order so the narrator gets panels in sequence.
  kept.sort((a, b) => a.index - b.index);

  options.onTier?.({
    tier,
    kept: kept.length,
    candidates: pages.length,
  });
  options.onProgress?.(
    batches.length,
    batches.length,
    `Curated ${kept.length}/${pages.length} strong panels [${tier}].`,
  );
  return kept.map((s) => pages[s.index]);
}

// ---------------------------------------------------------------------
// Classifier (one batch) — with size-mismatch retry + drop-whole-batch
// safety net.
//
// CRITICAL safety property: this function NEVER returns a partial /
// padded score array that could silently misalign panel indices. The
// caller in ``curatePanels`` maps position-in-batch → panel position,
// so if Gemini returns N scores for a 35-image batch where N != 35,
// we have NO way to know WHICH input panels got dropped — naively
// padding the end would mis-attribute scores to wrong panels.
//
// Recovery chain:
//   1. Attempt 1: standard call. If parsed count == batch.length → done.
//   2. Attempt 2: corrective retry with the wrong count quoted back.
//      Low temperature + structural prompt usually wins this round.
//   3. Still mismatched → DROP THE ENTIRE BATCH. Every panel in the
//      batch gets a default rejection. Quality loss (35 panels lost
//      from this chapter), but ZERO misalignment risk. Caller's relax
//      / even-sample fallback chain handles the chapter from there.

async function classifyBatch(
  batch: FilteredPage[],
  batchBlobs: Blob[],
  options: CurateOptions,
): Promise<PanelScore[]> {
  // --- Attempt 1 -----------------------------------------------------
  const firstPrompt = buildPrompt(batch.length, options.bible, null);
  const firstRaw = await tryClassify(firstPrompt, batchBlobs, options);
  if (firstRaw === null) return dropBatch(batch.length);

  const firstScores = parseScoreArray(firstRaw, batch.length);
  if (firstScores.length === batch.length) return firstScores;

  // --- Attempt 2 (corrective retry on size mismatch) -----------------
  console.warn(
    `Classifier attempt 1 returned ${firstScores.length} scores for ` +
      `${batch.length}-panel batch. Retrying with corrective preamble ` +
      `(misalignment risk if we accepted this).`,
  );
  const retryPrompt = buildPrompt(
    batch.length,
    options.bible,
    firstScores.length,
  );
  const retryRaw = await tryClassify(retryPrompt, batchBlobs, options);
  if (retryRaw === null) return dropBatch(batch.length);

  const retryScores = parseScoreArray(retryRaw, batch.length);
  if (retryScores.length === batch.length) return retryScores;

  // --- Persistent mismatch → drop entire batch (NEVER misalign) ------
  console.error(
    `❌ Classifier retry STILL returned ${retryScores.length} for ${batch.length}-panel batch. ` +
      `Dropping ENTIRE batch (${batch.length} panels → default-reject) ` +
      `to preserve panel alignment. The chapter's relax-threshold ` +
      `fallback or even-sample fallback will recover panel count.`,
  );
  return dropBatch(batch.length);
}

/**
 * Make one classifier call. Returns the raw response text on success,
 * or ``null`` on network / API failure so the caller can fall through
 * to its own drop-batch path.
 */
async function tryClassify(
  prompt: string,
  blobs: Blob[],
  options: CurateOptions,
): Promise<string | null> {
  try {
    return await generateContent(options.rotator, {
      model: options.model,
      prompt,
      images: blobs,
      // Low temperature — we want deterministic, criteria-based scoring,
      // not creative interpretation of "which panels matter".
      temperature: 0.25,
      topP: 0.9,
      onKeyUsed: options.onKeyUsed,
    });
  } catch (err) {
    console.warn(
      `Classifier call failed (${blobs.length} images): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Pre-downscale every page's blob to ~768 px longest edge for the
 * classifier call. Uses the shared ``downscaleBlobs`` helper so the
 * same logic runs in Stage 2 (here), 3A (comprehend), and 3B (segment).
 */
async function prepareClassifierBlobs(
  pages: FilteredPage[],
): Promise<Blob[]> {
  return downscaleBlobs(
    pages.map((p) => p.blob),
    CLASSIFIER_DOWNSCALE_PX,
    4, // concurrency — balances CPU/memory load
  );
}

/**
 * Build a size-N array of default rejections — used when the entire
 * batch must be dropped to preserve alignment. Every panel gets
 * ``keep: false`` with a clear reason so the manifest later shows
 * exactly why the batch was excluded.
 */
function dropBatch(size: number): PanelScore[] {
  const out: PanelScore[] = [];
  for (let i = 0; i < size; i++) {
    out.push({
      index: i,
      keep: false,
      story_weight: 0,
      visual_impact: 0,
      reason: "(batch dropped: classifier size mismatch after retry)",
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Parser — robust JSON-array extraction from Gemini's free-form output
// ---------------------------------------------------------------------

/**
 * Parse Gemini's classifier response into a PanelScore array.
 *
 * IMPORTANT: this function does NOT pad or truncate. It returns
 * EXACTLY ``arr.length`` parsed scores (where ``arr`` is the JSON
 * array Gemini emitted). The caller is responsible for checking
 * that the returned length equals the expected batch size — any
 * mismatch must trigger a retry or whole-batch drop, NEVER silent
 * realignment.
 *
 * Why: if Gemini drops/adds a panel mid-array, padding the END
 * misattributes scores to wrong panels (panel 4's score lands on
 * panel 3, etc.). The only safe response to a length mismatch is
 * to ask Gemini to redo the call or reject the whole batch.
 *
 * Returns ``[]`` on:
 *   - No JSON array found in the response
 *   - JSON parse error
 *   - Top-level value isn't an array
 * Each of these means "we got nothing useful" — the caller drops
 * the batch entirely.
 */
function parseScoreArray(raw: string, _expected: number): PanelScore[] {
  // Tolerant parse — handles common LLM output corruption (smart
  // quotes, trailing commas, truncated arrays). Returns [] only when
  // the response is genuinely unrecoverable; caller drops the batch.
  const arr = tryJsonParse<unknown>(raw, "array");
  if (!Array.isArray(arr)) return [];

  // Return EXACTLY arr.length scores. No truncation, no padding —
  // the caller compares this length to batch.length and retries /
  // drops the batch on mismatch.
  const out: PanelScore[] = [];
  for (let i = 0; i < arr.length; i++) {
    const o = arr[i];
    if (typeof o !== "object" || o === null) {
      // Malformed individual entry — still preserve position by
      // emitting a default rejection at this slot. Length stays
      // aligned with the input array.
      out.push(defaultRejection(i));
      continue;
    }
    const rec = o as Record<string, unknown>;
    const keep = rec.keep === true;
    const story = clamp01to10(rec.story_weight);
    const visual = clamp01to10(rec.visual_impact);
    const reason =
      typeof rec.reason === "string" ? rec.reason : "(no reason given)";
    out.push({
      index: i,
      keep,
      story_weight: story,
      visual_impact: visual,
      reason,
    });
  }
  return out;
}

// (extractBalancedArray moved to ./jsonRepair as part of safeJsonParse.)

function clamp01to10(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, n));
}

function defaultRejection(index: number): PanelScore {
  return {
    index,
    keep: false,
    story_weight: 0,
    visual_impact: 0,
    reason: "(classifier did not return a score for this panel)",
  };
}

/** Evenly-spaced fallback when the classifier fails entirely. */
function evenSamplePages(pages: FilteredPage[], n: number): FilteredPage[] {
  if (pages.length <= n) return pages;
  const step = pages.length / n;
  const out: FilteredPage[] = [];
  for (let i = 0; i < n; i++) out.push(pages[Math.floor(i * step)]);
  return out;
}

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

function buildPrompt(
  n: number,
  bible: CharacterBible,
  previousAttemptCount: number | null,
): string {
  const characters =
    Object.entries(bible.characters)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n") || "(no named characters yet)";

  // Only present on the SECOND attempt — quotes the wrong count back
  // to Gemini so it can self-correct rather than repeating the drift.
  // First attempt has empty corrective so the regular prompt runs clean.
  const corrective =
    previousAttemptCount !== null
      ? `
═══════════════════════════════════════════════════════════════════════
⚠️  RETRY — PREVIOUS ATTEMPT RETURNED WRONG ARRAY LENGTH
═══════════════════════════════════════════════════════════════════════
Your previous attempt returned ${previousAttemptCount} JSON objects.
The input has EXACTLY ${n} panels.
Your output array MUST have EXACTLY ${n} objects, one per panel, in
input order — even if many panels are "drop" (just emit the JSON with
keep:false for those, do NOT omit them).

Each panel position must have its OWN JSON object — no merging,
no skipping, no dropping. The downstream pipeline aligns by array
position, so a missing object would silently shift every subsequent
panel's score onto the wrong panel.

Count your output array before finishing. If length != ${n}, you must
adjust by adding the missing keep:false objects.

`
      : "";

  return `${corrective}You are a manhwa panel SELECTOR for a high-quality YouTube long-form recap video. Your judgement decides which panels are strong enough to appear on screen.

You will see ${n} panels in reading order. For EACH panel, return a single JSON object with this exact schema:

{
  "keep": true | false,
  "story_weight": <integer 0-10>,
  "visual_impact": <integer 0-10>,
  "reason": "<short reason, max 12 words>"
}

CHARACTERS in this story (for context):
${characters}

═══════════════════════════════════════════════════════════════════════
SCORING AXES
═══════════════════════════════════════════════════════════════════════

STORY_WEIGHT — how much does this panel advance the PLOT?

  9-10  Major reveal, identity unmask, death, decisive victory,
        first appearance of a named character, oath/declaration
        that changes everything.
  7-8   Clear story event — combat strike, key dialogue line,
        emotional turn that shifts a character's arc, scene shift
        to a meaningful new location.
  5-6   Solid beat but supporting role — a reaction shot that
        carries weight, an environmental detail that matters,
        a transition with clear story progression.
  3-4   Mild beat — a follow-up reaction, a small movement, a
        line of filler dialogue.
  0-2   No story value — filler, transition, atmospheric beat.

VISUAL_IMPACT — how STRONG is the PICTORIAL ART (NOT counting text)?

Critical: judge only the PICTORIAL portion of the frame — characters,
environment, action, debris. TEXT (stylized name flair, SFX glyphs,
caption labels) does NOT count toward visual_impact, even if the text
is dramatic-looking. A panel that is 80% black with only the stylized
word "ELENA" floating in the middle has near-zero pictorial content
even though the text is decorative — it scores visual_impact 2-3, NOT 7.

THE 30% RULE: if the non-text, non-empty PICTORIAL area covers under
30% of the frame, visual_impact MUST be ≤ 3 (regardless of how
stylized the text is). Examples that get visual_impact ≤ 3:

  • 80% black background, single floating word "ELENA" in stylized text
  • 85% empty white, "LIKE A MANIACAL SWORD MASTER" caption only
  • Mostly empty frame, one motion-blur streak + an SFX glyph
  • Solid color background with only a chapter title typography

  9-10  Striking composition — full-character action, dramatic
        lighting, clear focal point, dynamic posing, full-spread.
  7-8   Clear, readable art — characters identifiable, action
        legible, good composition.
  5-6   Acceptable — readable but not striking. Maybe small
        figure, simple framing.
  3-4   Weak art — tiny figure, cluttered, muddy, off-balance,
        confusing composition.
  0-2   Near-empty / blank / pure SFX / mostly white or black
        space with tiny content fragment.

═══════════════════════════════════════════════════════════════════════
KEEP / DROP RULES
═══════════════════════════════════════════════════════════════════════

Set "keep": true ONLY IF story_weight >= 5 AND visual_impact >= 5.

Set "keep": false (and BOTH scores low) for ANY of these:

  ✗ Isolated body-part close-up with no action — a lone eye, a
    jaw fragment, a hand alone, a sword-tip resting on empty
    ground, etc.
  ✗ Pure sound-effect / SFX-only panel ("타", "BOOM", "CRACK"
    glyphs with no figure or environment).
  ✗ Transition / atmosphere frame with no plot — fades, motion
    blurs alone, sparks alone, gradient panels.
  ✗ More than 70% empty / white / single-color space with only
    a tiny content fragment in one corner. This INCLUDES panels
    where the "content" is just stylized text or SFX glyphs:
       ✗ Black panel with only "ELENA" in dramatic typography
       ✗ White panel with only "BAM!" or "타!!" SFX glyph
       ✗ Empty frame with only a caption label like
         "LIKE A MANIACAL SWORD MASTER"
    These are DECORATIVE TEXT CARDS, not story-bearing panels.
    Drop them. The next pictorial panel will carry the moment.

    EXCEPTION — dialogue cards with full sentence-form quotes
    (e.g. solid black with "I KNOW THAT NAME VERY WELL." or
     "GIVE ME THE RIGHT TO COMMAND.") DO carry story content
    and CAN be kept. The distinction: a full quoted SENTENCE
    of dialogue = story content; a single stylized name or
    flair-caption phrase = decorative, drop.
  ✗ Near-duplicate of an adjacent panel (same beat from another
    angle, same reaction shown twice).
  ✗ Art too muddy / tiny / cluttered to read clearly — even if
    "something is happening", if the viewer can't tell what,
    the panel can't carry the recap.

GOLDEN RULE: when unsure, DROP. A tighter recap of ONLY strong
panels beats a padded one with filler.

═══════════════════════════════════════════════════════════════════════
OUTPUT FORMAT — STRICT
═══════════════════════════════════════════════════════════════════════

Return EXACTLY a JSON array of ${n} objects, one per panel, in input
order. No prose. No markdown fences. No commentary. JUST the array.

EXAMPLE (for n=3):
[
  {"keep": true,  "story_weight": 8, "visual_impact": 7, "reason": "key reveal, clear close-up"},
  {"keep": false, "story_weight": 2, "visual_impact": 3, "reason": "lone sword tip, no action"},
  {"keep": true,  "story_weight": 9, "visual_impact": 9, "reason": "decisive strike, full-figure action"}
]

Now score the ${n} attached panels:`;
}
