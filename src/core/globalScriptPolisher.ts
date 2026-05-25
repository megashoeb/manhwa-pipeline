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

// Gemini-native name. Works directly when the picked key is a Gemini
// key. When the picked key is OpenRouter, modelTiers.ts maps this
// name to "google/gemini-2.5-flash-lite" automatically — so the user
// gets the right model on either provider.
const DEFAULT_POLISH_MODEL = "gemini-2.5-flash-lite";

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
      // A 50-chapter assembled script can hit ~25K output tokens.
      // Default 6144 cap would truncate the response halfway through,
      // failing the line-count gate and forcing a fallback. Give
      // polish 32K so even a 80-chapter run rounds-trips cleanly.
      maxOutputTokens: 32768,
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
  "dark-gritty": `Short, punchy sentences. Visceral verbs (rips, shatters, bleeds, crumbles, splinters, snaps). Heavy on physical consequences — wounds, exhaustion, the weight of damage. Bleak, weary undertone. Show character cost: scarred knuckles, ragged breath, blood pooling.

GOOD examples:
- "Blood. Steel. Silence. He stands alone."
- "His grip slips on the hilt. Sweat or blood — he can't tell anymore."
- "The body falls. He doesn't watch it land."

AVOID:
- ✗ Heroic flourishes ("magnificent", "glorious")
- ✗ Soft poetry ("whispers of fate")
- ✗ Action-movie banter`,

  "epic-mythic": `Longer flowing prose. Elevated vocabulary (legacy, sovereign, ancient, oath, exile, banished, prophesied). Mythological register — feels like a saga being recounted. Use weight-bearing nouns over generic ones (a "kingdom" not "place", a "blade" not "weapon").

GOOD examples:
- "In an age of dying kings, one warrior remembers what others have buried."
- "Long after the last bonfire died, his name would still split the silence."
- "He carries a debt older than the empire he serves."

AVOID:
- ✗ Modern idioms ("game over", "no way")
- ✗ Profanity or vulgar slang
- ✗ Casual contractions in dramatic beats`,

  "punchy-action": `Rapid-fire pacing. Action verbs front-loaded (subject + strong verb in first 3 words). Heavy momentum, no padding. Sentences average 8-14 words. Mix short and medium — never let two long sentences run back-to-back.

GOOD examples:
- "He swings. The blade meets armor. The armor loses."
- "Jaxon drives forward, slamming his shoulder into the closing line."
- "Three soldiers charge. Three soldiers fall. He's already moving past them."

AVOID:
- ✗ Lengthy character interiority mid-fight
- ✗ Adjective stacks ("a brutal, devastating, savage strike")
- ✗ Passive voice ("was struck by")`,

  introspective: `Character POV thoughts threaded in between physical actions. Internal monologue carries motivation and stakes. Slower, reflective pace — but never sleepy. Use rhetorical fragments to mark thoughts: "Three breaths. That's all he had left." Mix action with the character's read of it.

GOOD examples:
- "He had lived this moment three times before. This time, he wouldn't lose."
- "Jaxon counted the soldiers. Eight. He'd survived worse with less."
- "A familiar burn climbed his arm. He welcomed it. Pain meant he was still here."

AVOID:
- ✗ Pure action with no inner thread
- ✗ Overlong internal speeches that stall the scene
- ✗ Telegraphing what's about to happen`,

  cinematic: `Visual scene-setting like a movie. Use light, weather, scale, and movement of perspective. Open shots wide, then push in close on what matters. Atmospheric — convey mood through environment, not just character emotion.

GOOD examples:
- "The camera pans across a battlefield drowning in mist as he rises one last time."
- "Frame holds on the empty hilt — then a slow tilt up to find his eyes."
- "Behind him, the city skyline burns orange. He doesn't turn to look."

AVOID:
- ✗ Literal "the panel shows" / "we see" meta-language
- ✗ Generic visual filler ("it was beautiful")
- ✗ Over-direction every line — pick the right moments`,
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
FORBIDDEN PHRASE RULES
═══════════════════════════════════════════════════════════════════════
✗ NEVER use "our hero", "our boy", "the heir", "the warrior", "the regressor", "the survivor", "the young mercenary", "our protagonist".
  Max 1 use TOTAL across entire script for ALL these combined.
