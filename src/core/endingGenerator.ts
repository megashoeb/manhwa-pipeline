// Series outro generator.
//
// When a user finalizes a multi-batch series (e.g. 50 chapters of
// Solo Leveling accumulated across 5 separate processing days), we
// want a clean closing paragraph that wraps the whole story —
// something like:
//
//   "And so, the journey of the world's strongest hunter draws to
//    a close. From a feeble E-rank to the Monarch of Shadows,
//    Sung Jin-Woo's tale leaves a legacy carved across worlds."
//
// This module makes ONE small Gemini call with the series title +
// the last ~5 lines of the accumulated script as context. Cheap
// (one call, ~500 tokens) and the output reads naturally because
// the model sees what just happened in the story.

import { generateContent } from "./geminiClient";
import type { KeyRotator } from "./keyRotator";
import { MODEL_TIERS } from "./modelTiers";

export interface EndingOptions {
  /** Series title — gives the model context ("a recap of X"). */
  seriesTitle: string;
  /**
   * The trailing lines of the final accumulated script — gives the
   * model the immediate narrative state to write FROM. Pass the
   * last 4-6 beats for best results.
   */
  tailLines: string[];
  /** Optional total chapter count, used in the prompt for scope. */
  chapterCount?: number;
  rotator: KeyRotator;
  /** Surfaced for UI logging. */
  onKeyUsed?: (masked: string) => void;
}

/**
 * Generate a 2-3 sentence outro for the series. Falls back to a
 * generic template on API failure so the finalize flow never blocks
 * on a flaky model — the user always gets *some* ending.
 */
export async function generateSeriesEnding(
  opts: EndingOptions,
): Promise<string> {
  const { seriesTitle, tailLines, chapterCount, rotator, onKeyUsed } = opts;

  // Defensive: don't send the model an empty context — fall straight
  // to the template fallback.
  if (tailLines.length === 0) {
    return defaultEnding(seriesTitle, chapterCount);
  }

  const tailJoined = tailLines.slice(-6).join("\n");
  const prompt = [
    "You are writing the CLOSING outro of a YouTube manhwa recap video.",
    "",
    `Series title: ${seriesTitle}`,
    chapterCount && chapterCount > 0
      ? `Total chapters recapped: ${chapterCount}`
      : "",
    "",
    "Below are the LAST FEW NARRATION BEATS from the recap (this is what",
    "the viewer just heard). Your job is to write 2-3 sentences that",
    "naturally close the story.",
    "",
    "Rules:",
    "  • 2 to 3 sentences, no more.",
    "  • Reflective / conclusive tone — give the viewer closure.",
    "  • Reference the character or arc concretely (no generic",
    '    "their adventure continues"-style filler).',
    "  • Do NOT add a call-to-action, hashtag, or video-housekeeping",
    '    line like "thanks for watching".',
    "  • Do NOT restart with a hook ('What if…?', 'Imagine if…').",
    "  • Plain prose only — no markdown, no quotes around it, no",
    "    surrounding narration tags.",
    "",
    "Last beats of the script:",
    tailJoined,
    "",
    "Now write the 2-3 sentence outro:",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const raw = await generateContent(rotator, {
      model: MODEL_TIERS.polish,
      fallbackModel: MODEL_TIERS.script,
      prompt,
      responseMimeType: "text/plain",
      temperature: 0.6,
      onKeyUsed,
    });
    return cleanEndingText(raw) || defaultEnding(seriesTitle, chapterCount);
  } catch (err) {
    console.warn("Ending generation failed — using template fallback:", err);
    return defaultEnding(seriesTitle, chapterCount);
  }
}

/**
 * Strip incidental wrappers the model sometimes adds despite the
 * "plain prose only" instruction: surrounding quotes, leading
 * "Outro:" labels, bullet-point markers, etc.
 */
function cleanEndingText(raw: string): string {
  let s = raw.trim();
  // Strip a leading label like "Outro:" or "Ending:"
  s = s.replace(/^(outro|ending|closing|conclusion)\s*[:\-—]\s*/i, "");
  // Strip surrounding straight or smart quotes
  s = s.replace(/^["“'']+/, "").replace(/["”'']+$/, "");
  // Collapse internal newlines to a single space — keep it one paragraph
  s = s.replace(/\s*\n+\s*/g, " ").trim();
  return s;
}

/** Generic template used when Gemini is unavailable or returns junk. */
function defaultEnding(title: string, chapterCount?: number): string {
  const span = chapterCount && chapterCount > 0 ? ` across ${chapterCount} chapters` : "";
  return (
    `And so the tale of ${title} draws to a close${span}. ` +
    "Every triumph, every loss, every shadow led to this moment — " +
    "the kind of journey that doesn't end so much as echo onward."
  );
}
