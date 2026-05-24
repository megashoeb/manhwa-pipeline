// Stage 3B — beat segmentation + panel matching.
//
// Takes the WHOLE-CHAPTER prose from Stage 3A (comprehend.ts) and the
// SAME N curated panels, and splits the prose into EXACTLY N beats so
// that beat i corresponds to panel i's moment in the story.
//
// This is the bridge between "story-first writing" (Stage 3A) and
// "1:1 panel↔line invariant required by the video pipeline" (Stage 6).
//
// Why a separate call instead of asking 3A to output N beats directly:
// 3A focuses on STORY comprehension — explaining setup, motivation,
// stakes from the whole chapter. Forcing it to also emit exactly-N
// numbered beats degrades narration quality (it becomes a panel
// describer again). Splitting the responsibilities lets each call
// optimise its own job.
//
// Critical guard: output array length MUST equal N. On mismatch we
// retry once with a corrective preamble. If retry also fails, we
// fall back to evenly splitting 3A's prose into N chunks — preserves
// 1:1 even if Gemini can't follow the count instruction. Never breaks
// SRT sync downstream.
//
// Model: gemini-2.5-flash per spec § 4 Stage 3B.

import type { FilteredPage } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

import { generateContent } from "./geminiClient";
import { downscaleBlobs } from "./imageDownscale";
import { tryJsonParse } from "./jsonRepair";

export interface SegmentOptions {
  model: string;
  rotator: KeyRotator;
  onKeyUsed?: (masked: string) => void;
  onProgress?: (current: number, total: number, msg: string) => void;
}

/**
 * Outcome of the segmentation. ``beats`` is always present and has
 * exactly ``panels.length`` entries (the 1:1 invariant is sacred).
 *
 * ``alignmentDegraded`` flips true when the even-split fallback fired
 * — meaning the count was preserved but Gemini failed to match each
 * beat to its panel surgically. Surface this in the manifest so the
 * user knows which chapters need a manual spot-check.
 */
export interface SegmentResult {
  beats: string[];
  alignmentDegraded: boolean;
  /**
   * Short human-readable reason for the degradation flag. Empty when
   * ``alignmentDegraded`` is false. Logged in the manifest's chapter
   * entry so the user can grep for problems across a 100-chapter run.
   */
  degradationReason: string;
}

/**
 * Split a whole-chapter prose narration into EXACTLY ``panels.length``
 * beats. Each returned string is one beat (one panel's worth of
 * narration), in reading order — beat i corresponds to panel i.
 *
 * Recovery chain:
 *   Attempt 1 → standard call. If array.length == N → done.
 *   Attempt 2 → corrective retry with wrong count quoted back.
 *   Still wrong → evenly split prose into N chunks (preserves 1:1).
 *
 * Never throws on count mismatch — falls through to the safe split.
 */
