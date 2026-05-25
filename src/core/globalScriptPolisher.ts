// Stage 6 — global script polish (after all chapters + bridges done).
//
// This runs ONCE per bulk run, AFTER the per-chapter polish (Stage 4d)
// and the cross-chapter bridges (Stage 4) have finished. It takes the
// assembled full-script-as-one-string and asks Gemini to:
//
//   1. Detect repeated opening hooks ("What if the weakest son…"
//      appearing 16 times) and replace each with a varied alternative.
//   2. Remove verbatim duplicate lines that crept in across chapters.
//   3. Rotate bridge phrases ("This chapter plunges us back…" × 10).
//   4. Apply a per-video STYLE SEED (dark-gritty / epic-mythic / etc.)
//      so each video feels distinct on the channel.
//   5. Apply a PACING pattern (cold-open / slow-build / fast-throughout).
//   6. PRESERVE everything else exactly:
//        - Line count (1 line = 1 panel = SRT timing)
//        - Every proper noun (character names, locations, abilities)
//        - Plot facts (no new events, no removed events)
//        - Manhwa-recap tone (YouTube casual, present tense, third person)
//
// Why a separate stage from per-chapter polish (4d)?
//   The 4d polish sees ONE chapter at a time. It can't detect that
//   chapter 1's hook is identical to chapter 12's hook — that's a
//   cross-chapter problem only this global pass can fix.
//
// Fallback strategy: if the polish call fails OR validation fails
// (line count mismatch, missing character name, etc.), the caller
// transparently uses the raw script. The polish step never blocks
// the user's run from completing.

import type { CharacterBible } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";
import { generateContent } from "./geminiClient";
import { debugLog } from "./debugLog";

/** The 5 style seeds the user picks from (or "auto" to randomise). */
export type StyleSeed =
  | "auto"
  | "dark-gritty"
  | "epic-mythic"
  | "punchy-action"
  | "introspective"
  | "cinematic";

/** Pacing pattern for the overall narrative arc. */
export type PacingPattern =
  | "auto"
  | "slow-build" // calm → tension → explosion
  | "fast-throughout" // relentless from line 1
  | "cold-open" // start mid-action, reveal context after
  | "wave"; // up-down-up rhythm

/** How aggressively to vary chapter opening hooks. */
export type HookVariety =
  | "low" // 1-2 hook variations across the run
  | "medium" // 3-4 variations
  | "high"; // each chapter opens uniquely

export interface GlobalPolishOptions {
  /** OpenRouter / Gemini model id. Default = google/gemini-2.5-flash-lite. */
  model?: string;
  rotator: KeyRotator;
  /** Final master bible — used to inject the "protected names" list. */
  bible?: CharacterBible | null;
  styleSeed: StyleSeed;
  pacing: PacingPattern;
  hookVariety: HookVariety;
  /** Hook for the UI to track which key handled the call. */
  onKeyUsed?: (maskedKey: string) => void;
}

export interface GlobalPolishResult {
  /** True if the polished version is being returned. False = fallback to raw. */
  applied: boolean;
  /** Always present. Polished if applied=true, else identical to input. */
  lines: string[];
  /** Human-readable reason when applied=false. */
  fallbackReason?: string;
  /** Token usage (when known) for cost display. */
  inputTokens?: number;
  outputTokens?: number;
  /** Which style seed was actually used (resolved from "auto"). */
  resolvedStyle: Exclude<StyleSeed, "auto">;
  resolvedPacing: Exclude<PacingPattern, "auto">;
}

const DEFAULT_POLISH_MODEL = "google/gemini-2.5-flash-lite";

const ALL_STYLE_SEEDS: Exclude<StyleSeed, "auto">[] = [
  "dark-gritty",
  "epic-mythic",
  "punchy-action",
  "introspective",
  "cinematic",
];

const ALL_PACING_PATTERNS: Exclude<PacingPattern, "auto">[] = [
  "slow-build",
  "fast-throughout",
  "cold-open",
  "wave",
];

/**
 * Resolve "auto" → a random concrete option. Uses Date.now() as a
 * weak seed so each video gets a different style without needing a
 * proper PRNG.
 */
