// Stage 4 — cross-chapter continuity bridges.
//
// After all chapters in a long-form recap run have been individually
// narrated, this stage generates a single transition sentence between
// every pair of consecutive chapters. The bridge is PREPENDED to the
// first paragraph of the next chapter — so the 1:1 panel↔paragraph
// invariant stays intact (no new paragraphs are added, no SRT block
// count changes downstream).
//
// Why it matters: each chapter is currently narrated in isolation, so
// when 80 chapters are concatenated, hard cuts appear at every chapter
// boundary. ("The knight bleeds out." → "Ghislain stands in his
// bedchamber.") The bridge sentence stitches the two beats so the
// viewer feels continuous flow — exactly what competitor channels do
// (Manhwa Chatter, Asura Recaps).
//
// Cost: N-1 lightweight text-only Gemini calls (no images). For an
// 80-chapter run that's 79 extra calls — comfortably under free-tier
// budget with two rotated keys.

import type { KeyRotator } from "./keyRotator";
import { generateContent } from "./geminiClient";

export interface BridgeOptions {
  model: string;
  rotator: KeyRotator;
  onKeyUsed?: (masked: string) => void;
}

/**
 * Generate a single bridge sentence (max ~20 words) connecting the
 * last beat of one chapter to the first beat of the next.
 *
 * Returns the cleaned bridge sentence, or empty string on failure
 * (caller should treat empty as "skip the bridge for this pair").
 * Never throws — bridges are best-effort.
 */
export async function generateBridgeSentence(
  lastBeatPrev: string,
  firstBeatCurr: string,
  options: BridgeOptions,
): Promise<string> {
  const prompt = buildPrompt(lastBeatPrev, firstBeatCurr);

  try {
    const raw = await generateContent(options.rotator, {
      model: options.model,
      prompt,
      // Moderate — natural prose, not creative invention.
      temperature: 0.6,
      topP: 0.9,
      onKeyUsed: options.onKeyUsed,
    });
    return cleanBridge(raw);
  } catch (err) {
    console.warn("Bridge sentence generation failed:", err);
    return "";
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Strip markdown wrappers, trailing newlines, redundant quoting, and
 * enforce the 25-word soft cap. Returns "" if the result is too short
 * to be a meaningful bridge.
 */
function cleanBridge(raw: string): string {
  let s = raw.trim();
  // Strip wrapping quotes and bullets.
  s = s.replace(/^["'`]+|["'`]+$/g, "").trim();
  s = s.replace(/^\s*[-*•]\s*/, "");
  // Keep only the first non-empty line — guard against multi-paragraph drift.
  s = s.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  // Hard cap at 25 words. Polite truncation with terminal punctuation.
  const words = s.split(/\s+/);
  if (words.length > 25) {
    s = words.slice(0, 25).join(" ");
    if (!/[.!?]$/.test(s)) s += ".";
  }
  // Reject obviously useless output.
  if (s.length < 8 || /^chapter\s*\d/i.test(s)) return "";
  return s;
}

function buildPrompt(lastBeat: string, firstBeat: string): string {
  return `You are stitching a continuous YouTube manhwa recap narration that covers many chapters back-to-back. Two consecutive chapters need a smooth bridge between them — viewers should feel ZERO break at the chapter boundary.

LAST BEAT OF PREVIOUS CHAPTER:
${lastBeat}

FIRST BEAT OF NEXT CHAPTER:
${firstBeat}

Write ONE short transition sentence (max 20 words) that smoothly connects these two beats. The sentence will be inserted BEFORE the first beat of the next chapter so the viewer hears: [last beat] → [your bridge] → [first beat], with no awareness of a chapter break.

═══════════════════════════════════════════════════════════════════════
RULES — STRICT
═══════════════════════════════════════════════════════════════════════
✓ Pure story narration. Bridge the action / scene / time as if it's one continuous moment.
✓ Present tense, third-person, casual YouTube tone (matches the rest of the script).
✓ Max 20 words. One sentence only.

✗ DO NOT say "in the next chapter", "chapter N", "later on", "the story continues", "next up".
✗ DO NOT describe panels — never "the panel shows", "a close-up of", "a wide shot".
✗ DO NOT introduce new characters or events not in the two beats above.
✗ DO NOT use markdown, quotes, or bullets. Output plain text only.

═══════════════════════════════════════════════════════════════════════
GOOD EXAMPLES
═══════════════════════════════════════════════════════════════════════
"Days later, the ash still hasn't settled."
"But the fall of the knight is only the opening move."
"When he finally opens his eyes again, the war is already in motion."
"Hours from now, the battlefield will look very different."
"Far from the carnage, the next move is already taking shape."

═══════════════════════════════════════════════════════════════════════
OUTPUT — just the bridge sentence, nothing else
═══════════════════════════════════════════════════════════════════════`;
}
