// Stage 4d — script polish pass.
//
// After the per-scene narrator finishes drafting, this step takes the
// FULL chapter script as one input and asks Gemini to:
//
//   1. Replace overused phrases ("understanding washes over", "looms
//      over", "predatory gaze", etc.) with rotating alternatives.
//   2. Rotate character references (name / "our boy" / "the heir" /
//      "the masked figure" / "he").
//   3. Enforce paragraph rhythm (60 / 25 / 15 standard / punchy / deep).
//   4. Add a viewer-grabbing HOOK to paragraph 1.
//   5. Sprinkle retention markers + open loops + pattern interrupts.
//   6. Preserve the 1:1 panel↔paragraph invariant (same count out).
//
// The polish reads like the second draft a human editor would do —
// catches AI tells the per-scene pass can't see because each scene
// only knows its own panels.
//
// Cost: ONE extra Gemini call per chapter. Free-tier still covers
// roughly 45 chapters/day.

import type { CharacterBible } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

import { generateContent } from "./geminiClient";
import { parseNumberedLines } from "./narrator";

/** Hard ceiling on a single polish call — keeps us under output-token caps. */
const MAX_PARAGRAPHS_PER_POLISH_CALL = 60;
/**
 * Chunked-polish thresholds. When a chapter has more than
 * ``CHUNK_THRESHOLD`` lines, polish is split into 2-3 chunks running
 * in PARALLEL against different keys. Saves ~30-60 sec per chapter at
 * the cost of slightly weaker cross-chunk anti-repetition (each
 * polish chunk doesn't see the others' output).
 */
const CHUNK_THRESHOLD = 18;
const TARGET_CHUNK_SIZE = 15;

export interface PolishOptions {
  model: string;
  rotator: KeyRotator;
  bible: CharacterBible;
  /**
   * Long-form recap mode. When ``true`` the polish prompt switches to
   * tight-paragraph rules (preserve 30-45 word paragraphs, skip the
   * 60/25/15 rhythm rule). Used inside the 80-chapter / 2.5-hr video
   * flow so polish doesn't bloat paragraphs back to single-video length.
   */
  longFormRecap?: boolean;
  /**
   * Hook line from the PREVIOUS chapter's polished script. When set,
   * the polish prompt is told NOT to repeat the same hook structure
   * (e.g. "What if the useless X was actually Y..." template). Empty
   * for the first chapter of a run.
   */
  previousChapterHook?: string;
  /**
   * Hook-uniqueness flag from the spec (CLAUDE_CODE_COMMAND.md §5).
   * Only the VERY first chapter of a long-form recap gets a hook.
   * Chapters 2+ must continue smoothly from the previous chapter's
   * tail — no question hook, no shock statement, no restart.
   * Defaults to ``true`` for single-chapter mode.
   */
  isFirstChapter?: boolean;
  onProgress?: (current: number, total: number, msg: string) => void;
  onKeyUsed?: (masked: string) => void;
}

/**
 * Polish a draft script in one Gemini call.
 *
 * Returns the polished line list with EXACTLY the same length as the
 * input (or the original on validation failure — never breaks the
 * downstream SRT-sync invariant).
 *
 * For chapters longer than ``MAX_PARAGRAPHS_PER_POLISH_CALL`` we skip
 * the polish entirely with a console warning rather than splitting,
 * which would cost continuity benefits. (Most chapters land at
 * 40-60 paragraphs.)
 */
