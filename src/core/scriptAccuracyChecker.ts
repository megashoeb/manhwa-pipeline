// Stage 6 — image ↔ narration accuracy check.
//
// Runs AFTER phrase polish (4d) and structural edit (4e). Sends the
// curated panel images back to Gemini ALONG WITH the final polished
// script and asks: "for each panel, does the paragraph accurately
// describe what's in the image? If not, output a corrected paragraph
// that fixes the inaccuracy."
//
// What we're catching:
//   • Hallucinated actions (image shows defense, script says attack)
//   • Wrong attributions (script names character A doing something
//     that character B actually did)
//   • Polish/structural drift (polish rewrote a meaning rather than
//     just phrasing)
//   • Blank-panel narration (we ran the curator blank-skip rule too,
//     but if a blank slips through this corrects the narration)
//
// What we DON'T promise:
//   • Subtle plot inversions where the image is ambiguous
//   • Character mix-ups where two look-alikes share a panel
//   • These would need human review.
//
// Cost: one Gemini call per chapter (sends N images + script).
// 80-chapter run = +80 calls. Free-tier 500 RPD comfortably handles
// it with 2 rotated keys.
//
// Length invariant: output count must equal input count. If it
// doesn't, we fall back to the input script — we never break SRT
// sync to "fix accuracy".

import type { CharacterBible, FilteredPage } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";

import { generateContent } from "./geminiClient";
import { parseNumberedLines } from "./narrator";

/** Hard ceiling — accuracy call sends all N images, can't blow the input cap. */
const MAX_PANELS_PER_CALL = 40;

export interface AccuracyCheckOptions {
  model: string;
  rotator: KeyRotator;
  bible: CharacterBible;
  /**
   * Long-form mode propagates the tight-paragraph rule into the
   * corrections — otherwise the accuracy checker might "fix" a 35-
   * word paragraph by expanding it to 80.
   */
  longFormRecap?: boolean;
  onKeyUsed?: (masked: string) => void;
  onProgress?: (current: number, total: number, msg: string) => void;
}

/**
 * Verify each panel's narration against the panel image and rewrite
 * the inaccurate ones. Returns a list with exactly ``lines.length``
 * entries — corrected where Gemini flagged a mismatch, original
 * otherwise.
 *
 * Falls back to ``lines`` on count mismatch or empty output so the
 * downstream SRT sync invariant is never broken.
 */
export async function checkAndCorrectScript(
  panels: FilteredPage[],
  lines: string[],
  options: AccuracyCheckOptions,
): Promise<string[]> {
  if (lines.length === 0 || panels.length === 0) return lines;

  if (panels.length !== lines.length) {
    console.warn(
      `Accuracy check skipped — panel count (${panels.length}) != line count (${lines.length}).`,
    );
    return lines;
  }

  if (panels.length > MAX_PANELS_PER_CALL) {
    console.warn(
      `Accuracy check skipped — ${panels.length} panels exceeds cap of ` +
        `${MAX_PANELS_PER_CALL}.`,
    );
    return lines;
  }

  options.onProgress?.(
    0,
    1,
    `Verifying ${panels.length} panel-narration matches…`,
  );

  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join("\n\n");
  const prompt = buildPrompt(
    panels.length,
    options.bible,
    numbered,
    options.longFormRecap ?? false,
  );

  const raw = await generateContent(options.rotator, {
    model: options.model,
    prompt,
    images: panels.map((p) => p.blob),
    // Low — accuracy is about faithfulness, not creativity.
    temperature: 0.4,
    topP: 0.9,
    onKeyUsed: options.onKeyUsed,
  });

  const corrected = parseNumberedLines(raw);

  if (corrected.length !== lines.length) {
    console.warn(
      `Accuracy check returned ${corrected.length} paragraphs, expected ${lines.length}. ` +
        "Falling back to pre-check script.",
    );
    options.onProgress?.(1, 1, "Accuracy check skipped (count mismatch).");
    return lines;
  }
  if (corrected.some((p) => p.trim().length === 0)) {
    console.warn("Accuracy check produced empty paragraph(s); falling back.");
    return lines;
  }

  // ----- Critical: sync-break detection ----------------------------
  // Gemini sometimes preserves COUNT but silently reorders paragraphs
  // (e.g. output[i] actually describes input[i+1]'s panel). The count
  // check above can't see this. We catch it by comparing each output
  // paragraph to its input slot AND to its neighbors via word overlap:
  // if output[i] is dramatically more similar to input[i+1] than to
  // input[i] for many positions, the script has shifted — fall back.
  if (detectSyncBreak(lines, corrected)) {
    console.warn(
      "Accuracy check appears to have shifted paragraph alignment. " +
        "Falling back to pre-check script to preserve SRT sync.",
    );
    options.onProgress?.(1, 1, "Accuracy check skipped (sync drift).");
    return lines;
  }

  // Count how many actually changed so we can report it.
  let changedCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== corrected[i].trim()) changedCount++;
  }
  options.onProgress?.(
    1,
    1,
    `Accuracy check complete — ${changedCount} of ${lines.length} paragraph${changedCount === 1 ? "" : "s"} corrected.`,
  );
  return corrected;
}

