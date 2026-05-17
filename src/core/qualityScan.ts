// Post-process quality scanner.
//
// Runs over the FINAL polished script just before we ship the chapter
// into the combined output. Does NOT rewrite anything — the polish
// retry chain handles that. This scan's job is to DETECT violations
// that slipped through the prompt rules and surface them in the
// manifest so the user can spot-fix in 2 minutes.
//
// Detected categories:
//
//   1. Generic protagonist references — "the character", "this guy",
//      "this man", etc. The polish/segment/3A prompts all forbid
//      these, but Gemini occasionally still emits them under pressure.
//
//   2. Retention interjections — "Now this is where things get
//      insane.", "But wait until you see what he does next.", etc.
//      The polish prompt now strips these, but the scan catches any
//      that slipped through AND counts duplicates so the user knows
//      if the same phrase appears in 5 chapters.
//
//   3. Panel-description leaks — "The panel shows", "A close-up of",
//      "A wide shot", "A sound effect panel". The Rule A enforcement.
//
//   4. Bare-quote-dash openings — '"QUOTE" — tag' patterns at the
//      start of a beat. Polish strips these but scan catches misses.

export interface QualityWarning {
  /** 1-based beat index within the chapter. */
  beat_index: number;
  /** Category of violation. */
  category:
    | "generic_reference"
    | "retention_interjection"
    | "panel_description"
    | "bare_quote_dash"
    | "hook_repeat";
  /** The exact substring that triggered the warning (lowercased, trimmed). */
  matched: string;
  /** Short human-readable explanation for the manifest. */
  reason: string;
}

/**
 * Scan a chapter's final beats for quality violations.
 *
 * Returns a list of warnings. Never modifies the input. Caller (the
 * pipeline or bulkQueue) decides whether to surface to console / UI /
 * manifest. Most chapters return ``[]``.
 */