function resolveStyle(s: StyleSeed): Exclude<StyleSeed, "auto"> {
  if (s !== "auto") return s;
  return ALL_STYLE_SEEDS[Math.floor(Math.random() * ALL_STYLE_SEEDS.length)];
}
function resolvePacing(p: PacingPattern): Exclude<PacingPattern, "auto"> {
  if (p !== "auto") return p;
  return ALL_PACING_PATTERNS[
    Math.floor(Math.random() * ALL_PACING_PATTERNS.length)
  ];
}

/**
 * Run the global polish pass. Returns the polished lines if everything
 * validates, otherwise returns the raw lines with applied=false and a
 * fallback reason the UI can surface.
 */
export async function polishScriptGlobally(
  rawLines: string[],
  opts: GlobalPolishOptions,
): Promise<GlobalPolishResult> {
  const resolvedStyle = resolveStyle(opts.styleSeed);
  const resolvedPacing = resolvePacing(opts.pacing);

  const startedAt = Date.now();
  debugLog.push({
    type: "stage-start",
    label: "global script polish",
    context: {
      lines: rawLines.length,
      style: resolvedStyle,
      pacing: resolvedPacing,
      hookVariety: opts.hookVariety,
      model: opts.model ?? DEFAULT_POLISH_MODEL,
    },
  });

  // Collect proper nouns from the bible so we can pass them to the
  // model as a "DO NOT CHANGE" list. If the bible is empty (Qwen
  // truncation fallback), we skip name-protection enforcement and
  // rely on the prompt's general "DO NOT change proper nouns" rule.
  const protectedNames: string[] = [];
  if (opts.bible) {
    for (const name of Object.keys(opts.bible.characters ?? {})) {
      if (name && name.trim()) protectedNames.push(name.trim());
    }
  }

  const prompt = buildPolishPrompt(
    rawLines,
    protectedNames,
    resolvedStyle,
    resolvedPacing,
    opts.hookVariety,
  );

  let polishedText: string;
  try {
    polishedText = await generateContent(opts.rotator, {
      model: opts.model ?? DEFAULT_POLISH_MODEL,
      prompt,
      // Plain text output — we'll line-split it ourselves.
      responseMimeType: "text/plain",
      // Low-ish temperature: variation in hooks is fine, but we don't
      // want creative content rewrites — facts/names must stay exact.
      temperature: 0.55,
      topP: 0.9,
      onKeyUsed: opts.onKeyUsed,
    });
  } catch (err) {
    const reason =
      err instanceof Error ? err.message.slice(0, 200) : String(err);
    debugLog.push({
      type: "stage-end",
      label: "global script polish",
      durationMs: Date.now() - startedAt,
      context: { fallback: true, reason },
    });
    return {
      applied: false,
      lines: rawLines,
      fallbackReason: `API call failed: ${reason}`,
      resolvedStyle,
      resolvedPacing,
    };
  }

  const polishedLines = parsePolishedOutput(polishedText);

  // ── Validation gates — any failure = fall back to raw ──────────────

  if (polishedLines.length !== rawLines.length) {
    const reason = `Line count mismatch — input ${rawLines.length} lines, output ${polishedLines.length}. Polish would break panel↔line SRT alignment.`;
    debugLog.push({
      type: "stage-end",
      label: "global script polish",
      durationMs: Date.now() - startedAt,
      context: { fallback: true, reason },
    });
    return {
      applied: false,
      lines: rawLines,
      fallbackReason: reason,
      resolvedStyle,
      resolvedPacing,
    };
  }

  // Every protected name that appeared in the input must still appear
  // in the output (case-sensitive substring check). Catches "Jaxon"
  // silently being rewritten to "Jackson", etc.
  for (const name of protectedNames) {
    const inInput = rawLines.some((l) => l.includes(name));
    if (!inInput) continue; // name wasn't mentioned in the script at all
    const inOutput = polishedLines.some((l) => l.includes(name));
    if (!inOutput) {
      const reason = `Character name "${name}" was preserved in input but lost in polished output.`;
      debugLog.push({
        type: "stage-end",
        label: "global script polish",
        durationMs: Date.now() - startedAt,
        context: { fallback: true, reason },
      });
      return {
        applied: false,
        lines: rawLines,
        fallbackReason: reason,
        resolvedStyle,
        resolvedPacing,
      };
    }
  }

  // Total length sanity — polished output shouldn't be wildly
  // shorter or longer than input (would indicate the model
  // summarised or padded rather than polished).
  const rawTotal = rawLines.join(" ").length;
  const polishedTotal = polishedLines.join(" ").length;
  const ratio = polishedTotal / Math.max(1, rawTotal);
  if (ratio < 0.7 || ratio > 1.6) {
    const reason = `Polished script length differs from raw too much (ratio ${ratio.toFixed(2)}). Likely summarised or padded — falling back.`;
    debugLog.push({
      type: "stage-end",
      label: "global script polish",
      durationMs: Date.now() - startedAt,
      context: { fallback: true, reason },
    });
    return {
      applied: false,
      lines: rawLines,
      fallbackReason: reason,
      resolvedStyle,
      resolvedPacing,
    };
  }

  // All validations passed — return polished.
  debugLog.push({
    type: "stage-end",
    label: "global script polish",
    durationMs: Date.now() - startedAt,
    context: {
      fallback: false,
      lines: polishedLines.length,
      style: resolvedStyle,
      pacing: resolvedPacing,
    },
  });

  return {
    applied: true,
    lines: polishedLines,
    resolvedStyle,
    resolvedPacing,
  };
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * Parse the model's polished output back into N lines. We instruct it
 * to return ONE LINE PER INPUT LINE, indexed (1. , 2. , 3. , …),
 * because plain newline-separated output is too easy for the model to
 * accidentally collapse / re-paragraph. The numbered format makes
 * misalignment obvious AND lets us recover even when the model adds
 * extra commentary lines.
 */
function parsePolishedOutput(raw: string): string[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:text|markdown)?\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();

  // Match: "<number>. <content>" or "<number>) <content>"
  // Allows multi-line content (rare but possible if the model added
  // a newline mid-sentence) by reading until the next "<number>." line.
  const lines: string[] = [];
  const blockRe = /^(\d+)[.)]\s*(.*)$/gm;
  const matches = [...cleaned.matchAll(blockRe)];
  for (const m of matches) {
    const content = m[2].trim();
    if (content) lines.push(content);
  }
  if (lines.length > 0) return lines;

  // Fallback: just split on newlines.
  return cleaned
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const STYLE_INSTRUCTIONS: Record<Exclude<StyleSeed, "auto">, string> = {
  "dark-gritty":
    "Short, punchy sentences. Visceral verbs (rips, shatters, bleeds, crumbles). Heavy on consequences and physical detail. Bleak undertone. Example tone: \"Blood. Steel. Silence. He stands alone.\"",
  "epic-mythic":
    "Longer flowing prose. Grand vocabulary (legendary, destiny, kingdoms, ancient). Mythological register. Example tone: \"In an age of dying kings, one warrior remembers what others forgot.\"",
  "punchy-action":
    "Rapid-fire pacing. Action verbs front-loaded. Heavy use of momentum and forward drive. Example tone: \"He swings. He blocks. He bleeds. He doesn't stop.\"",
  introspective:
    "Character POV thoughts threaded in. Internal monologue between actions. Slower, more reflective pace. Example tone: \"He had lived this moment three times before. This time, he wouldn't lose.\"",
  cinematic:
    "Visual scene-setting. Camera-angle style descriptions. Atmospheric and movie-like. Example tone: \"The camera pans across a battlefield drowning in mist as he rises one last time.\"",
};