// ---------------------------------------------------------------------
// Sync-break detection
// ---------------------------------------------------------------------

/**
 * Detect whether the accuracy checker silently shifted paragraph
 * positions (e.g. output[i] now describes input[i+1]'s panel).
 *
 * Strategy: for each i, compute Jaccard word overlap between
 * ``corrected[i]`` and three candidates — ``input[i-1]``, ``input[i]``,
 * ``input[i+1]``. If MANY outputs match a neighbour better than their
 * own slot (and the absolute overlap is non-trivial), the script has
 * shifted and we must fall back.
 *
 * Returns ``true`` when a shift is detected.
 */
function detectSyncBreak(input: string[], output: string[]): boolean {
  if (input.length !== output.length || input.length < 3) return false;

  // Tokenize once.
  const inToks = input.map(tokenize);
  const outToks = output.map(tokenize);

  let shiftSignals = 0;
  for (let i = 0; i < output.length; i++) {
    const here = jaccard(outToks[i], inToks[i]);
    const prev = i > 0 ? jaccard(outToks[i], inToks[i - 1]) : 0;
    const next =
      i + 1 < input.length ? jaccard(outToks[i], inToks[i + 1]) : 0;

    // Signal: output[i] is meaningfully closer to a neighbour than
    // to its own slot. Threshold gap (0.15) avoids noise from minor
    // rewrites that share generic words.
    const bestNeighbour = Math.max(prev, next);
    if (bestNeighbour > 0.3 && bestNeighbour - here > 0.15) {
      shiftSignals++;
    }
  }

  // If ≥25% of paragraphs show shift signal, alignment is broken.
  // One or two stray signals can happen from natural rewriting; a
  // genuine off-by-one shows up across many positions.
  return shiftSignals >= Math.ceil(output.length * 0.25);
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z]{4,}/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