export function scanChapterQuality(beats: string[]): QualityWarning[] {
  const warnings: QualityWarning[] = [];

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const beatIndex = i + 1;

    // ----- 1. Generic protagonist references --------------------------
    // Word-boundary-aware matches so "the character is" fires but
    // "anything" doesn't (it contains "thing" but not "the character").
    const genericPatterns: Array<[RegExp, string]> = [
      [/\bthe character\b/i, "the character"],
      [/\ba figure\b/i, "a figure"],
      [/\bthe figure\b/i, "the figure"],
      [/\bthis character\b/i, "this character"],
      [/\bthis guy\b/i, "this guy"],
      [/\bthis man\b/i, "this man"],
      [/\bthis figure\b/i, "this figure"],
      [/\bthis person\b/i, "this person"],
      [/\bour protagonist\b/i, "our protagonist"],
      [/\bthe protagonist\b/i, "the protagonist"],
    ];
    for (const [re, label] of genericPatterns) {
      if (re.test(beat)) {
        warnings.push({
          beat_index: beatIndex,
          category: "generic_reference",
          matched: label,
          reason: `Generic protagonist reference "${label}" — use the character's name`,
        });
      }
    }

    // ----- 2. Retention interjections --------------------------------
    // Common AI retention-marker tells. Each pattern matches whether
    // it's at the start of a beat or embedded — both are violations.
    const retentionPatterns: Array<[RegExp, string]> = [
      [/now this is where (things|it) gets? (insane|crazy|wild)/i, "now this is where things get insane"],
      [/but wait (?:until|till) you see what (?:he|she|they) does? next/i, "but wait until you see what he does next"],
      [/and this is just the beginning/i, "and this is just the beginning"],
      [/remember this scene[^.]{0,40}pays off/i, "remember this scene — it pays off"],
      [/believe me[^.]{0,40}(comes back|pays off|won't believe)/i, "believe me, this pays off"],
      [/what happens next[^.]{0,40}(flip|change|rewrite)/i, "what happens next will flip everything"],
      [/this single decision[^.]{0,40}arc/i, "this single decision sets up the arc"],
      [/trust me[^.]{0,40}(later|payoff|insane|crazy)/i, "trust me, [later/payoff]"],
    ];
    for (const [re, label] of retentionPatterns) {
      if (re.test(beat)) {
        warnings.push({
          beat_index: beatIndex,
          category: "retention_interjection",
          matched: label,
          reason: `Retention interjection pattern "${label}" — polish should have stripped this`,
        });
      }
    }

    // ----- 3. Panel-description leaks (Rule A) -----------------------
    const descPatterns: Array<[RegExp, string]> = [
      [/\bthe panel shows\b/i, "the panel shows"],
      [/\ba close[- ]up of\b/i, "a close-up of"],
      [/\ba wide shot\b/i, "a wide shot"],
      [/\ba sound effect panel\b/i, "a sound effect panel"],
      [/\bthe text reads\b/i, "the text reads"],
      [/\ba speech bubble emerges\b/i, "a speech bubble emerges"],
      [/\bthe narration notes\b/i, "the narration notes"],
      [/\bthe image depicts\b/i, "the image depicts"],
      [/\ba beat passes\b/i, "a beat passes"],
      [/\bthe scene shifts\b/i, "the scene shifts"],
      [/\bthis panel\b/i, "this panel"],
    ];
    for (const [re, label] of descPatterns) {
      if (re.test(beat)) {
        warnings.push({
          beat_index: beatIndex,
          category: "panel_description",
          matched: label,
          reason: `Panel-description leak "${label}" — should be narrative, not descriptive`,
        });
      }
    }

    // ----- 4. Bare-quote-dash openings --------------------------------
    // Pattern: beat starts with optional whitespace, then a quoted
    // string, then an em-dash / hyphen + space tag. Both straight
    // and smart quotes covered.
    if (/^\s*[“"][^"”]+[”"]\s*[—–-]\s+\S/.test(beat)) {
      warnings.push({
        beat_index: beatIndex,
        category: "bare_quote_dash",
        matched: beat.slice(0, 60),
        reason: 'Bare "QUOTE" — tag opening — quotes must be embedded in narration',
      });
    }

    // ----- 5. Hook repeat — hook patterns AFTER beat 1 ---------------
    // Hooks are reserved for beat 1 of the chapter (beat 1 of chapter 1
    // is the only beat in the entire video that should have a hook).
    // Any "What if...?" / "Imagine if..." / similar pattern in a later
    // beat means the hook-uniqueness guard failed.
    if (beatIndex > 1) {
      const hookPatterns: Array<[RegExp, string]> = [
        [/^\s*What if\b/i, "What if..."],
        [/^\s*Imagine if\b/i, "Imagine if..."],
        [/^\s*In a world where\b/i, "In a world where..."],
        [/^\s*By the end of (?:this video|this clip|this recap)\b/i, "By the end of this..."],
        [/^\s*This man just\b/i, "This man just..."],
        [/^\s*This is the story of\b/i, "This is the story of..."],
        [/^\s*Welcome (?:back )?to\b/i, "Welcome to..."],
        [/^\s*Today we're (?:looking at|covering|recapping)\b/i, "Today we're recapping..."],
      ];
      for (const [re, label] of hookPatterns) {
        if (re.test(beat)) {
          warnings.push({
            beat_index: beatIndex,
            category: "hook_repeat",
            matched: label,
            reason: `Hook pattern "${label}" appearing at beat ${beatIndex} — hooks are reserved for beat 1 only`,
          });
        }
      }
    }
  }

  return warnings;
}

/**
 * Concise per-chapter summary string for the console log. e.g.
 *   "3 quality warnings: 2 generic_reference, 1 panel_description"
 */
export function summarizeWarnings(warnings: QualityWarning[]): string {
  if (warnings.length === 0) return "clean";
  const counts: Record<string, number> = {};
  for (const w of warnings) {
    counts[w.category] = (counts[w.category] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
  return `${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}
