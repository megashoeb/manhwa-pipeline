// Stage 4e — structural editor pass (final production polish).
//
// Runs AFTER the phrase-polish pass (Stage 4d). Catches what phrase
// rotation can't see:
//
//   • Cyclical beat patterns — e.g. shock → dominate → "underestimated"
//     → realization → humiliation → repeat. Same emotional skeleton in
//     different words still reads as AI.
//
//   • Sentence-opener repetition — "Idun stares...", "Idun cannot...",
//     "Idun looks..." across paragraphs.
//
//   • Uniform paragraph structure — every paragraph following the same
//     Action→Internal→Result shape.
//
// One additional Gemini call per chapter. Like the polish pass, the
// 1:1 panel↔paragraph invariant is sacred — if the output count ever
// drifts, we retry once with an emphatic corrective prompt, then fall
// back to the phrase-polished input on second failure (safer than
// breaking SRT sync).

import type { CharacterBible } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

import { generateContent } from "./geminiClient";
import { parseNumberedLines } from "./narrator";

/** Hard ceiling on a single structural-edit call — keeps output under token caps. */
const MAX_PARAGRAPHS_PER_CALL = 60;

export interface StructuralEditOptions {
  model: string;
  rotator: KeyRotator;
  bible: CharacterBible;
  /**
   * Long-form recap mode. When ``true`` the structural prompt enforces
   * short paragraphs (30-45 words, hard cap 50) and skips the "Action
   * → Internal → Result" multi-shape guidance that tends to expand
   * paragraphs. Used inside the 80-chapter / 2.5-hr flow.
   */
  longFormRecap?: boolean;
  onProgress?: (current: number, total: number, msg: string) => void;
  onKeyUsed?: (masked: string) => void;
}

/**
 * Structurally edit a phrase-polished script in one Gemini call.
 *
 * Returns a list with EXACTLY the same length as the input. If Gemini
 * returns a different count, we retry ONCE with a corrective prompt
 * that quotes the wrong number back; if that also fails we return the
 * input unchanged. The downstream SRT step relies on length parity.
 */