function buildPrompt(
  n: number,
  bible: CharacterBible,
  numberedScript: string,
  longFormRecap: boolean,
): string {
  const characters =
    Object.entries(bible.characters)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n") || "(no named characters)";

  const lengthRule = longFormRecap
    ? `
LONG-FORM MODE — KEEP PARAGRAPHS TIGHT:
  • Corrections must stay within 30-45 words (hard cap 50).
  • If you NEED to fix a paragraph, the fixed version MUST be the
    same length or shorter. Never bloat for "completeness".
`
    : `
Corrections should preserve the original paragraph's approximate
length (don't dramatically expand or shrink).
`;

  return `You are a YouTube manhwa recap script FACT-CHECKER.

I'm sending you ${n} panel images IN READING ORDER and the matching ${n}-paragraph narration script (paragraph i corresponds to panel i). Your job: for each panel, check that the paragraph accurately describes what's actually IN the image.

CHARACTERS in this story (use these exact names):
${characters}

═══════════════════════════════════════════════════════════════════════
WHAT COUNTS AS AN INACCURACY (fix these)
═══════════════════════════════════════════════════════════════════════
✗ Wrong action — script says "X attacks" but image shows X defending,
   blocking, or recoiling.
✗ Wrong character — script attributes an action to character A, but
   the image clearly shows character B doing it.
✗ Hallucinated detail — script describes a sword/wound/expression
   that isn't visible in the panel.
✗ Wrong mood — script says "calm" but image shows clear distress (or
   vice versa).
✗ Wrong intent — script says "attack setup" but image is "defense"
   (or vice versa).
✗ Wrong pose / state — script says "lies defeated on the ground" but
   image shows the character STANDING (or vice versa). Pose, posture,
   and physical state are checkable visually — flag mismatches.
✗ TRULY blank-panel narration — when the panel is 70%+ visually
   empty (solid black, solid white, smooth gradient, OR mostly-empty
   frame with only a tiny content fragment in a corner).
   For these, rewrite the narration so it ONLY describes what is
   ACTUALLY visible — do not fabricate scenes that aren't in the
   panel.

   THE SNEAKY CASE — most common failure mode:
   The panel has a tiny content fragment (a sliver of clothing, a
   small dagger handle, a single eye, a fragment of debris) in maybe
   15-25% of the frame, with the rest being pure white or black.
   The narrator gets excited and FABRICATES an entire scene that
   the image does not contain:

     BAD example — script invents content not in image:
        Image: 80% white, top sliver shows clothing edge + dagger
        Script: "The scene shifts to a quiet room. Ghislain stands
                in the study, holding a small framed portrait. He
                looks down at the image and asks, 'Yeah...?'"
        Problem: There is NO room, NO study, NO portrait, NO 'Yeah'
                in the image. The narrator hallucinated everything.

     GOOD correction — describe only what IS there:
        "A blade glints against an empty backdrop." (factual)
        Or simply: "A beat passes." (transition)
        Or: "The scene fades into silence." (transition)

   When the panel is mostly empty, the safe move is ALWAYS to
   describe only the visible fragment OR use a transition line.
   Never expand a tiny visual fragment into a full narrative scene.

   ⚠️  DO NOT call a panel "blank" just because there's no character
   close-up. The following are NOT blank — they are story content:
     • Rain / weather / atmospheric effects over a battlefield
     • Sound effects with visible bodies, debris, or environment
     • Wide shots of corpses or aftermath
     • Silhouettes or partial figures in shadow
     • Speech / narration bubbles with text (those ARE story content)
   For these, KEEP the narration's story description — only fix
   factual inaccuracies in WHAT it describes, don't strip the detail.

═══════════════════════════════════════════════════════════════════════
TEXT-ONLY DIALOGUE CARDS — special handling
═══════════════════════════════════════════════════════════════════════
Some panels are pure text on solid black/white background — a
dialogue card carrying a character's spoken line (often a key
declaration, threat, oath, or last words). These ARE story content,
NOT blank.

If the script's narration for such a panel ignored or paraphrased the
actual dialogue, REWRITE the narration to incorporate the dialogue
text faithfully. Example:

  Image shows: BLACK PANEL with text "YOU'RE TELLING ME THAT I,
              THE BEST KNIGHT OF THE NORTH..."
  Bad narration:  "The knight reels from his defeat."
  Good correction: "\"You're telling me that I, the Best Knight of
                   the North...\" — the words trail off as defeat
                   sinks in."

The actual dialogue text is gold — use it.

═══════════════════════════════════════════════════════════════════════
🚫 ABSOLUTE RULE — NEVER DESCRIBE PANELS WHEN REWRITING
═══════════════════════════════════════════════════════════════════════
This is STORY narration, not picture description. If you rewrite a
paragraph, write a STORY EVENT — never "A close-up of...", "The panel
shows...", "A sound effect panel...", "The text reads...", etc.

  WRONG ✗: "A close-up of Skovan's face, twisted in shock."
  RIGHT ✓: "Skovan's face twists in pure disbelief."

  WRONG ✗: "The text reads 'I traveled back to the past?'"
  RIGHT ✓: "'I traveled back to the past?' — the realisation hits cold."

If the EXISTING paragraph uses any of these forbidden openers, REWRITE
it as a story event in addition to whatever accuracy fix you make.

═══════════════════════════════════════════════════════════════════════
WHAT TO LEAVE ALONE (do NOT touch)
═══════════════════════════════════════════════════════════════════════
✓ Engaging YouTube tone — the casual present-tense narrator voice.
✓ Hook on paragraph 1 (if present) — keep its style.
✓ Retention markers ("Now this gets insane.", etc.) — keep them.
✓ Character reference rotations (name / "the heir" / "he").
✓ Phrasing that's accurate AND stylistically engaging.
✓ Any paragraph that already matches its image — leave it untouched.

═══════════════════════════════════════════════════════════════════════
HARD CONSTRAINT — DO NOT VIOLATE
═══════════════════════════════════════════════════════════════════════
Output MUST contain EXACTLY ${n} numbered paragraphs.
Paragraph i in your output = the same panel as paragraph i in the
input.
NEVER merge, drop, split, add, or reorder paragraphs.

If a paragraph is already accurate, copy it OUT UNCHANGED. Only
modify paragraphs with real inaccuracies.

If unsure ("the image is ambiguous, could be either reading"),
KEEP the original — don't introduce a different inaccuracy.
${lengthRule}
═══════════════════════════════════════════════════════════════════════
DRAFT SCRIPT — ${n} paragraphs (matched 1:1 to the ${n} attached panels)
═══════════════════════════════════════════════════════════════════════

${numberedScript}

═══════════════════════════════════════════════════════════════════════
OUTPUT
═══════════════════════════════════════════════════════════════════════
Output the fact-checked script as EXACTLY ${n} numbered paragraphs.
No preamble. No analysis. No flagging. No markdown fences.
Just the corrected numbered blocks separated by blank lines.

If paragraph i is accurate, output it UNCHANGED at position i.
If paragraph i is inaccurate, output the CORRECTED version at position i.

1. <paragraph 1 — accurate or corrected>

2. <paragraph 2 — accurate or corrected>

...

${n}. <paragraph ${n} — accurate or corrected>`;
}