export async function polishScript(
  lines: string[],
  options: PolishOptions,
): Promise<string[]> {
  if (lines.length === 0) return lines;

  if (lines.length > MAX_PARAGRAPHS_PER_POLISH_CALL) {
    console.warn(
      `Script has ${lines.length} paragraphs — exceeds polish-pass cap ` +
        `of ${MAX_PARAGRAPHS_PER_POLISH_CALL}. Skipping polish.`,
    );
    return lines;
  }

  // Short scripts → single pass (chunking overhead not worth it).
  if (lines.length <= CHUNK_THRESHOLD) {
    options.onProgress?.(
      0,
      1,
      "Polishing script (anti-repetition + retention pass)…",
    );
    return await polishChunk(lines, options, null);
  }

  // ----- Parallel chunked polish (long scripts) --------------------
  // Split into K balanced chunks of ~TARGET_CHUNK_SIZE each, run K
  // polish calls in parallel (different keys via the rotator). Each
  // chunk only sees its own slice — cross-chunk anti-repetition is
  // best-effort, but the time savings are real: 40 lines that took
  // ~60 sec sequentially now finish in ~30 sec at concurrency 2.
  const numChunks = Math.max(2, Math.ceil(lines.length / TARGET_CHUNK_SIZE));
  const chunkSize = Math.ceil(lines.length / numChunks);
  const chunks: string[][] = [];
  for (let k = 0; k < numChunks; k++) {
    const start = k * chunkSize;
    chunks.push(lines.slice(start, start + chunkSize));
  }

  options.onProgress?.(
    0,
    numChunks,
    `Polishing ${lines.length} lines in ${numChunks} parallel chunks…`,
  );

  // Run all chunks concurrently. Each chunk knows its position so
  // only chunk 0 of the FIRST chapter handles the hook.
  let completedChunks = 0;
  const polishedChunks = await Promise.all(
    chunks.map(async (chunkLines, k) => {
      const result = await polishChunk(chunkLines, options, {
        chunkIndex: k,
        totalChunks: numChunks,
      });
      completedChunks++;
      options.onProgress?.(
        completedChunks,
        numChunks,
        `Polished chunk ${completedChunks}/${numChunks}…`,
      );
      return result;
    }),
  );

  // Concatenate. Each chunk preserves its own count (polishChunk
  // guarantees in.length == out.length). Final length must equal
  // the original input — assert as defence-in-depth.
  const polished = polishedChunks.flat();
  if (polished.length !== lines.length) {
    console.error(
      `❌ Parallel polish concat returned ${polished.length} lines, ` +
        `expected ${lines.length}. Falling back to unpolished script.`,
    );
    options.onProgress?.(1, 1, "Polish skipped (chunk concat mismatch).");
    return lines;
  }
  options.onProgress?.(
    numChunks,
    numChunks,
    `Polish complete (${numChunks} chunks merged).`,
  );
  return polished;
}

// ---------------------------------------------------------------------
// Single-chunk polish — retry + fallback chain (unchanged behaviour
// from the pre-chunking single-pass design, just factored out so
// parallel chunks can reuse it).
// ---------------------------------------------------------------------

interface ChunkInfo {
  chunkIndex: number;
  totalChunks: number;
}

/**
 * Polish ONE slice of lines. Returns ``slice`` unchanged on count
 * mismatch after the corrective retry (1:1 invariant preserved).
 *
 * ``chunk`` is non-null when this is part of a parallel chunked
 * polish. The prompt uses it to gate hook handling — only chunk 0
 * of the first chapter can add a hook; all other chunk positions
 * continue smoothly from the previous chunk's tail.
 */