export async function structurallyEditScript(
  lines: string[],
  options: StructuralEditOptions,
): Promise<string[]> {
  if (lines.length === 0) return lines;

  if (lines.length > MAX_PARAGRAPHS_PER_CALL) {
    console.warn(
      `Script has ${lines.length} paragraphs — exceeds structural-edit cap ` +
        `of ${MAX_PARAGRAPHS_PER_CALL}. Skipping structural pass.`,
    );
    return lines;
  }

  options.onProgress?.(
    0,
    1,
    "Structural edit (beat-pattern + opener variety)…",
  );

  const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join("\n\n");
  const longForm = options.longFormRecap ?? false;
  const firstPrompt = buildPrompt(
    lines.length,
    options.bible,
    numbered,
    null,
    longForm,
  );

  // ---- Attempt 1 ----------------------------------------------------
  let edited = await callAndParse(firstPrompt, options);

  if (validate(edited, lines.length)) {
    options.onProgress?.(1, 1, "Structural edit complete.");
    return edited;
  }

  // ---- Attempt 2 (corrective retry) --------------------------------
  console.warn(
    `Structural edit returned ${edited.length} paragraphs, expected ${lines.length}. ` +
      "Retrying with emphatic count reminder.",
  );
  options.onProgress?.(
    0,
    1,
    `Retrying structural edit (last attempt: ${edited.length} of ${lines.length})…`,
  );
  const retryPrompt = buildPrompt(
    lines.length,
    options.bible,
    numbered,
    edited.length,
    longForm,
  );
  edited = await callAndParse(retryPrompt, options);

  if (validate(edited, lines.length)) {
    options.onProgress?.(1, 1, "Structural edit complete (after retry).");
    return edited;
  }

  console.warn(
    `Structural edit retry still mismatched (${edited.length} vs ${lines.length}). ` +
      "Falling back to phrase-polished script.",
  );
  options.onProgress?.(1, 1, "Structural edit skipped (count mismatch).");
  return lines;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function callAndParse(
  prompt: string,
  options: StructuralEditOptions,
): Promise<string[]> {
  const raw = await generateContent(options.rotator, {
    model: options.model,
    prompt,
    // Higher than the phrase polish — we want NEW angles, not faithful
    // reproduction of the input.
    temperature: 0.85,
    topP: 0.95,
    onKeyUsed: options.onKeyUsed,
  });
  return parseNumberedLines(raw);
}

function validate(edited: string[], expected: number): boolean {
  if (edited.length !== expected) return false;
  if (edited.some((p) => p.trim().length === 0)) {
    console.warn("Structural edit produced empty paragraph(s).");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

/**
 * Build the structural-edit prompt.
 *
 * ``previousAttemptCount`` is non-null on the retry path — it injects
 * a corrective preamble that quotes the wrong count back so Gemini
 * can self-correct rather than repeating the same drift.
 */
function buildPrompt(
  n: number,
  bible: CharacterBible,
  numberedScript: string,
  previousAttemptCount: number | null,
  longFormRecap: boolean,
): string {
  const characterBlock =
    Object.entries(bible.characters)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n") || "(no named characters)";

  const corrective =
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
${n}, you must adjust. Do NOT merge paragraphs. Do NOT split paragraphs.
Do NOT drop paragraphs. Do NOT add paragraphs. ONE-TO-ONE mapping.

`
      : "";

  // ----- Long-form rule injection --------------------------------------
  const longFormRules = longFormRecap
    ? `
═══════════════════════════════════════════════════════════════════════
⚠️  LONG-FORM RECAP MODE — TIGHT PARAGRAPHS ARE NON-NEGOTIABLE
═══════════════════════════════════════════════════════════════════════
This script lives inside an 80-chapter / 2.5-hour mega video. Each
chapter only gets ~2 minutes. The draft you receive is ALREADY tight
(1-2 sentences, 30-45 words per paragraph). Your job is to vary
BEATS and STRUCTURE without expanding word counts.

Rules that OVERRIDE anything else below:
  • PRESERVE the 1-2 sentence, ~40-word format. Never expand a
    paragraph beyond 50 words.
  • The "STEP 4 — paragraph-shape variety" rules below assume longer
    paragraphs (Action → Internal → Result, etc.). In long-form mode
    those shapes mostly do NOT apply — each paragraph is ONE beat.
    Vary which KIND of beat (action vs aftermath vs reveal vs
    silence) rather than internal multi-step structure.
  • Skip "deep exposition" rewrites. Drop "5-6 sentence beats" — that
    isn't this format.
  • New-angle rewrites are still valid, but compressed: if you'd
    normally write "His mind races through every battle he's ever
    won. He remembers...", instead use ONE sentence: "Every battle
    he's ever won flashes through his mind, and not one of them
    prepared him for this."

Final check: if any output paragraph > 50 words, TRIM. This rule
overrides everything else in the prompt.
`
    : "";

  return `You are a SENIOR YouTube manhwa script editor doing the FINAL structural pass.

The draft below has already had phrase-level rotation done (overused phrases like "understanding washes over", "looms over" are gone). Your job is to fix the deeper problem the phrase pass can't see: CYCLICAL BEAT REPETITION.
${corrective}${longFormRules}
═══════════════════════════════════════════════════════════════════════
🚫 ABSOLUTE RULE — NEVER DESCRIBE PANELS
═══════════════════════════════════════════════════════════════════════
You are editing STORY NARRATION, not picture descriptions.

FORBIDDEN PHRASES — delete if seen, never introduce:
  ✗ "The panel shows..."          ✗ "A close-up of..."
  ✗ "A wide shot shows..."         ✗ "A sound effect panel..."
  ✗ "The text reads..."            ✗ "A speech bubble emerges..."
  ✗ "The narration notes..."       ✗ "The image depicts..."
  ✗ "We see..."                    ✗ "An image of..."

═══════════════════════════════════════════════════════════════════════
🔒 PARAGRAPH ORDER IS SACRED
═══════════════════════════════════════════════════════════════════════
Paragraph i = same panel as paragraph i in input. Period.

NEVER swap, shift, merge, or reorder. If a paragraph is already
clean, copy it OUT EXACTLY UNCHANGED. If you can't safely edit
paragraph i, leave it unchanged rather than risk a positional shift.

═══════════════════════════════════════════════════════════════════════
HARD CONSTRAINT — VIOLATION = PIPELINE BREAK
═══════════════════════════════════════════════════════════════════════
Output MUST contain EXACTLY ${n} numbered paragraphs (same as input).
Paragraph i in your output = the same panel as paragraph i in the input.
NEVER merge, drop, split, add, or reorder paragraphs.

Count your output before finishing. If the count is wrong, restart.

═══════════════════════════════════════════════════════════════════════
THE PROBLEM YOU ARE FIXING
═══════════════════════════════════════════════════════════════════════

AI-generated recap scripts fall into cyclical patterns like:

    shock → dominate → "underestimated" → realization → humiliation
         → shock → dominate → "underestimated" → ... (loop)

The viewer subconsciously notices the loop within 60 seconds and
clicks away. Your job is to BREAK the loop while keeping the plot
and panel mapping intact.

═══════════════════════════════════════════════════════════════════════
STEP 1 — DETECT REPEATED BEATS (silently, in your head)
═══════════════════════════════════════════════════════════════════════

For EACH character in the script, count how many times each beat-type
appears:
  • emotional beats: shock, fear, fury, disbelief, realization, despair
  • action beats:    dominates, strikes, monologues, towers, mocks
  • reveal beats:    "underestimated", "always knew", "step ahead"

═══════════════════════════════════════════════════════════════════════
STEP 2 — CAP EACH BEAT AT 3 INSTANCES PER CHARACTER
═══════════════════════════════════════════════════════════════════════

After 3 instances of the same beat for the same character, REWRITE
the next instance with a NEW ANGLE from the toolkit below. Keep the
plot fact intact — change HOW it's expressed.

NEW-ANGLE TOOLKIT — rotate aggressively:

  Shock / disbelief →
    • Tactical: his mind racing through past battles he should have won
    • Physical micro-tell: jaw clenches / breath catches / knuckles whiten
    • Inaction: words die in his throat, the body refuses to move
    • Memory: a forgotten moment surfaces and reframes everything
    • Silence: describe the deafening quiet instead of stating shock
    • Audience reaction: the soldiers watching go still

  Dominance / "stands over" →
    • Tactical: speak about the trap that's already three moves ahead
    • Mercy: lower the blade, give a choice (worse than killing)
    • Indifference: don't look at them at all, focus elsewhere
    • Information: drop a secret that undoes their identity
    • Departure: turn and walk away mid-confrontation
    • Patience: wait in silence and let the fear do the work

  "Underestimated" / reveal beats →
    • Show a flashback fragment instead of stating the realization
    • Have a SECONDARY character voice it (a soldier, a witness)
    • Replace with a CONSEQUENCE (allies fleeing, banners falling)
    • Replace with PROOF (a specific earlier moment paying off now)
    • Replace with a sensory anchor (a sound, an image, a smell)

  Humiliation →
    • Physical loss of bearing — knees buckle, weapon slips
    • Loss of audience — allies turning their backs
    • Internal collapse via memory — the legend's prime moment plays in reverse
    • Cold acceptance — he stops fighting and just watches
    • Silence from the dominant character (more humiliating than words)

═══════════════════════════════════════════════════════════════════════
STEP 3 — SENTENCE-OPENER VARIETY
═══════════════════════════════════════════════════════════════════════

Check the FIRST 4-5 WORDS of every paragraph in the script.

Within any 5-paragraph window, NO TWO paragraphs may start with:
  • the same character name
  • the same subject-verb structure
  • the same connector ("Suddenly...", "By now...", etc.)

If you see:
  P3: "Idun stares in shock at the figure above him..."
  P5: "Idun's mind races as he..."
  P7: "Idun cannot accept..."
→ ROTATE openers. Use:
  • another character as subject
  • an environmental description first
  • a fragment of dialogue first
  • a sensory anchor first ("The wind shifts...", "A single drop of blood...")
  • the consequence first, character second

═══════════════════════════════════════════════════════════════════════
STEP 4 — PARAGRAPH-SHAPE VARIETY
═══════════════════════════════════════════════════════════════════════

Don't let every paragraph follow the same internal shape. Mix these:

  A. Action → Internal thought → Result
  B. Description → Silence → Action
  C. Dialogue → Reaction → Description
  D. Memory/flashback → Present moment
  E. Environment → Character action → Stakes
  F. Sound/image → Realization → Beat
  G. Consequence first → Cause revealed → Reaction

Aim for AT LEAST 4 different shapes across the script. If every
paragraph reads "X does Y, thinks Z, feels W" — break it.

═══════════════════════════════════════════════════════════════════════
PRESERVE — DO NOT CHANGE
═══════════════════════════════════════════════════════════════════════
• All character names exactly as written in the bible
• All plot points and events
• Sequential order — paragraph N still corresponds to panel N
• Present-tense, third-person, casual YouTube tone
• The YouTube hook on paragraph 1 (if present, keep its energy)
• Retention markers already added (e.g. "Now this is where things get insane")
• Number of paragraphs — MUST equal ${n}

═══════════════════════════════════════════════════════════════════════
CHARACTERS in this story (use these names exactly)
═══════════════════════════════════════════════════════════════════════
${characterBlock}

═══════════════════════════════════════════════════════════════════════
DRAFT SCRIPT — ${n} paragraphs (phrase-polished, needs structural fix)
═══════════════════════════════════════════════════════════════════════

${numberedScript}

═══════════════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════════════
Output the structurally-edited script as EXACTLY ${n} numbered paragraphs.
No preamble. No analysis. No markdown fences. No labels.
Just the numbered blocks separated by blank lines.

FINAL REMINDER: Count your paragraphs before stopping. They MUST equal ${n}.

1. <structurally edited paragraph 1>

2. <structurally edited paragraph 2>

...

${n}. <structurally edited paragraph ${n}>`;
}
