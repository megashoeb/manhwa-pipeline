// Stage 3A — whole-chapter story comprehension.
//
// THE KEY ARCHITECTURAL CHANGE in spec v3.
//
// Old (panel-first): per-scene narration where the narrator sees ~6
// panels at a time and writes 1 paragraph per panel. Output reads as
// a highlight reel — setup, motivation, and stakes are missing because
// each scene call only sees its own slice of context.
//
// New (story-first, this stage): ONE call per chapter. Send ALL the
// curated strong panels at once (in reading order) plus the running
// STORY_BIBLE and the previous chapter's tail. Gemini reads the entire
// chapter and writes a COMPLETE recap narration — setup + motivation
// + stakes + chronology — as flowing prose.
//
// The prose is later split into N beats by Stage 3B (segment.ts) so
// the 1:1 panel↔line invariant is preserved. But the prose itself
// comes from understanding the whole chapter, not from describing
// each panel in isolation.
//
// Model: gemini-2.5-flash per spec § 4 Stage 3A.
// Cost: 1 vision call per chapter (15-28 high-res images + ~1.5K
// token prompt + ~600-word output). Well under the 10K RPD budget.

import type { CharacterBible, FilteredPage } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

import { generateContent } from "./geminiClient";
import { downscaleBlobs } from "./imageDownscale";

export interface ComprehendOptions {
  model: string;
  rotator: KeyRotator;
  bible: CharacterBible;
  /**
   * Last 4 beats of the PREVIOUS chapter's polished narration. Fed in
   * so Gemini continues the story instead of restarting — invisible
   * chapter breaks. Empty for chapter 1.
   */
  previousChapterTail?: string;
  onKeyUsed?: (masked: string) => void;
  onProgress?: (current: number, total: number, msg: string) => void;
}

/**
 * Run Stage 3A — whole-chapter comprehension. Returns flowing prose
 * narration for the entire chapter (NOT one-line-per-panel — that's
 * Stage 3B's job).
 *
 * Throws if Gemini's call fails. Callers should let the error bubble
 * so the bulk queue marks the chapter as failed rather than shipping
 * a chapter with empty prose.
 */