export async function segmentIntoBeats(
  prose: string,
  panels: FilteredPage[],
  options: SegmentOptions,
): Promise<SegmentResult> {
  const n = panels.length;
  if (n === 0) {
    return { beats: [], alignmentDegraded: false, degradationReason: "" };
  }
  if (prose.trim().length === 0) {
    console.warn("segmentIntoBeats: empty prose input. Falling back to placeholders.");
    return {
      beats: placeholderBeats(n),
      alignmentDegraded: true,
      degradationReason: "Stage 3A produced no prose; beats are placeholders.",
    };
  }

  options.onProgress?.(0, 1, `Segmenting story into ${n} panel-aligned beats…`);

  // Downscale the panel blobs ONCE for this stage — reused across
  // attempt 1 and the corrective retry. Big upload-time win: 28
  // high-res panels at 200 DPI = ~30 MB upload; downscaled to 768 px
  // longest edge = ~8-10 MB. Gemini Vision downscales internally
  // anyway, so we lose nothing in quality.
  const visionBlobs = await downscaleBlobs(panels.map((p) => p.blob));

  // --- Attempt 1 -----------------------------------------------------
  const firstPrompt = buildPrompt(n, prose, null);
  let beats = await callSegment(firstPrompt, visionBlobs, options);

  // --- Attempt 2 (corrective retry on length mismatch) ---------------
  if (beats.length !== n) {
    console.warn(
      `Segment attempt 1 returned ${beats.length} beats, expected ${n}. ` +
        "Retrying with corrective preamble.",
    );
    options.onProgress?.(
      0,
      1,
      `Segment retry (attempt 1 returned ${beats.length}/${n})…`,
    );
    const retryPrompt = buildPrompt(n, prose, beats.length);
    beats = await callSegment(retryPrompt, visionBlobs, options);
  }

  // --- Safe fallback — even split of the prose -----------------------
  // Never break the 1:1 invariant. If Gemini can't count, we still
  // ship N beats — just split the existing prose evenly. Quality drops
  // (no panel-specific matching) — surface this via alignmentDegraded
  // so the manifest can flag the chapter for a manual spot-check.
  let alignmentDegraded = false;
  let degradationReason = "";
  if (beats.length !== n) {
    console.error(
      `❌ Segment retry STILL returned ${beats.length} beats, expected ${n}. ` +
        "Falling back to even-split of Stage 3A prose. " +
        "1:1 invariant preserved; per-panel matching degraded for this chapter.",
    );
    beats = evenSplitProse(prose, n);
    alignmentDegraded = true;
    degradationReason =
      `Segment fallback fired: Gemini returned ${beats.length} beats after retry, ` +
      `expected ${n}. Used even-split prose to preserve 1:1 count — beat ` +
      `content may not match each panel surgically.`;
  }

  // Final sanity — every beat must be non-empty.
  let placeholderHits = 0;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i].trim().length === 0) {
      beats[i] = `(beat ${i + 1} — narration unavailable)`;
      placeholderHits++;
    }
  }
  if (placeholderHits > 0) {
    alignmentDegraded = true;
    degradationReason =
      (degradationReason ? degradationReason + " " : "") +
      `${placeholderHits} beat(s) were empty and filled with placeholders.`;
  }

  options.onProgress?.(1, 1, `Segmented into ${n} beats.`);
  return { beats, alignmentDegraded, degradationReason };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Pick the right fallback model for a given primary. Mirrors the chain
 * in comprehend.ts — keep these in sync if you edit one.
 */
function pickFallback(primary: string): string | undefined {
  switch (primary) {
    case "gemini-3.1-pro-preview":
      return "gemini-3-flash-preview";
    case "gemini-3-flash-preview":
      return "gemini-2.5-flash";
    case "gemini-2.5-pro":
      return "gemini-2.5-flash";
    case "gemini-2.5-flash":
      return "gemini-3.1-flash-lite";
    default:
      return undefined;
  }
}