✗ NEVER use full descriptive titles like "The Eternally Regressing Knight" more than 2-3 times in entire script. Use real name ("Jaxon") or "he" instead.
✗ NEVER use panel-description meta-language: "this chapter", "this scene", "the panel shows", "close-up of", "wide shot", "in the frame".

═══════════════════════════════════════════════════════════════════════
CHARACTER INTRODUCTION RULE
═══════════════════════════════════════════════════════════════════════
When ANY named character appears for the FIRST TIME, attach a 4-7 word context tag explaining who they are:
BAD:  "Krais raises his axe."
GOOD: "Krais, Jaxon's loyal ally, raises his axe."

If a character is unnamed in the source (described only by appearance like "blue-skinned warrior"), use a consistent role tag throughout:
"the Frog-clan champion", "the silent assassin", etc.

After first introduction, use the name or "he/she" only.

═══════════════════════════════════════════════════════════════════════
ADJECTIVE VARIETY LOCK
═══════════════════════════════════════════════════════════════════════
Across entire script, limit these phrases to MAX 2 uses each:
- "grits teeth" / "gritted teeth"
- "eyes burn/burning/blazing with defiance"
- "brutal assault" / "relentless assault"
- "pushed past limits"
- "crimson blood splatters"
- "savage strike/blow"
- "devastating blow"

Rotate vocabulary aggressively. Use specific verbs over generic intensity words. "He grits his teeth" appearing 6 times = REWRITE 4 of them.

═══════════════════════════════════════════════════════════════════════
SCENE TRANSITION SIGNPOSTS (mandatory)
═══════════════════════════════════════════════════════════════════════
On EVERY time/place jump, prepend a 3-5 word signpost so viewers never get lost:
- "Years earlier..."
- "Back in the present..."
- "Meanwhile, at the camp..."
- "Cut to the tent..."
- "Hours after the battle..."
- "Far from the battlefield..."

A flashback, dream sequence, or POV switch MUST have a marker.

═══════════════════════════════════════════════════════════════════════
NARRATOR PERSONALITY — WARM, OBSERVANT
═══════════════════════════════════════════════════════════════════════
Add ONE light observational aside every 10-12 lines. Tone: like a friend watching alongside the viewer.
Examples:
- "And this is where everything begins to shift."
- "Notice he doesn't even hesitate — that's not luck."
- "For anyone wondering why he keeps getting up — keep watching."

NEVER use sarcasm at characters. NEVER use Gen-Z memes ("sigma", "rizz", "bro", "ohio"). Keep voice timeless.

═══════════════════════════════════════════════════════════════════════
STORY-FIRST CONTEXT
═══════════════════════════════════════════════════════════════════════
Each line maps to one panel but must carry forward:
- WHO the character is (use real name, never just "the warrior")
- WHY they're acting (motivation)
- WHAT'S AT STAKE (personal — family, honor, revenge, survival)

A non-reader of the manhwa must be able to follow without confusion.
First 30 lines MUST establish: protagonist name, family situation, power system basics, current threat.

═══════════════════════════════════════════════════════════════════════
FRAGMENT-SPAM LIMIT
═══════════════════════════════════════════════════════════════════════
BAD:  "Blue mana surges. He slides. He won't stop. He grips. He prepares."
GOOD: "Blue mana surges through him as he slides across the broken concrete, refusing to slow even for a breath."

Max 1 sentence fragment per 5 consecutive lines. Use full sentences with rhythm.

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
SELF-CHECK BEFORE OUTPUT
═══════════════════════════════════════════════════════════════════════
Before submitting, verify:
☐ Output line count = input line count (${rawLines.length})
☐ Hook appears ONLY on line 1 (no repeats anywhere)
☐ "Our hero" / "our boy" used 0-1 times total
☐ "The [Long Descriptive Title]" used max 2-3 times
☐ Every named character has context tag on first mention
☐ Tense locked to present throughout
☐ No "this chapter" / "this scene" meta-language
☐ Scene transitions signposted on every jump
☐ At least 5-8 narrator asides distributed evenly
☐ "Grits teeth" / "burning defiance" max 2 uses each
☐ Output is JUST numbered lines — no commentary

═══════════════════════════════════════════════════════════════════════
INPUT — ${rawLines.length} LINES
═══════════════════════════════════════════════════════════════════════
${numbered}

═══════════════════════════════════════════════════════════════════════
OUTPUT — ${rawLines.length} POLISHED LINES (numbered 1 through ${rawLines.length})
═══════════════════════════════════════════════════════════════════════`;
}