export async function comprehendChapter(
  curatedPanels: FilteredPage[],
  options: ComprehendOptions,
): Promise<string> {
  if (curatedPanels.length === 0) {
    throw new Error(
      "comprehendChapter: no curated panels supplied (Stage 2 returned empty).",
    );
  }

  options.onProgress?.(
    0,
    1,
    `Reading whole chapter (${curatedPanels.length} panels) for story comprehension…`,
  );

  // Downscale to 768 px longest edge before upload. Gemini Vision
  // downscales to ~768 internally anyway — sending 200 DPI panels
  // (1500×2200 px, ~1-2 MB each) just wastes upload bandwidth. For a
  // 28-panel chapter this cuts the 3A upload from ~30 MB to ~10 MB.
  // Parallel-downscale at concurrency 4 inside ``downscaleBlobs``
  // keeps the wall-clock cost of resizing under ~3 seconds even for
  // a big chapter.
  const visionBlobs = await downscaleBlobs(
    curatedPanels.map((p) => p.blob),
  );

  const prompt = buildPrompt(
    options.bible,
    options.previousChapterTail ?? "",
  );

  const raw = await generateContent(options.rotator, {
    model: options.model,
    // Per-model fallback policy — switches on 429/403/404 to keep the
    // chapter alive when a preview model exhausts quota mid-run.
    //   gemini-3-flash-preview   → gemini-2.5-flash       (gen-3 → gen-2.5)
    //   gemini-2.5-flash         → gemini-3.1-flash-lite  (gen-2.5 → cheapest GA)
    fallbackModel: pickFallback(options.model),
    prompt,
    images: visionBlobs,
    // Slightly higher than the panel classifier — 3A needs narrative
    // creativity to fill connective context (setup, motivation, stakes)
    // that isn't literally in any single panel.
    temperature: 0.75,
    topP: 0.9,
    onKeyUsed: options.onKeyUsed,
  });

  // Clean up — strip markdown fences if Gemini added them, trim
  // leading/trailing whitespace, drop preamble lines that snuck through.
  const cleaned = cleanProse(raw);
  if (cleaned.length === 0) {
    throw new Error(
      "comprehendChapter: Gemini returned empty narration after cleaning.",
    );
  }

  options.onProgress?.(
    1,
    1,
    `Chapter comprehended (~${cleaned.split(/\s+/).length} words).`,
  );
  return cleaned;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Pick the right fallback model for a given primary. Keeps the chain
 * in sync with MODEL_TIERS / MODEL_BACKUPS. Returns ``undefined`` for
 * models with no documented backup — those errors surface cleanly to
 * the caller instead of being masked.
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

function cleanProse(raw: string): string {
  let s = raw.trim();
  // Strip a leading ``` fence if present.
  s = s.replace(/^```(?:\w+)?\s*\n?/, "");
  s = s.replace(/\n?```\s*$/, "");
  // Drop any leading preamble like "Here is the recap:" / "Sure, here..."
  s = s.replace(
    /^(?:here(?:'s| is)|sure|of course|okay|alright)[^.!?\n]*[.!?\n]+\s*/i,
    "",
  );
  return s.trim();
}

// ---------------------------------------------------------------------
// Prompt — verbatim from spec § 4 Stage 3A
// ---------------------------------------------------------------------

function buildPrompt(
  bible: CharacterBible,
  rollingContext: string,
): string {
  const characters =
    Object.entries(bible.characters)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n") || "(no named characters known yet)";
  const uncertain =
    bible.uncertain.length > 0
      ? bible.uncertain.map((u) => `- ${u}`).join("\n")
      : "(none)";
  const setting = bible.setting || "(unknown setting)";
  const premise = bible.premise || "(unknown premise)";

  const context =
    rollingContext.trim().length > 0
      ? rollingContext
      : "(this is the first chapter of the recap)";

  return `You are a top YouTube manhwa recap narrator (Manhwa Chatter / Asura Recaps style). Below are ALL the key panels of ONE chapter, in reading order. Read the WHOLE chapter, then write a COMPLETE recap narration of everything that happens — as ONE continuous story.

REQUIREMENTS:
- Explain WHO characters are, their MOTIVATION, and the STAKES. A viewer who never read this manhwa must fully follow it. Do not assume prior knowledge; fill connective context.
- Tell events in chronological story order. Cover the whole chapter, not just highlights.
- This is ONE continuous story. CONTINUE from the context below — do NOT restart, re-introduce, or re-summarize what's already established.
- Weave any important dialogue INSIDE narration (story before & after the quote). Never "QUOTE" — tag. Never a bare quote opening a sentence.
- Never describe panels/images ("the panel shows", "a close-up", "a beat passes", "this panel", "the scene shifts"). Narrate story events only.
- STYLE: SHORT, PUNCHY sentences. CRITICAL: each sentence should be 8-15 words. NEVER over 18 words per sentence. The downstream segmentation pass will turn each sentence into one SRT block on a YouTube video — a 30-word sentence becomes a 12-second subtitle that the viewer can't read in sync with its image.

  ✗ WRONG (too long, will read as a 14-second subtitle):
     "Ghislain Perdium drives his blade through the masked knight's
      shoulder in one motion, and the legend of the north drops to
      one knee, finally understanding who he's facing."  (32 words)

  ✓ RIGHT (split into two short sentences, ~5 sec each):
     "Ghislain drives his blade through the knight's shoulder. The
      legend of the north drops to one knee, finally understanding."

Vary rhythm — tense action = 6-10 word punchy lines; standard
progression = 10-14 words; setup/emotion/reveals = 13-18 words MAX.
NEVER write run-on sentences. When in doubt, USE A PERIOD.
- Use names from the bible; rotate references; no repeated stock phrases.
- NEVER write any generic protagonist reference. Forbidden:
  "the character", "a figure", "someone", "the figure", "a man",
  "this character", "this guy", "this man", "this figure",
  "this person", "our protagonist", "the protagonist".
  If you cannot identify who from the bible/context, that moment
  should not be in the recap — skip it rather than narrate a generic,
  nameless actor.

- NO RESTATEMENT — each story beat must ADD new content. If a moment
  spans multiple panels (e.g. five panels of the same fight), narrate
  the PROGRESSION (setup → escalation → consequence → reaction →
  shift), not the static fact repeated five times. Five beats of "he
  fights orcs impressively" reads as filler; five beats of "first wave
  → second wave hesitates → orc captain spots him → horde shifts focus
  → he opens a flanking gap" reads as ESCALATION.

- DIALOGUE INTEGRATION — vary the pattern. Across this chapter, use
  the dash-wrapped form (verb — "quote" — poetic tail) at most ~1 in
  4 dialogue moments. Other forms to mix in:
    • Mid-sentence quote ("When he says 'X', the room freezes.")
    • Plain quote after action ("He grips the hilt. 'This ends tonight.'")
    • Embedded ("'You're the worst,' she whispers.")
    • Paraphrase (no quote — often cleaner).
  Max ONE quote per major beat.

- NO RETENTION INTERJECTIONS. Do NOT write "Now this is where things
  get insane", "But wait until you see what happens next", "this
  pays off later", "trust me, what happens next", "this single
  decision sets up...", or any similar viewer-retention forward-pull.
  The story is the retention. Let it carry the viewer.

=== STORY SO FAR (continue from this, do not repeat) ===
${context}

=== KNOWN CHARACTERS / FACTS ===
${characters}

UNCERTAIN (un-named characters seen so far):
${uncertain}

Setting: ${setting}
Premise so far: ${premise}

=== THIS CHAPTER'S PANELS (reading order) ===
(All panels of this chapter are attached below — read them in reading
order before narrating, then write the complete chapter as one
continuous story.)

Output ONLY the complete chapter narration as flowing prose. No preamble, no headers, no markdown fences. Just the narration.`;
}