async function callSegment(
  prompt: string,
  visionBlobs: Blob[],
  options: SegmentOptions,
): Promise<string[]> {
  let raw = "";
  try {
    raw = await generateContent(options.rotator, {
      model: options.model,
      // Same fallback chain as Stage 3A. See comprehend.ts pickFallback
      // for the documented model → backup mapping.
      fallbackModel: pickFallback(options.model),
      prompt,
      images: visionBlobs,
      // Lower than 3A — we're redistributing existing prose, not
      // inventing story. Lower temp = better adherence to "exactly N".
      temperature: 0.4,
      topP: 0.9,
      onKeyUsed: options.onKeyUsed,
    });
  } catch (err) {
    console.warn(
      `Segment call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  return parseBeatsArray(raw);
}

/**
 * Parse Gemini's JSON-array output into a clean string[]. Tolerant of
 * markdown fences and minor whitespace drift. Returns ``[]`` on parse
 * error — caller treats empty as "trigger retry / fallback".
 */
function parseBeatsArray(raw: string): string[] {
  // Tolerant parser — handles Qwen's ~3% structured-output error rate
  // (smart quotes, trailing commas, truncation) without needing a
  // chapter-level retry. Returns [] only when the output is truly
  // unparseable; caller treats that as "retry / fallback".
  const arr = tryJsonParse<unknown>(raw, "array");
  if (!Array.isArray(arr)) return [];

  return arr.map((x) =>
    typeof x === "string" ? x.trim() : String(x ?? "").trim(),
  );
}

// (extractBalancedArray moved to ./jsonRepair as part of safeJsonParse.)

/**
 * Last-resort: split prose into ``n`` roughly-equal chunks by sentence
 * boundaries when possible, by word boundaries when not. Each chunk
 * becomes one beat. Used only when Gemini can't return ``n`` beats
 * after retry — preserves the 1:1 invariant at the cost of per-panel
 * specificity (each beat is approximately the right narrative slice
 * but not surgically matched to its panel).
 */
function evenSplitProse(prose: string, n: number): string[] {
  if (n === 0) return [];
  // Split into sentences first — more natural beat boundaries.
  const sentences = prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length === 0) return placeholderBeats(n);

  // If we have at least N sentences, distribute them evenly.
  if (sentences.length >= n) {
    const out: string[] = [];
    const per = sentences.length / n;
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * per);
      const end = i === n - 1 ? sentences.length : Math.floor((i + 1) * per);
      out.push(sentences.slice(start, end).join(" "));
    }
    return out;
  }

  // Fewer sentences than panels — chunk the prose by words instead so
  // every beat gets some content. Worst case: very short prose.
  const words = prose.trim().split(/\s+/);
  if (words.length < n) {
    // Pathological — pad with placeholders so 1:1 still holds.
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      out.push(words[i] ? words[i] : `(beat ${i + 1})`);
    }
    return out;
  }
  const out: string[] = [];
  const per = words.length / n;
  for (let i = 0; i < n; i++) {
    const start = Math.floor(i * per);
    const end = i === n - 1 ? words.length : Math.floor((i + 1) * per);
    out.push(words.slice(start, end).join(" "));
  }
  return out;
}

function placeholderBeats(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `(beat ${i + 1} — narration unavailable)`,
  );
}

// ---------------------------------------------------------------------
// Prompt — verbatim from spec § 4 Stage 3B
// ---------------------------------------------------------------------

function buildPrompt(
  n: number,
  prose: string,
  previousAttemptCount: number | null,
): string {
  const corrective =
    previousAttemptCount !== null
      ? `
═══════════════════════════════════════════════════════════════════════
⚠️  RETRY — PREVIOUS ATTEMPT RETURNED WRONG BEAT COUNT
═══════════════════════════════════════════════════════════════════════
Your previous attempt returned ${previousAttemptCount} beats.
The input has EXACTLY ${n} panels.
Your output array MUST have EXACTLY ${n} string elements, one per
panel, in input order.

The downstream pipeline aligns beat[i] to panel[i] by array position
— a missing or extra beat would silently shift every subsequent
panel's narration onto the wrong panel. This is non-negotiable.

Count your output array before finishing. If length != ${n}, redo it.
`
      : "";

  return `${corrective}Here is a COMPLETE chapter recap narration, and the ${n} panels (reading order) it was written from. Split the narration into EXACTLY ${n} beats so that beat i corresponds to panel i's moment in the story. Keep the full story — do not drop content; redistribute it across the ${n} beats.

RULES:
- EXACTLY ${n} beats, in order. Beat i must match panel i's content.
- Preserve all story/context/motivation/stakes from the narration.

═══════════════════════════════════════════════════════════════════════
⏱  BEAT LENGTH — STRICT 8-15 WORDS, HARD CAP 18
═══════════════════════════════════════════════════════════════════════
Each beat will become ONE SRT subtitle block in a YouTube video. The
viewer's eye reads ~150 WPM, so beat length directly = screen time:

    8 words   ≈ 3.2 sec on screen   (punchy action / impact)
    12 words  ≈ 4.8 sec on screen   (standard story beat) ← target
    15 words  ≈ 6.0 sec on screen   (reveal / setup / emotion)
    18 words  ≈ 7.2 sec on screen   (HARD CAP — never exceed)

Word budget by beat type:

    • Fast action / shock / impact / strike    → 6-10 words (one line)
    • Standard story progression / dialogue    → 10-14 words (target)
    • Setup / motivation / reveal / emotion    → 13-18 words MAX
    • Two-sentence beat → split into TWO beats if you have the panels
                          for it; never run a single beat past 18 words

If the upstream prose has long sentences, BREAK them into multiple
short beats. Better to land 1.5 beats of content in one beat slot
than to ship a 30-word run-on that the viewer can't read in 5 sec.

═══════════════════════════════════════════════════════════════════════
PANEL-DESCRIPTION ban (Rule A from earlier)
═══════════════════════════════════════════════════════════════════════
- Never describe the panel ("the panel shows", "a close-up", "a wide shot", "a sound effect panel", "this panel", "a beat passes", "the scene shifts"). Narrate story events only.
- Dialogue stays woven INSIDE narration (story before & after the quote). Never "QUOTE" — tag. Never a bare quote opening a beat.
- NEVER write any generic protagonist reference. Forbidden:
    "the character", "a figure", "someone", "the figure", "a man",
    "this character", "this guy", "this man", "this figure",
    "this person", "our protagonist", "the protagonist".
  ALWAYS use the actual name from the narration. If you cannot
  identify the character from the prose or panels, REWRITE the beat
  to focus on action/environment instead of the unnamed actor.
- Do NOT add a hook here (the polish pass handles hooks).

═══════════════════════════════════════════════════════════════════════
🚫 NO RESTATEMENT — EACH BEAT MUST ADD NEW CONTENT
═══════════════════════════════════════════════════════════════════════
TWO LEVELS of restatement are both BANNED:

LEVEL A — INTERNAL restatement (within a single beat):
  A beat must NEVER contain two sentences saying the same thing.
  ✗ WRONG (28 words, sentence 2 restates sentence 1):
    "He demands full command over the field. Ghislain demands full
     command over the remaining soldiers on the field."
  ✓ RIGHT (one sentence, 12 words):
    "He demands full command over the field with a single word."

  If your beat has two sentences that convey the same fact, DELETE
  one of them. Never pad a beat with a restated sentence to hit the
  word target.

LEVEL B — ADJACENT restatement (between consecutive beats):
Two consecutive beats may NOT convey the same story information. Each
beat must ADVANCE something — a new action, a new consequence, a new
shift in stakes, a new piece of revealed information.

  ✗ WRONG (restatement padding — 4 beats saying the same thing):
     P5: "Ghislain cuts down three orcs."
     P6: "More orcs fall to his blade."
     P7: "The orc count keeps rising."
     P8: "He continues to slay orcs impressively."

  ✓ RIGHT (each beat advances):
     P5: "Ghislain cuts down the first wave — three orcs in two breaths."
     P6: "The second rank hesitates; he uses the gap to flank."
     P7: "An orc captain spots the lone swordsman and roars a warning."
     P8: "The horde shifts focus from the troops to Ghislain alone."

WHEN PANELS REPEAT THE SAME MOMENT (the story has fewer real beats
than N panels): let beat N+1 CONTINUE what N started — describe the
next layer (the consequence, the reaction, the camera shifting to a
second character, the stakes changing) rather than restating the
fact. Every beat earns its place.

Also FORBIDDEN repetition patterns:
  ✗ Same sentence opener twice in a row (e.g. two beats in a row
    starting "Ghislain..." — vary subjects)
  ✗ Same emotional beat twice in a row ("his face twists" / "his
    expression contorts" back-to-back)
  ✗ The exact same retention/hook phrase in two beats (these should
    not appear at all in segmentation — see polish pass)

═══════════════════════════════════════════════════════════════════════
🎙️  DIALOGUE INTEGRATION — VARY THE PATTERN
═══════════════════════════════════════════════════════════════════════
Across ALL ${n} beats of this chapter, use the dash-wrapped form
(verb — "quote" — poetic tail) AT MOST 1 in 4 dialogue beats. The
rest must use varied forms:

  • Mid-sentence quote:
    "When Skovan barks 'fall back', the line hesitates for the first time."
  • Plain quote after action:
    "Ghislain grips the hilt. 'This ends tonight.'"
  • Embedded:
    "'You're the worst,' Elena whispers, her hands trembling."
  • Paraphrase (no quote at all — often cleaner):
    "Skovan mutters something about the past, words half-swallowed."

Max ONE quote per beat. If a quote isn't essential, use pure
narration — paraphrase is often stronger than a literal quote.

=== CHAPTER NARRATION ===
${prose}

=== OUTPUT FORMAT ===
Output ONLY a JSON array of EXACTLY ${n} strings, beat 1 … beat ${n}, in order. No prose preamble. No markdown fences. No commentary. Just the array.

Example shape (for n=3):
["First beat narration here.","Second beat — short and punchy.","Third beat goes deeper, two sentences for setup."]`;
}