async function polishChunk(
  slice: string[],
  options: PolishOptions,
  chunk: ChunkInfo | null,
): Promise<string[]> {
  const numbered = slice.map((l, i) => `${i + 1}. ${l}`).join("\n\n");

  const firstPrompt = buildPolishPrompt(
    slice.length,
    options.bible,
    numbered,
    options.longFormRecap ?? false,
    options.previousChapterHook ?? "",
    options.isFirstChapter ?? true,
    null,
    chunk,
  );

  // --- Attempt 1 ----------------------------------------------------
  let polished = await callPolish(options, firstPrompt);

  // --- Attempt 2 (corrective retry on count mismatch) ---------------
  if (polished.length !== slice.length) {
    const chunkLabel = chunk
      ? ` (chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks})`
      : "";
    console.warn(
      `Polish${chunkLabel} attempt 1 returned ${polished.length} paragraphs, ` +
        `expected ${slice.length}. Retrying with corrective preamble.`,
    );
    const retryPrompt = buildPolishPrompt(
      slice.length,
      options.bible,
      numbered,
      options.longFormRecap ?? false,
      options.previousChapterHook ?? "",
      options.isFirstChapter ?? true,
      polished.length,
      chunk,
    );
    polished = await callPolish(options, retryPrompt);
  }

  // --- Fallback to unpolished slice on persistent mismatch ----------
  if (polished.length !== slice.length) {
    const chunkLabel = chunk
      ? ` (chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks})`
      : "";
    console.warn(
      `Polish${chunkLabel} retry STILL returned ${polished.length} paragraphs, ` +
        `expected ${slice.length}. Returning unpolished slice (1:1 preserved).`,
    );
    return slice;
  }

  // Sanity: reject empty paragraphs (Gemini sometimes drops one).
  if (polished.some((p) => p.trim().length === 0)) {
    console.warn("Polish chunk produced empty paragraph(s); falling back.");
    return slice;
  }

  return polished;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function callPolish(
  options: PolishOptions,
  prompt: string,
): Promise<string[]> {
  // Per-polish-model fallback chain. geminiClient's generic fallback
  // fires on 429/403/404 — we just point it at the right backup based
  // on which model the caller is using.
  //   gemini-3.1-pro-preview → gemini-3-flash-preview  (premium → newer-gen flash)
  //   gemini-3-flash-preview → gemini-2.5-flash         (newer-gen → free GA)
  //   gemini-2.5-pro          → gemini-2.5-flash        (same generation, free tier)
  //   gemini-2.5-flash        → gemini-3.1-flash-lite   (free GA → cheapest baseline)
  // For any other model we leave fallback off so caller errors
  // surface cleanly instead of being masked.
  const fallbackModel =
    options.model === "gemini-3.1-pro-preview"
      ? "gemini-3-flash-preview"
      : options.model === "gemini-3-flash-preview"
        ? "gemini-2.5-flash"
        : options.model === "gemini-2.5-pro"
          ? "gemini-2.5-flash"
          : options.model === "gemini-2.5-flash"
            ? "gemini-3.1-flash-lite"
            : undefined;

  const raw = await generateContent(options.rotator, {
    model: options.model,
    fallbackModel,
    prompt,
    temperature: 0.7, // creative but reined in — editing, not inventing
    topP: 0.92,
    onKeyUsed: options.onKeyUsed,
  });
  return parseNumberedLines(raw);
}

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

function buildPolishPrompt(
  n: number,
  bible: CharacterBible,
  numberedScript: string,
  longFormRecap: boolean,
  previousChapterHook: string,
  isFirstChapterInput: boolean,
  previousAttemptCount: number | null,
  chunk: ChunkInfo | null,
): string {
  // Chunked-polish awareness — only chunk 0 of the FIRST chapter
  // can add a hook. Every other chunk position must continue smoothly.
  // We override the input ``isFirstChapter`` flag with chunk-aware
  // logic so downstream hook-uniqueness gating still works correctly.
  const isFirstChunk = chunk === null || chunk.chunkIndex === 0;
  const isFirstChapter = isFirstChapterInput && isFirstChunk;
  const chunkContextBlock = chunk
    ? `
═══════════════════════════════════════════════════════════════════════
🧩  CHUNKED POLISH — YOU ARE CHUNK ${chunk.chunkIndex + 1} OF ${chunk.totalChunks}
═══════════════════════════════════════════════════════════════════════
This chapter's beats are being polished in ${chunk.totalChunks} parallel
chunks (each on a different API key for speed). You are working on
chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}, which contains beats from
the middle of the chapter narrative.

${
  isFirstChunk
    ? "This is the FIRST chunk — the chapter opens here."
    : "This is NOT the first chunk — earlier chunks already handled the chapter opening. Continue smoothly. DO NOT add a hook or restart the story."
}

You do NOT see the OTHER chunks. So:
- Trust that previous chunks handled the opening / hook.
- Trust that later chunks will handle the ending / cliffhanger.
- Focus on cleaning AI tells + repetition WITHIN your slice.
- Cross-chunk anti-repetition can't be enforced — but each chunk
  staying tight on its own beats keeps the script clean overall.
`
    : "";
  const characterBlock =
    Object.entries(bible.characters)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n") || "(no named characters)";

  // ----- Retry corrective preamble ----------------------------------
  // Only present on the SECOND attempt of a polish call. Quotes the
  // wrong count back at Gemini so it can self-correct rather than
  // repeating the same drift.
  const correctivePreamble =
    previousAttemptCount !== null
      ? `
═══════════════════════════════════════════════════════════════════════
⚠️  RETRY — PREVIOUS ATTEMPT FAILED COUNT CHECK
═══════════════════════════════════════════════════════════════════════
Your previous attempt returned ${previousAttemptCount} paragraphs.
The input has EXACTLY ${n} paragraphs (numbered 1 to ${n}).
Your output MUST have EXACTLY ${n} paragraphs (numbered 1 to ${n}).

This is non-negotiable. The downstream video pipeline aligns each
paragraph 1:1 with a panel image — a wrong count breaks every SRT
subtitle and desyncs the entire video.

Before outputting, COUNT your numbered blocks. If they do not equal
${n}, you MUST adjust. Do NOT merge paragraphs. Do NOT split paragraphs.
Do NOT drop paragraphs. Do NOT add paragraphs. ONE-TO-ONE mapping.
`
      : "";

  // ----- Long-form mode rules block ---------------------------------
  // When ON: enforce tight paragraph length, skip rhythm rule, banned
  // hook templates from previous chapters. When OFF: empty (standard
  // single-chapter rules below apply).
  const longFormRules = longFormRecap
    ? `
═══════════════════════════════════════════════════════════════════════
⏱  LONG-FORM RECAP MODE — VERY SHORT BEATS (CRITICAL)
═══════════════════════════════════════════════════════════════════════
Each beat = ONE SRT subtitle block in a YouTube video. At ~150 WPM
TTS speed, beat length DIRECTLY equals on-screen time:

    8 words   ≈ 3.2 sec on screen   (punchy action)
    12 words  ≈ 4.8 sec on screen   (standard) ← target
    15 words  ≈ 6.0 sec on screen   (reveal / emotion)
    18 words  ≈ 7.2 sec on screen   (HARD CAP — never exceed)

Word budget by beat type:

  • Fast action / shock / impact            → 6-10 words
  • Standard progression / dialogue         → 10-14 words (target)
  • Setup / motivation / reveal / emotion   → 13-18 words MAX

THE RULES (non-negotiable in long-form mode):
  • TARGET 10-14 words per beat. Few beats may reach 18.
  • HARD CAP 18 words. If input has a beat > 18 words, TRIM it
    surgically — drop adjective clauses, drop "with", drop "that
    has", drop redundant context already implied by the panel.
  • NEVER expand a beat. If input is already 10 words, KEEP it.
  • Two sentences are allowed only if total ≤ 18 words.
  • Skip the 60/25/15 rhythm rule entirely — every beat is punchy.
  • DO NOT add "deep exposition" multi-sentence beats.

TRIMMING EXAMPLE 1 — when input is just too long, surgically cut:

  IN  ✗ (28 words): "Ghislain Perdium drives his blade through the
       masked knight's shoulder in a single motion, and the legend
       of the north drops to one knee in shock."

  OUT ✓ (12 words): "Ghislain drives his blade through the knight's
       shoulder. The legend drops to one knee."

TRIMMING EXAMPLE 2 — when input has INTERNAL RESTATEMENT (same fact
said twice in one beat), DELETE the duplicate sentence:

  IN  ✗ (28 words, restated):
       "With the beast silenced, he turns to the survivors and
       demands full command over the field. Ghislain demands full
       command over the remaining soldiers on the field."

  OUT ✓ (14 words, no restate):
       "With the beast silenced, Ghislain turns to the survivors
       and demands full command."

Word-count check BEFORE outputting: if ANY beat > 18 words, TRIM
until it fits. If the cause is INTERNAL RESTATEMENT (two sentences
saying the same thing), delete the duplicate sentence rather than
shaving words from both. This rule overrides any other length
guidance below.
`
    : "";

  // ----- Hook variation block --------------------------------------
  // Only when we have a previous chapter's hook to compare against.
  const hookBanBlock = previousChapterHook
    ? `
═══════════════════════════════════════════════════════════════════════
🚫  HOOK VARIATION REQUIRED — DO NOT REUSE LAST CHAPTER'S TEMPLATE
═══════════════════════════════════════════════════════════════════════
Previous chapter's hook (paragraph 1) was:
    "${previousChapterHook.replace(/"/g, "'").slice(0, 240)}"

Your paragraph 1 MUST use a DIFFERENT hook STRUCTURE. Not just
different words — a different KIND of opener entirely:

  If previous was a "What if..." question → this one MUST NOT be.
  If previous was a "This man just did X" shock → this one MUST NOT be.
  If previous was a "By the end of this you'll see..." tease → MUST NOT be.

Rotate among these hook KINDS (and invent more):
  1. Question:   "What if..." / "How does X end up..."
  2. Shock:      "This guy just walked into a death trap on purpose."
  3. Tease:      "By the end of this scene, the entire kingdom changes."
  4. Statement:  "Some men are born predators. This one was crafted."
  5. Number:     "It only takes him three moves to end the strongest knight."
  6. Cliffhanger:"The next ten minutes will rewrite everything you know."
  7. Direct address: "Watch closely — this single panel is the entire arc."
  8. Cold-open:  Drop the viewer straight into action with no setup.

Pick a KIND you didn't use last chapter. Variety keeps viewers from
predicting the pattern.
`
    : "";

  // Hook uniqueness — spec §5 enhancement 1+2. Only the very first
  // chapter of a long-form run is allowed to add a hook. Chapters 2+
  // must continue smoothly from the previous chapter's tail.
  const hookUniquenessBlock = !isFirstChapter
    ? `
═══════════════════════════════════════════════════════════════════════
🚫 NO HOOK / NO RESTART — THIS IS CHAPTER 2+ OF A CONTINUOUS RECAP
═══════════════════════════════════════════════════════════════════════
This script slice continues a recap that already has its hook in
chapter 1. The viewer has been watching for many minutes — they do
NOT need another hook, "What if..." question, shock statement, or
premise re-introduction. The story is ONE continuous flow.

PARAGRAPH 1 RULES (strict, this chapter):
  ✗ DO NOT rewrite paragraph 1 as a hook.
  ✗ DO NOT open with "What if..." / "By the end of this..." /
    "This man just..." / "Imagine if..." / "In a world where..."
  ✗ DO NOT re-introduce characters, the premise, or the setting.
  ✗ DO NOT add a retention marker to paragraph 1.
  ✓ KEEP paragraph 1 as a natural continuation of the story.
  ✓ If the input paragraph 1 already looks like a fresh hook
    (question / shock / premise re-statement), REWRITE it as a
    plain story beat that continues from where the last chapter
    left off.

This is non-negotiable. Hooks appearing in chapters 2+ make the
recap feel disjointed and competitor-quality videos NEVER do this.

`
    : "";

  return `You are an expert YouTube script editor specializing in manhwa recap channels (Manhwa Fresh, Gave, Yom Recaps).

Your job: polish this DRAFT script for maximum YouTube retention and human readability. Cut AI fingerprints, rotate phrasing, add retention hooks — without breaking the 1:1 panel↔paragraph mapping.
${chunkContextBlock}${correctivePreamble}${longFormRules}${hookBanBlock}${hookUniquenessBlock}
═══════════════════════════════════════════════════════════════════════
🚫 ABSOLUTE RULE — NEVER DESCRIBE PANELS
═══════════════════════════════════════════════════════════════════════
You are editing STORY NARRATION, not picture descriptions. The
viewer SEES the panel — they don't need it described to them.

FORBIDDEN OPENERS / PHRASES (delete if seen, never introduce):
  ✗ "The panel shows..."          ✗ "A close-up of..."
  ✗ "A wide shot shows..."         ✗ "A sound effect panel..."
  ✗ "The text reads..."            ✗ "A speech bubble emerges..."
  ✗ "The narration notes..."       ✗ "The image depicts..."
  ✗ "We see..."                    ✗ "An image of..."
  ✗ "The scene displays..."        ✗ "A beat passes..."
  ✗ "This panel..."                ✗ "The scene shifts."

FORBIDDEN GENERIC PROTAGONIST REFERENCES (always use the name):
  ✗ "the character"   ✗ "a figure"        ✗ "someone"
  ✗ "the figure"      ✗ "a man"           ✗ "the protagonist"
  ✗ "this character"  ✗ "this guy"        ✗ "this man"
  ✗ "this figure"     ✗ "this person"     ✗ "our protagonist"

If any of these appear in the input, REPLACE with the actual
character name from the bible / nearby context. If the character is
genuinely unknown, rewrite the beat to focus on environment / action
without naming the unnamed actor — never leave a generic reference.

If the input has any of these patterns, REWRITE that paragraph to be
a story event instead. Examples:
  IN  ✗: "A close-up of Skovan's face, twisted in shock."
  OUT ✓: "Skovan's face twists in pure disbelief."
  IN  ✗: "This character lashes out at the orc."
  OUT ✓: "Ghislain lashes out at the orc."

═══════════════════════════════════════════════════════════════════════
🎙️  DIALOGUE INTEGRATION — VARY THE PATTERN
═══════════════════════════════════════════════════════════════════════
Dialogue quotes must be EMBEDDED inside a full narration sentence.
NEVER open a beat with a bare quote followed by a short tag.

  ✗ FORBIDDEN — bare quote + dash tag opening:
     '"WE?!" — the knight chokes out a single broken word.'
     '"I traveled back to the past?" — the realization hits him.'

The dash-wrapped sandwich form (verb — "quote" — poetic tail) IS
allowed but is itself overused at scale. RULE: across the whole
chapter, at most ~1 in 4 dialogue beats may use the dash-sandwich
pattern. The rest MUST use varied forms:

  • Mid-sentence quote:
    "When Skovan barks 'fall back', the line hesitates for the first time."
  • Plain quote after action:
    "Ghislain grips the hilt. 'This ends tonight.'"
  • Embedded with attribution:
    "'You're the worst,' Elena whispers, her hands trembling."
  • Paraphrase (no quote at all — often cleaner):
    "Skovan mutters something about the past, words half-swallowed."

If you see the dash-sandwich pattern repeated 3+ times in the input,
REWRITE most of them to use one of the alternative forms above.

Max ONE short quote per paragraph. If no quote is essential, use
pure narration (no quotes at all).

═══════════════════════════════════════════════════════════════════════
🔒 PARAGRAPH ORDER IS SACRED
═══════════════════════════════════════════════════════════════════════
Paragraph i in your output describes the SAME panel as paragraph i in
the input. If a paragraph is already good (no forbidden phrases, no
AI tells, accurate to its panel), copy it OUT EXACTLY UNCHANGED.

NEVER swap paragraphs. NEVER shift content between adjacent slots.
NEVER merge two paragraphs into one slot. If you can't find a clean
edit for paragraph i, output it unchanged rather than risking a shift.

═══════════════════════════════════════════════════════════════════════
HARD CONSTRAINT — DO NOT VIOLATE
═══════════════════════════════════════════════════════════════════════
The output MUST contain EXACTLY ${n} numbered paragraphs (same as input).
Paragraph i in your output corresponds to the same panel as paragraph
i in the input. NEVER merge, drop, or add paragraphs.

═══════════════════════════════════════════════════════════════════════
WHAT TO FIX
═══════════════════════════════════════════════════════════════════════

1. PHRASE REPETITION — replace AT LEAST 70% of overused phrases.

   These are AI tells. Whenever you see them, rotate to alternatives:

     • "Understanding washes over (him)" →
         "He grasps that", "The truth dawns on him", "It hits him",
         "He pieces it together", "Something clicks"

     • "It becomes clear that" / "It is clear that" →
         delete the phrase and rephrase: "Apparently", "Evidently",
         "Clearly", or just state the fact directly

     • "He realizes that" / "She realizes that" →
         "It dawns on him", "He grasps that", "He understands",
         "The pattern reveals itself"

     • "Looms over" →
         "towers above", "stands over", "stares down", "appears before",
         "positions himself", "watches from above"

     • "Something dark twists in his chest" →
         "His fists clench", "A cold weight settles in his gut",
         "His jaw tightens", "Heat builds behind his eyes"

     • "Cold, detached intensity" / "predatory gaze" →
         vary aggressively: "narrowed eyes", "a flat stare",
         "an unreadable look", just describe what he does

     • "Architect of ruin" / "the architect" →
         "the man behind it all", "the puppeteer", "the planner",
         "the mastermind"

     • "Totally dismantled" / "absolutely cooked" /
       "absolutely shredded" → "outclassed", "beaten cleanly",
         "broken", "outplayed"

   Track every emotional / cognitive phrase across your output and
   ROTATE. Never let the same phrasing appear twice within 5
   paragraphs.

2. CHARACTER REFERENCE ROTATION:

   Rotate between: full name / "our boy" / "the heir" /
   "the mercenary" / "the masked figure" / "the swordmaster" / "he"

   Rules:
     • Never use the SAME descriptor twice within 10 paragraphs.
     • "Our boy" — MAX 2 uses across the entire script.
     • Use the full name no more than 1 in every 3 paragraphs (so
       the script doesn't feel like a name-spam).

3. PARAGRAPH RHYTHM (enforce strictly — vary lengths intentionally):

     • 60% of paragraphs: 3-4 sentences (standard pacing)
     • 25% of paragraphs: 1-2 sentences (punchy, impactful)
     • 15% of paragraphs: 5-6 sentences (deep exposition / reveals)

   If too many paragraphs are uniform 3-4 sentences, SHORTEN some
   to punchy 1-2 sentence beats and EXTEND some to 5-6 sentence
   deep exposition. Variety drives reading rhythm.

═══════════════════════════════════════════════════════════════════════
YOUTUBE OPTIMIZATIONS TO ADD
═══════════════════════════════════════════════════════════════════════

1. HOOK — completely rewrite PARAGRAPH 1 as a viewer-grabbing opener.

   Pick ONE approach:
     • Question:  "What if the weakest son in the family was secretly
                  the deadliest warrior on the continent?"
     • Shock:     "This man just killed one of the seven strongest
                  warriors in the world — but here's the twist that
                  no one saw coming."
     • Tease:     "By the end of this video, you'll see exactly how a
                  useless heir dismantled an entire kingdom from the
                  shadows."

   Keep paragraph 1 SHORT — 2-3 sentences. The goal is to make a
   viewer who just clicked the video NEED to keep watching.

2. 🚫 NO RETENTION INTERJECTIONS — STRIP THEM
   DO NOT add viewer-retention interjections / forward-pull lines.
   They become AI tells at scale (a 70-chapter mega-recap with
   "Now this is where things get insane" appearing every other chapter
   reads as obviously formulaic).

   If the input contains any of these PATTERNS, DELETE them or rewrite
   as plain story narration:
     ✗ "Now this is where things get insane."
     ✗ "But wait until you see what he does next."
     ✗ "Remember this scene — it pays off massively later."
     ✗ "And this is just the beginning, trust me."
     ✗ "What happens next will completely flip the dynamic."
     ✗ "This single decision sets up the entire arc to come."
     ✗ "And believe me, this comes back in a way you won't believe."
     ✗ Any variant of "wait until / believe me / what happens next /
       trust me / this pays off / things get crazy".

   The STORY itself carries retention. Setup + motivation + stakes (all
   present from Stage 3A) keep the viewer watching. Retention markers
   are training wheels — strip them.

3. NO FUTURE-TEASE OPEN LOOPS
   Same rule: do not insert "this character comes back later" / "this
   sets up the entire arc" / "what happens next will flip everything"
   type future teases. If the input has any, delete them and let the
   story continuation handle the pull.

4. PATTERN INTERRUPTS — convert 2-3 standard paragraphs into PUNCHY
   ones (1-2 sentences) at moments of impact, silence, or revelation.
   This breaks the rhythm and grabs attention.

═══════════════════════════════════════════════════════════════════════
PRESERVE — DO NOT CHANGE
═══════════════════════════════════════════════════════════════════════
• All character names exactly as written
• All plot points and events
• Sequential order (paragraph N still corresponds to panel N)
• Present-tense, third-person, casual YouTube narrator tone
• Number of paragraphs — MUST equal ${n}

CHARACTERS in this story (use these names exactly):
${characterBlock}

═══════════════════════════════════════════════════════════════════════
DRAFT SCRIPT — ${n} paragraphs
═══════════════════════════════════════════════════════════════════════

${numberedScript}

═══════════════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════════════
Output the polished script as EXACTLY ${n} numbered paragraphs.
No preamble, no meta-commentary, no markdown fences — JUST the
numbered blocks, blank line between paragraphs.

1. <polished paragraph 1 — HOOK version, 2-3 sentences>

2. <polished paragraph 2>

...

${n}. <polished paragraph ${n}>`;
}