const PACING_INSTRUCTIONS: Record<Exclude<PacingPattern, "auto">, string> = {
  "slow-build":
    "First 20% of lines: calm, atmospheric, setup. Middle 60%: rising tension and action. Final 20%: explosive payoff. Build energy progressively.",
  "fast-throughout":
    "Maintain HIGH energy from line 1 to the last line. No slow setup paragraphs. Every sentence drives forward.",
  "cold-open":
    "First 5-10 lines: drop the viewer into mid-action with no preamble. Then settle into context. Then rebuild momentum.",
  wave:
    "Alternate energy: fast section, then slower atmospheric beat, then fast again, then slower. Up-down-up rhythm. Lets viewers breathe between intensities.",
};

const HOOK_VARIETY_INSTRUCTIONS: Record<HookVariety, string> = {
  low: "Allow at most 2 distinct opening-hook templates across all chapters. Light variation only.",
  medium:
    "Use 3-4 distinct opening-hook templates across the script. Rotate them so no hook is repeated more than 3-4 times.",
  high: "EVERY chapter opening (any line that introduces a new chapter beat) must be unique — no two openings may share their first 4 words or structural template.",
};

function buildPolishPrompt(
  rawLines: string[],
  protectedNames: string[],
  style: Exclude<StyleSeed, "auto">,
  pacing: Exclude<PacingPattern, "auto">,
  hookVariety: HookVariety,
): string {
  // Number the input so the model can map output 1:1.
  const numbered = rawLines
    .map((line, i) => `${i + 1}. ${line}`)
    .join("\n");

  const namesList =
    protectedNames.length > 0
      ? protectedNames.map((n) => `  - ${n}`).join("\n")
      : "  (no character bible — preserve all proper nouns as-is)";

  return `You are a YouTube manhwa-recap script editor. The script below was assembled from per-chapter narrations, then stitched with cross-chapter bridges. It has TWO problems you must fix:

1. THE SAME OPENING HOOK ("What if the weakest son…", "This chapter plunges us back…", etc.) is repeated 10-20 times across the script. Each chapter currently re-introduces the protagonist with the same hook. This is unwatchable.

2. THE SAME BRIDGE PHRASES are recycled across chapter boundaries.

═══════════════════════════════════════════════════════════════════════
WHAT YOU MUST DO
═══════════════════════════════════════════════════════════════════════
- Detect every repeated hook + bridge phrase.
- Replace each repeated instance with a VARIED alternative that fits the surrounding context.
- Apply the STYLE and PACING rules below.
- Leave every NON-REPEATED line essentially untouched (small wording tweaks for flow are fine; do not rewrite the content).
- Output MUST have EXACTLY ${rawLines.length} lines, numbered 1 through ${rawLines.length}.

═══════════════════════════════════════════════════════════════════════
STYLE — ${style.toUpperCase()}
═══════════════════════════════════════════════════════════════════════
${STYLE_INSTRUCTIONS[style]}

═══════════════════════════════════════════════════════════════════════
PACING — ${pacing.toUpperCase()}
═══════════════════════════════════════════════════════════════════════
${PACING_INSTRUCTIONS[pacing]}

═══════════════════════════════════════════════════════════════════════
HOOK VARIETY — ${hookVariety.toUpperCase()}
═══════════════════════════════════════════════════════════════════════
${HOOK_VARIETY_INSTRUCTIONS[hookVariety]}

═══════════════════════════════════════════════════════════════════════
HARD RULES — DO NOT VIOLATE
═══════════════════════════════════════════════════════════════════════
✓ PRESERVE LINE COUNT EXACTLY: input has ${rawLines.length} lines, output MUST have ${rawLines.length} lines (numbered 1 through ${rawLines.length}). Each input line N maps to output line N.
✓ DO NOT merge lines. DO NOT split lines. DO NOT add lines. DO NOT delete lines.
✓ DO NOT introduce new events, new characters, new plot points.
✓ DO NOT change proper nouns. The following names MUST appear in the polished output identically to the input (same spelling, same capitalisation):
${namesList}
✓ Maintain present tense, third person, YouTube manhwa-recap tone (casual but punchy).
✓ Each line stays roughly the same length (±30%). Do not summarise. Do not pad.
✓ Output ONLY the numbered lines. NO commentary before or after. NO markdown fences.

═══════════════════════════════════════════════════════════════════════
INPUT — ${rawLines.length} LINES
═══════════════════════════════════════════════════════════════════════
${numbered}

═══════════════════════════════════════════════════════════════════════
OUTPUT — ${rawLines.length} POLISHED LINES (numbered 1 through ${rawLines.length})
═══════════════════════════════════════════════════════════════════════`;
}
