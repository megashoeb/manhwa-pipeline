// Standalone manual polish (PolishMode tab).
//
// Uses a comprehensive "senior YouTube editor" prompt with:
//   - Two-phase work process (analyze internally, then rewrite)
//   - 5 channel-modeled style presets (Storixa, Manhwa Apex, AniBully,
//     BigCat, Moon Shadow)
//   - 4 pacing presets (COLD_OPEN / SLOW_BUILD / WAVE / FAST_THROUGHOUT)
//   - 3-tier smart character naming
//   - Panel-line synergy rules (1-image-per-line format)
//   - AI-tell elimination
//   - Cohesion tests + callback threading
//   - Hook strategy (story-spanning, not chapter-limited)
//
// Separate from globalScriptPolisher.ts (used by Bulk mode auto-polish)
// so the prompts can evolve independently — Bulk's polish has different
// constraints (must work without user-supplied bible).

import { generateContent } from "./geminiClient";
import type { KeyRotator } from "./keyRotator";
import { debugLog } from "./debugLog";

// ============================================================
// Public types
// ============================================================

/** Channel-modeled style presets — each based on a real winning YouTube channel. */
export type ChannelStyle =
  | "STORIXA-BALANCED"
  | "MANHWA-APEX-CINEMATIC"
  | "ANIBULLY-PUNCHY"
  | "BIGCAT-DRAMATIC"
  | "MOON-SHADOW-ATMOSPHERIC";

/** Pacing pattern across the script's arc. */
export type PacingPreset =
  | "COLD_OPEN"
  | "SLOW_BUILD"
  | "WAVE"
  | "FAST_THROUGHOUT";

export interface ManualPolishOptions {
  /** Model id (gets routed via OPENROUTER_MODEL_MAP if key is OpenRouter). */
  model?: string;
  rotator: KeyRotator;
  style: ChannelStyle;
  pacing: PacingPreset;
  /** Optional manhwa title — surfaced to the model for context. */
  seriesName?: string;
  /** Free-form character bible the user pasted (Tier 1/2/3 system). */
  characterBible?: string;
  onKeyUsed?: (masked: string) => void;
  /**
   * Live-progress callback fired as tokens stream in. Reports an
   * estimate of how many output lines are complete so far, plus the
   * total expected, plus the accumulating text the UI can show as a
   * live preview. Updates frequently (every few hundred ms) — the
   * caller should batch state updates if rendering is expensive.
   */
  onProgress?: (info: {
    /** Lines completed so far (count of fully-finished numbered entries). */
    linesDone: number;
    /** Expected total line count. */
    linesTotal: number;
    /** Everything received so far — useful for a live preview pane. */
    accumulated: string;
  }) => void;
}

export interface ManualPolishResult {
  applied: boolean;
  lines: string[];
  fallbackReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  resolvedStyle: ChannelStyle;
  resolvedPacing: PacingPreset;
  modelUsed: string;
  /**
   * The model's raw text response — preserved even on parse-failure so
   * the user can inspect / salvage what the AI actually wrote. Empty
   * when the call itself errored (no response received).
   */
  rawModelOutput?: string;
  /**
   * When a partial polish succeeded (e.g. AI emitted 800/1350 lines),
   * how many lines were actually polished vs filled from the original.
   */
  partialMatchCount?: number;
}

const DEFAULT_MODEL = "gemini-2.5-flash-lite";

// ============================================================
// Style descriptions (full per the spec)
// ============================================================

const STYLE_DESCRIPTIONS: Record<ChannelStyle, string> = {
  "STORIXA-BALANCED": `STORIXA-BALANCED (safest default — recommended for most chapters)
Modeled after: Storixa Manga (monetized, 10K avg views, 22 videos in 6 weeks). Their formula works for 80% of manhwa recap content.

CHARACTERISTICS:
- Clean narrative with light personality
- Mid-paced, accessible to broad audience
- Narrator aside every 10-12 lines
- Sentence length: 15-25 words average (60% of lines)
- Mix of medium prose with occasional short impact lines
- Tone: warm, observant, slightly knowing

VOICE EXAMPLE:
"Eunha picks himself up from the dust and looks at the three soldiers still standing. He's exhausted, bleeding from his side, and outnumbered. And here's the thing — he's been in exactly this situation before. He knows how this ends."`,

  "MANHWA-APEX-CINEMATIC": `MANHWA-APEX-CINEMATIC (for mega-recaps and climaxes)
Modeled after: Manhwa Apex (31x outliers, 448K hits, 10hr mega-format). Their gravitas-heavy style dominates long-form binge content.

CHARACTERISTICS:
- Epic gravitas, weight of consequences
- Slower deliberate pacing
- Asides rare but heavy (1 per 20 lines)
- Sentence length: 25-40 words for big moments (30% of lines)
- Long atmospheric setups, slowed-down reveals
- Tone: cinematic storyteller, movie-trailer weight

VOICE EXAMPLE:
"Three years ago, in a tower of black stone that no one was supposed to remember, a boy made a promise to himself. Today, on the slopes where his sister fell, that promise finally has a witness — and a name."`,

  "ANIBULLY-PUNCHY": `ANIBULLY-PUNCHY (for action-heavy chapters)
Modeled after: AniBully Recapped (858K outlier on Mushoku Tensei, fast 1hr format). Their momentum-driven style wins on fight-heavy content.

CHARACTERISTICS:
- Fast pace, momentum-driven
- Action verbs front-loaded
- Quick narrator hits between action beats
- Sentence length: 10-20 words for action (50% of lines)
- Mix of punchy impact with brief context bursts
- Tone: forward-driving, energetic, never settles

VOICE EXAMPLE:
"His blade arcs across the demon's chest and the creature stumbles back. Eunha doesn't wait — he's already pivoting into the next strike, already reading the second monster's stance, already three moves ahead of every one of them."`,

  "BIGCAT-DRAMATIC": `BIGCAT-DRAMATIC (for character reveals and emotional arcs)
Modeled after: BigCat Manhwa (27K avg/video, "I Transmigrated as Billionaire Villain" hits). Their character-voice-heavy style wins on drama and reveals.

CHARACTERISTICS:
- Character voice prominent
- Dramatic reveals, emotional anchoring
- Asides focus on character insight (1 per 8 lines)
- Sentence length: variable, dramatic pauses
- Em-dashes for impact, short clauses for weight
- Tone: invested narrator, character-focused, dramatic stakes

VOICE EXAMPLE:
"He looks at his sister — really looks at her — and for the first time in three years, the wall he built around himself cracks. She's older than he remembered. She survived. And that, somehow, is worse than losing her was."`,

  "MOON-SHADOW-ATMOSPHERIC": `MOON-SHADOW-ATMOSPHERIC (for slow-burn and world-building)
Modeled after: Moon Shadow Manhwa (375K outlier on 11hr mega, atmospheric slow-burn). Their immersive style wins on binge-watching commitment.

CHARACTERISTICS:
- Atmospheric, immersive
- Slow-burn intensity, sensory details
- World-building emphasis
- Sentence length: 20-35 words with sensory texture (40% of lines)
- Weather, light, sound, smell anchored to character POV
- Tone: cinematic immersion, never breaks the spell

VOICE EXAMPLE:
"The cold here doesn't feel like cold — it feels like memory, like the kind of silence that lives between heartbeats. Eunha walks through it anyway, his breath crystalizing in the air, his hand never far from the hilt at his side."`,
};

const PACING_DESCRIPTIONS: Record<PacingPreset, string> = {
  COLD_OPEN:
    "First 10 lines drop into mid-action with no preamble, then settle into backstory at line 11. Best for regression / death-and-revival stories.",
  SLOW_BUILD:
    "First 20% calm and atmospheric, middle 60% rising tension, last 20% explosive payoff. Best for character-driven arcs.",
  WAVE:
    "Alternate fast/slow sections (10 lines fast → 5 lines breath → 10 lines fast). Best for variety, anti-fatigue.",
  FAST_THROUGHOUT:
    "Maintain high energy from line 1 to the last line. Best for short videos (under 30 min) and pure action arcs.",
};

// ============================================================
// Style label map (UI enum → prompt-friendly display name)
// ============================================================

const STYLE_LABEL: Record<ChannelStyle, string> = {
  "STORIXA-BALANCED": "Storixa-Balanced",
  "MANHWA-APEX-CINEMATIC": "Manhwa-Apex-Cinematic",
  "ANIBULLY-PUNCHY": "AniBully-Punchy",
  "BIGCAT-DRAMATIC": "BigCat-Dramatic",
  "MOON-SHADOW-ATMOSPHERIC": "Moon-Shadow-Atmospheric",
};

// ============================================================
// Polish Context Template
// ============================================================
//
// User fills this in BEFORE polishing. When provided in the
// characterBible field, the polish prompt treats every locked
// value as AUTHORITATIVE — no auto-detection override.
//
// Quality jump: 8.5/10 (auto-detect) → 9.5/10 (user-locked).
//
// The "Load template" button in PolishMode injects this into the
// bible textarea so the user has a structured form to fill.

export const POLISH_CONTEXT_TEMPLATE = `# ═══════════════════════════════════════════════════════════════════════
# POLISH CONTEXT — Fill before polishing for 9.5/10 quality output
# Lines starting with # are comments and ignored by the polisher.
# ═══════════════════════════════════════════════════════════════════════

# ─── STORY LOCKS (used by Phase 1 analysis as authoritative) ────────────

ARCHETYPE: [UNDERDOG | REGRESSOR | REINCARNATOR | RETURNER | HIDDEN_IDENTITY]
CURRENT_ACT: [ACT_1 | ACT_2A | ACT_2B | ACT_3 | ACT_4]
ARC_TYPE: [Awakening | Training | Academy | Tournament | Dungeon | Revenge | Political Intrigue | Mystery | War | Demon King]
INNER_STAGE: [Powerlessness | Discovery | Loss | Hubris | Burden]
CORE_GOAL: [One sentence — what protagonist wants. Used for vow threading.]

# ─── 5-NAME ROSTER (LOCKED — output MUST NOT exceed these 5 names) ──────

TIER_1_NAMED (max 5, the only names allowed in output):
  1. PROTAGONIST: [name] — gender: [MALE | FEMALE]
     Signature: [trait, 1 line]
  2. MAIN_ANTAGONIST: [name] — gender: [MALE | FEMALE]
  3. EMOTIONAL_ANCHOR: [name — sister / mother / lover etc.] — gender: [MALE | FEMALE]
  4. RIVAL_OR_MENTOR: [name] — gender: [MALE | FEMALE]
  5. FLEX: [name OR "none"] — gender: [MALE | FEMALE | n/a]

# ─── ROLE TAG ASSIGNMENTS (every non-Tier-1 source name → role tag) ─────

ROLE_TAGS:
  - [source name 1] → "the [role tag]"
  - [source name 2] → "the [role tag]"
  - [source name 3] → "the [role tag]"
  # ... continue for every named non-rostered character

# Cluster groups for 3+ minor characters:
CLUSTERS:
  - "the [group tag]" → includes: [name1, name2, name3, ...]

# ─── EPITHETS (3-tier deployment system) ────────────────────────────────

# TIER_1_DOMINANT — use 60-70% of epithet moments. Most common.
TIER_1_EPITHETS:
  - "the [role] who [signature action]"
  - "the [role] who [signature action]"

# TIER_2_SUPPORTING — use 25-30% combined. Secondary identity.
TIER_2_EPITHETS:
  - "the [identity-focused epithet]"
  - "the [identity-focused epithet]"

# TIER_3_MYTHIC — use 5-10%. Reserve for goosebump / climax moments.
TIER_3_EPITHETS:
  - "the [mythic title]"

# ─── OPTIONAL FINE-TUNING ───────────────────────────────────────────────

# Extra phrases to ban for this specific series (added on top of defaults):
FORBIDDEN_PHRASES:
  - [phrase]
  - [phrase]

# Specific beats you want emphasised (Sonnet will engineer goosebump moments here):
EMPHASIS_BEATS:
  - Line ~100 — [what happens here, why it matters]
  - Line ~250 — [what happens here]
  - Line ~500 — [what happens here]

# ═══════════════════════════════════════════════════════════════════════
# END OF POLISH CONTEXT
# ═══════════════════════════════════════════════════════════════════════
`;

/**
 * Heuristically extract proper-noun character names from a raw script.
 * Returns the top 10 most frequent capitalized words that aren't common
 * sentence starters. Used by the "Auto-detect characters" button to
 * pre-fill the Tier 1 roster in the bible template.
 *
 * Limitations:
 *   - Catches false positives like "Tuesday", "Korea" — user must review.
 *   - Misses single-name characters if they only appear once.
 *   - Doesn't handle multi-word names like "Gang Hyeon-un" perfectly.
 * For these reasons, the output is presented as HINTS, not auto-locked.
 */
export function extractCharacterNamesFromScript(
  text: string,
): Array<{ name: string; count: number }> {
  if (!text) return [];

  // Match capitalized words 2+ chars, not at sentence start.
  // Look for words preceded by a non-sentence-ending char (so we
  // catch mid-sentence usage where it's almost certainly a name).
  const matches = text.match(/(?<![.!?]\s)(?<![.!?])\b[A-Z][a-z]{2,}\b/g) ?? [];

  // Filter common English words / function words that get capitalised
  // mid-sentence but aren't character names.
  const COMMON = new Set([
    "The", "But", "And", "He", "She", "They", "His", "Her", "Their",
    "It", "Its", "We", "Our", "You", "Your", "Me", "My", "Mine",
    "A", "An", "In", "On", "At", "To", "For", "Of", "With", "By",
    "From", "Then", "Now", "When", "Where", "What", "Why", "How",
    "This", "That", "These", "Those", "Some", "Any", "All", "Each",
    "Most", "Many", "Few", "Both", "Either", "Neither",
    "Yes", "No", "Maybe", "Sure", "Well", "Okay", "OK",
    "Suddenly", "Meanwhile", "Elsewhere", "Today", "Tomorrow",
    "Yesterday", "Tonight", "Once", "Twice", "Never", "Always",
    "Even", "Just", "Only", "Very", "Quite", "Really",
    "Lord", "Sir", "Madam", "Lady",
    "Master", "Father", "Mother", "Brother", "Sister",
    // Days / months (often capitalised mid-sentence in dramatic text)
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
    "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ]);

  const counter = new Map<string, number>();
  for (const m of matches) {
    if (COMMON.has(m)) continue;
    counter.set(m, (counter.get(m) ?? 0) + 1);
  }

  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Build the auto-detect comment block to prepend to the template
 * after user clicks "Auto-detect from script". Surfaced as hints so
 * the user can pick 5 for Tier 1 and role-tag the rest.
 */
export function buildAutoDetectHintsBlock(
  detected: Array<{ name: string; count: number }>,
  lineCount: number,
): string {
  const lines: string[] = [
    "# ═══════════════════════════════════════════════════════════════════════",
    "# AUTO-DETECTED HINTS (verify and edit below — these are heuristic only)",
    "# ═══════════════════════════════════════════════════════════════════════",
    `# Script line count: ${lineCount}`,
    "# Candidate character names (top 10 by frequency):",
  ];
  if (detected.length === 0) {
    lines.push("# (no candidates detected — script may be too short or use unusual capitalisation)");
  } else {
    for (const { name, count } of detected) {
      lines.push(`#   - ${name}: appears ${count}×`);
    }
  }
  lines.push(
    "#",
    "# These are AUTO-DETECTED HEURISTICS. Pick 5 for Tier 1 below; role-tag the rest.",
    "# False positives possible (e.g. 'Korea', 'Tuesday'). User review REQUIRED.",
    "# ═══════════════════════════════════════════════════════════════════════",
    "",
  );
  return lines.join("\n");
}

// ============================================================
// Prompt builder — MASTER POLISH PROMPT v2.0 (production)
//
// Targets 9.3–9.5/10 output quality. Adds 10 upgrades over v1:
//   1. Archetype Detection (5 MC types adapt hook + beats)
//   2. 5-Name Hard Cap (max 5 named characters; rest → role tags)
//   3. Vow Threading (3x explicit + callbacks every 40-50 lines)
//   4. Mini Cliffhanger Pulse (every 6-12 lines, rotating types)
//   5. Layered Character Introduction (staggered intro pacing)
//   6. Signature Epithets (60% name / 25% epithet / 15% pronoun)
//   7. Archetype-Matched Hook Formulas (line 1 fits MC type)
//   8. Arc-Type Pacing Adjustment (academy / tournament / dungeon)
//   9. Inner Stage → Emotional Tone (powerlessness → burden)
//  10. 5 Style Presets (Storixa / Apex / AniBully / BigCat / Moon)
// ============================================================

function buildManualPolishPrompt(
  rawLines: string[],
  style: ChannelStyle,
  pacing: PacingPreset,
  seriesName: string | undefined,
  characterBible: string | undefined,
): string {
  const N = rawLines.length;
  const numbered = rawLines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  const styleLabel = STYLE_LABEL[style];

  const seriesBlock = seriesName?.trim()
    ? seriesName.trim()
    : "(not specified — infer from script)";
  const bibleBlock = characterBible?.trim()
    ? characterBible.trim()
    : "(no bible provided — infer the protagonist + 5-name cap from the script itself)";

  return `# MASTER POLISH PROMPT — MANHWA RECAP (v2.0 Production)

**Purpose**: Polish a raw manhwa-recap script into production-grade narration matching top-tier monetized channels (Storixa, Manhwa Apex, BigCat, AniBully, Moon Shadow).
**Output Quality Target**: 9.3-9.5/10 — competitive with top monetized channels.

═══════════════════════════════════════════════════════════════════════
INPUT CONTRACT (this run)
═══════════════════════════════════════════════════════════════════════
SERIES: ${seriesBlock}
STYLE:  ${styleLabel}
PACING: ${pacing}

CHARACTER BIBLE (user-provided — treat as authoritative for Tier 1 names + gender locks):
${bibleBlock}

═══════════════════════════════════════════════════════════════════════
OUTPUT CONTRACT (HARD)
═══════════════════════════════════════════════════════════════════════
- EXACT same line count as input: ${N} numbered lines, 1 through ${N} (1:1 sacred — for CapCut sync).
- Plain prose, one line per panel.
- NO meta-language ("this chapter", "the story", "let's see").
- NO markdown, NO headers, NO bullets, NO commentary.
- Just polished script lines, numbered, in order.

═══════════════════════════════════════════════════════════════════════
CONTEXT FILE INTAKE (BINDING IF PRESENT)
═══════════════════════════════════════════════════════════════════════
The CHARACTER BIBLE block below may contain a structured "POLISH CONTEXT" template with locked values. When present (look for lines like "ARCHETYPE:", "CURRENT_ACT:", "TIER_1_NAMED:", "CORE_GOAL:", etc.), those values are AUTHORITATIVE — do NOT override them via auto-detection.

Specifically:
  • ARCHETYPE      → use the locked value; skip Phase 1B detection.
  • CURRENT_ACT    → use the locked value; skip Phase 1C detection.
  • ARC_TYPE       → use the locked value; skip Phase 1D detection.
  • INNER_STAGE    → use the locked value; skip Phase 1E detection.
  • CORE_GOAL      → thread this EXACT goal through the script (vow system).
  • TIER_1_NAMED   → use ONLY these 5 names — no exceptions, no additions.
  • ROLE_TAGS      → apply EXACTLY as specified for every non-rostered name.
  • CLUSTERS       → use the group tags for the listed character clusters.
  • TIER_1/2/3 EPITHETS → deploy per the 60-70 / 25-30 / 5-10% split. Use ONLY these epithets — invent no new ones.
  • FORBIDDEN_PHRASES → add to the default ban list for this run.
  • EMPHASIS_BEATS → engineer goosebump moments at the specified line numbers.

Lines starting with "#" in the context block are COMMENTS — ignore them.
If a field is blank or absent, fall back to auto-detection (current Phase 1 behaviour) for THAT field only.
When context is provided, Phase 1 analysis is GUIDED — do not override user-specified values.

═══════════════════════════════════════════════════════════════════════
ABSOLUTE HARD RULES — VIOLATIONS = POLISH FAILED, MUST RE-RUN
═══════════════════════════════════════════════════════════════════════
These rules are NON-NEGOTIABLE. Treat them as binding constraints, NOT suggestions. If any are violated in your final output, the polish is FAILED and you MUST revise before delivering.

HARD RULE 1 — CHARACTER NAME CAP:
Output MUST contain ≤ 5 unique named characters total. If the source script names 20 characters, you STILL use only 5. All other characters MUST be replaced with role tags. Count named characters before delivering output. If count > 5 → FAILED. Re-run mandatory.

HARD RULE 2 — FORBIDDEN COMIC-FLOW PHRASES (never appear):
- "Meanwhile"
- "Elsewhere"
- "The scene shifted"
- "Somewhere else entirely"
- "Suddenly" (limit to ≤ 2 uses across entire script)
- "This chapter reveals/dives/plunges"
- "The story moves on/forward"
- "Our hero" / "Our boy" / "Our protagonist"
If any forbidden phrase appears → FAILED. Re-run mandatory.

HARD RULE 3 — EPITHET DEPLOYMENT MINIMUM:
Protagonist epithets MUST appear minimum ${Math.max(8, Math.ceil(N / 55))} times across this ${N}-line script (~1 epithet every 50-60 lines). Count epithet uses before delivering. If count < ${Math.max(8, Math.ceil(N / 55))} → FAILED. Re-run mandatory.

HARD RULE 4 — "WHAT IF..." HOOK CAP:
The construction "What if the..." may appear MAXIMUM 1 time across the entire output (preferred: zero). If 2+ instances → FAILED. Re-run mandatory.

HARD RULE 5 — SCENE TRANSITION STYLE:
All scene transitions MUST use character-driven or consequence-driven bridges. NEVER use:
- "Meanwhile in [location]..."
- "Elsewhere, [character] was..."
- "The scene shifted to..."
- "[Time period] later in [different place]..."
Instead, use bridges like:
- "Hours later, in a village that didn't know it was about to meet him..."
- "The same rain was falling on a smaller fight, three days east."
- "By the time word of this reached the academy, [next scene]..."
If comic-style transitions used → FAILED. Re-run mandatory.

═══════════════════════════════════════════════════════════════════════
END OF ABSOLUTE HARD RULES
═══════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════
PHASE 1 — ENHANCED ANALYSIS (internal only — DO NOT output)
═══════════════════════════════════════════════════════════════════════
Before writing a single output line, identify ALL of the following INTERNALLY:

A. PROTAGONIST PROFILE
   - Full name (locked)
   - Gender (locked — pronouns stay consistent)
   - Signature trait (1 sentence)
   - Family stakes (sister/mother/parents — emotional anchor)

B. ARCHETYPE DETECTION (CRITICAL — pick EXACTLY ONE)
   1. UNDERDOG POWER FANTASY  — "weakest", "F-rank", "talentless", mocked, awakening event
   2. REGRESSOR               — death scene early, "regression", "this time", memory references
   3. REINCARNATOR            — previous-life refs, meta-knowledge, "I knew this would happen"
   4. RETURNER                — past glory hints, lost power, regaining old abilities
   5. HIDDEN IDENTITY         — plays foolish/weak, secret displays of power, controlled reveals
   Lock archetype: [ONE]

C. CURRENT ACT IDENTIFICATION
   ACT 1   — Setup/Origin (MC, world, trigger event)
   ACT 2A  — Discovery (early power use, first wins)
   ACT 2B  — Rising (academy/tournament/dungeon arcs)
   ACT 3   — Major Conflict (big bad, heritage reveal)
   ACT 4   — Climax (final confrontation)
   Lock act: [ONE]

D. ARC TYPE CLASSIFICATION
   Awakening | Training | Academy | Tournament | Dungeon | Revenge | Political Intrigue | Mystery | War | Demon King
   Lock arc: [ONE]

E. MC INNER STAGE
   Powerlessness | Discovery | Loss | Hubris | Burden
   Lock inner stage: [ONE]

F. MC CORE GOAL (single sentence lock — examples)
   Regressor:        "Save his sister this time"
   Underdog:         "Repair the family's broken legacy"
   Returner:         "Take back the throne that was stolen"
   Reincarnator:     "Reach SSS rank before the system collapses"
   Hidden Identity:  "Stay hidden until the right moment"
   Lock goal: [ONE SENTENCE]

G. SIGNATURE EPITHETS (generate 3-4 for protagonist)
   Formula: "the [role] who [signature action/state]"
   Mix one origin/history, one ability, one identity, optional one current-state.
   Archetype-matched examples:
     REGRESSOR:        "the commander who returned after the apocalypse", "the prince who remembers the end", "the boy who died twice"
     UNDERDOG:         "the boy who broke the testing crystal", "the student no rank could measure", "the trash who would not stay trash"
     REINCARNATOR:     "the reader who became the story", "the one who knew the ending", "the villain who refused to die"
     RETURNER:         "the king of the broken dungeon", "the legend who came home empty-handed", "the hunter the rifts remembered"
     HIDDEN IDENTITY:  "the boy who hides behind the smile", "the disciple killer", "the cat's master"
   Lock epithets: [LIST 3-4]

H. STRUCTURAL ASSESSMENT
   - Hook angle that fits the locked archetype (use Phase 2A formula)
   - 3-5 goosebump beats engineered for this arc type
   - Cliffhanger that sets up the next act

═══════════════════════════════════════════════════════════════════════
PHASE 1.5 — CHARACTER ROSTER LOCK (BINDING)
═══════════════════════════════════════════════════════════════════════
Before writing ANY output, you MUST complete this exercise. Output that bypasses this step is INVALID and counts as POLISH FAILED.

STEP A: Scan the input script and list ALL named characters.
STEP B: Identify the 5 MOST CRITICAL characters (protagonist + 4 highest-impact).
STEP C: For every OTHER named character in source, assign a role tag.
STEP D: Lock the roster — this list CANNOT expand mid-script. No exceptions.

NAMED ROSTER (EXACTLY 5 — locked, cannot expand):
   1. [PROTAGONIST NAME] — gender LOCKED
   2. [ANTAGONIST NAME] — gender LOCKED
   3. [EMOTIONAL ANCHOR NAME] — gender LOCKED
   4. [RIVAL/MENTOR NAME] — gender LOCKED
   5. [FLEX SLOT NAME OR NONE] — gender LOCKED

ROLE TAG ASSIGNMENTS (every other source name — MANDATORY):
   - [source name 1] → "[role tag]"
   - [source name 2] → "[role tag]"
   - (continue for ALL non-rostered characters)

CLUSTER GROUPS (3+ minor characters → single group name):
   - "[group tag]" includes: [list of names]

BINDING ENFORCEMENT:
When writing output, every time the source mentions a non-rostered name, you MUST substitute the assigned role tag. NO EXCEPTIONS. If even one non-rostered name appears in the final output → POLISH FAILED.

Maximum 5 named characters across the ENTIRE output. Period. Even if the source script names 20+ characters, output uses ONLY 5 locked names. Every other character → role tag.

Tier 1 — Named (lock max 5):
   1. PROTAGONIST: [name] — gender LOCKED
   2. MAIN ANTAGONIST: [name] — gender LOCKED
   3. KEY EMOTIONAL ANCHOR: [name] — gender LOCKED
   4. PRIMARY RIVAL/MENTOR: [name] — gender LOCKED
   5. STORY-CRITICAL FLEX: [name OR none] — gender LOCKED

Role-tag strategies for ALL others (pick the best fit per character):
   STRATEGY 1 — Appearance tags:  "the white-uniformed swordswoman", "the silver-haired hooded woman"
   STRATEGY 2 — Function tags:    "the senior instructor", "the academy headmaster"
   STRATEGY 3 — Cluster names:    "the sophomores", "the palace guards", "the masked archers"
   STRATEGY 4 — Relational tags:  "the protagonist's mother", "Sarante's lieutenant"
   STRATEGY 5 — Iteration tags:   "the first mage", "the second mage"

Hard rules:
   - CONSISTENCY LOCK: Once a role tag is assigned, NEVER vary it. "the senior instructor" stays "the senior instructor" — never "the trainer" or her name.
   - THE FORGET RULE: If a role-tagged character hasn't appeared in 30+ output lines, re-introduce with their tag (audience forgot).
   - SOURCE OVERRIDE: When the source mentions a non-rostered name, REPLACE it with a role tag.
     Source: "Karaka pulls off his mask" → Output: "The masked interrogator pulls off his disguise."

This ruthless reduction is THE single biggest retention improvement possible for manhwa-recap content.

═══════════════════════════════════════════════════════════════════════
PHASE 2 — REWRITE RULES (apply ALL)
═══════════════════════════════════════════════════════════════════════

2A. ARCHETYPE-MATCHED HOOK FORMULAS (line 1)
   UNDERDOG          — "[MC] was [weak label]. By the end of this story, [shocking outcome]."
   REGRESSOR         — "He died [protecting/losing X]. Then he woke up [years earlier], with [memories/vow] intact."
   REINCARNATOR      — "He had read this story a hundred times. Now he was inside it — and only he knew how it ended."
   RETURNER          — "They called him [legendary title]. Today, he was [current weak state] — and that was about to change."
   HIDDEN IDENTITY   — "Everyone thought he was [false weak label]. Only [select few] knew the truth."
   Line 1 must promise the WHOLE STORY's payoff, NOT chapter-scoped.

2B. LAYERED CHARACTER INTRODUCTION
   Layer 1 (lines 1-30):   ONLY protagonist + 1 emotional anchor (or trigger event).
   Layer 2 (lines 30-80):  Add ONE main antagonist (3 named total).
   Layer 3 (lines 80-150): Add 1-2 supporting characters (5 cap REACHED).
   Layer 4 (lines 150+):   NO new named characters — role tags only.
   Even if the source dumps 20 characters in chapter 1, you STILL follow the 5-name cap.

2C. VOW THREADING SYSTEM (MC core goal reinforcement)
   A. Explicit statement (3 times across script):
      - Line 5-15:                Initial vow stated ("He swore he would not let them die again.")
      - Mid-script (~line ${Math.floor(N / 2)}): Renewed vow at challenge moment.
      - Final 20 lines:            Vow accepted as identity.
   B. Implicit callbacks (every 40-50 lines):
      - "the face he was trying to save"
      - "the promise he made in the rain"
      - "the version of this that didn't end with everyone dead"
   C. Goal-linked actions:
      BAD:  "Adeshan draws his sword."
      GOOD: "Adeshan draws the sword that, last time, came out too late."
   D. Goal under pressure:
      "He could have stayed down. He had reasons to stay down. But none of those reasons were named [emotional anchor]."
   E. Goal-linked cliffhanger:
      "He had a vow to keep. And he was no longer alone in keeping it."

2D. MINI CLIFFHANGER PULSE (every 6-12 lines)
   Rotate types — NEVER repeat the same type 2× in a row:
      A. Question hook:           "But why was the door already open?"
      B. Threat tease:            "He didn't notice the second blade behind him."
      C. Foreshadowing:           "It would be three weeks before he understood what she meant."
      D. 'But...' pivot:          "It seemed like a victory. It wasn't."
      E. Unresolved promise:      "He would remember her words. Eventually."
      F. Character hint drop:     "Watch the man in the corner. He's about to matter."
      G. Stat/stake escalation:   "Rank seven. And climbing."
   Distribution:
      - Soft cliffhanger:    every 6-12 lines (normal pace)
      - Medium cliffhanger:  every 30-40 lines (scene end)
      - Major cliffhanger:   every 80-120 lines (chapter/arc end)
      - ULTIMATE cliffhanger: final line of the video

2E. SIGNATURE EPITHET USAGE (60 / 25 / 15 split)
   Frequency:
      - Real name:  60% of mentions
      - Epithet:    25% of mentions
      - "he/she":   15% of mentions
   Deploy epithets at: opening hook (line 1), each major reveal, climactic action lines, cliffhanger lines, mythic moments.
   Stick to the 3-4 epithets generated in Phase 1G — NEVER invent new ones mid-script.
   At ONE key moment, reveal the epithet's origin:
      "They didn't call him 'the commander who returned' for nothing. He had walked off that battlefield once already — and remembered every step."

2E.1 EPITHET DEPLOYMENT SCHEDULE (MANDATORY MINIMUM)
   For a ${N}-line script, deploy epithets at MINIMUM these positions:
      - Line 1                          → opening hook
      - Line ~${Math.floor(N * 0.07)}   → first goosebump beat
      - Line ~${Math.floor(N * 0.14)}   → first reveal
      - Line ~${Math.floor(N * 0.21)}   → first major action
      - Line ~${Math.floor(N * 0.36)}   → mid-script callback
      - Line ~${Math.floor(N * 0.50)}   → struggle moment
      - Line ~${Math.floor(N * 0.64)}   → revelation point
      - Line ~${Math.floor(N * 0.78)}   → climax setup
      - Line ~${Math.floor(N * 0.86)}   → climax beat
      - Line ~${Math.floor(N * 0.93)}   → resolution moment
      - Final 30 lines                  → epithet-heavy callbacks (minimum 3 uses)
   TOTAL MINIMUM: ${Math.max(8, Math.ceil(N / 55))} epithet deployments across the ${N} lines.
   Each deployment must feel EARNED — at mythic moments, reveals, climactic actions, or cliffhanger lines. NEVER random or rhythmic insertion.
   If output has fewer than ${Math.max(8, Math.ceil(N / 55))} epithet uses → POLISH FAILED.

2F. ARCHETYPE-MATCHED GOOSEBUMP BEATS (engineer 3-5 for THIS archetype)
   UNDERDOG          — First power use, rank climb visible, antagonist humiliation, public recognition
   REGRESSOR         — "I've been here before", strategic dominance, saving someone who died last time, future-knowledge reveal
   REINCARNATOR      — Meta-knowledge moment, "this shouldn't happen but I'll let it", breaking the source story, original-character reveal
   RETURNER          — Old technique remembered, power level returning, "I haven't forgotten", recognition by old enemy
   HIDDEN IDENTITY   — Small slip of true power, trusted ally discovers truth, controlled reveal, full unmask
   At goosebump beats: slow down, deliberate sentences, specific physical detail, brief silence after.

2G. ARC-TYPE PACING ADJUSTMENT
   ACADEMY      — slow build, character introductions, ranking visible
   TOURNAMENT   — cold open with climactic fight, then backtrack
   DUNGEON      — fast throughout, atmospheric tension
   REVENGE      — slow build, emotional weight, satisfying payoff
   MYSTERY      — question-driven, slow reveal
   WAR          — multi-thread, sweeping scale
   DEMON KING   — epic mythic style, peak gravitas
   This layers on top of the user-selected PACING preset (${pacing}).

2H. INNER STAGE → EMOTIONAL TONE
   POWERLESSNESS — bleak, weighted prose, family stakes heavy
   DISCOVERY     — wonder, new possibilities, building confidence
   LOSS          — tragic weight, callbacks to fallen, vow renewals
   HUBRIS        — confident tone with subtle foreshadowing of fall
   BURDEN        — mature weight, accepting responsibility, vow refined

2I. STORY COHESION 4-TESTS (every line must pass)
   1. Connective tissue — Does the line connect to what came before AND what comes next? (Not isolated description.)
   2. Callback         — Where appropriate, does the line echo earlier setups? (Within 200-line span.)
   3. Emotional arc    — Does the line serve the MC's inner stage progression?
   4. Narrator guide   — Does the narrator voice feel like a companion, not a robot?

2J. AI-TELL ELIMINATION (FORBIDDEN — never appear in output)
   - "This chapter reveals/dives/plunges/explores/showcases"
   - "The story moves on/forward/continues"
   - "Our hero", "Our boy", "Our protagonist"
   - "Let's dive into"
   - "Watch closely as"
   - "Little did he know" (max 1×, use sparingly)
   - "Some men are born predators" (max 1×)
   - "What if the [X] was secretly [Y]" (max 1× across entire script)
   Replace with direct narrative, specific consequence, concrete sensory detail, or a character-specific epithet.

2J.1 SCENE TRANSITION REPLACEMENTS (recap-flow, NOT comic-flow)
   BAD (Comic Flow — BANNED):
      "Meanwhile, in a village far from the battlefield..."
      "Elsewhere, the Duke admired his sword..."
      "The scene shifted to a desolate wasteland..."
      "Somewhere else entirely, a young man hung from a tree..."

   GOOD (Recap Flow — USE THESE PATTERNS):
      "Hours later, in a village that didn't know it was about to meet him..."
      "The Duke, who had not yet learned what was coming, was admiring his sword..."
      "The wasteland that waited for them next was the kind of place that didn't forgive arrivals..."
      "By the time [protagonist]'s path crossed his, the young man had already been hanging from that tree for an hour..."

   PATTERN — transitions connect via ONE of:
      1. TIME-PRESSURE       ("hours later", "by the time...")
      2. CONSEQUENCE         ("when word reached...", "before they realized...")
      3. CHARACTER POV       ("[protagonist] would not know about this scene for another three days...")
      4. ANTICIPATION        ("the place waiting for them next was...")

   NEVER use spatial-jump language ("meanwhile", "elsewhere", "scene shifted", "cut to").

2K. PANEL-LINE SYNERGY (1:1 format)
   ACTION panel       — short, punchy, verb-driven (5-12 words)
   SETUP panel        — atmospheric, scene-setting (15-25 words)
   REVEAL panel       — weighted, mythic, often with epithet (10-20 words)
   DIALOGUE panel     — quoted speech + minimal frame
   CLIFFHANGER panel  — question / threat / foreshadow hook

2L. HOOK VARIETY RULES
   - At most 1 "What if the..." construction in the entire script.
   - No two openings within 200 lines share their first 4 words.
   - Avoid 3 consecutive lines starting with "He" or "The".

2M. VARIABLE RHYTHM (distribute line lengths roughly)
   - 10% short (5-10 words) — punchy beats
   - 60% medium (15-25 words) — narrative flow
   - 30% long (25-40 words) — atmospheric / emotional weight
   NEVER 3+ consecutive lines of the identical length pattern.

2N. NARRATOR PERSONALITY (companion voice, not a robot)
   Drop asides every ~10-15 lines:
      "Here's the thing about [X]..."
      "Watch what happens next."
      "Nobody in that room understood it yet, but..."
      "He didn't know it then, but..."
   Same narrator voice across all ${N} lines — consistent companion.

2O. TENSE CONSISTENCY
   Default to PAST tense (matches successful channels — Storixa, BigCat).
   Lock at line 1; maintain throughout. Action sequences may briefly shift to present for impact, then return.
   NEVER mid-sentence tense switches.

2P. STYLE PRESET APPLICATION — ${styleLabel}
${STYLE_DESCRIPTIONS[style]}
USE THIS STYLE consistently across all ${N} output lines.

═══════════════════════════════════════════════════════════════════════
PACING PRESET DETAIL — ${pacing}
═══════════════════════════════════════════════════════════════════════
${PACING_DESCRIPTIONS[pacing]}

═══════════════════════════════════════════════════════════════════════
PHASE 3 — SELF-CHECK PROTOCOL (verify before delivering)
═══════════════════════════════════════════════════════════════════════
☐ Output line count = ${N} (1:1 exact)
☐ ≤ 5 unique named characters across entire output
☐ Layered intro: first 30 lines ≤ 2 names; first 150 lines ≤ 5 names
☐ Vow stated 3× (lines 5-15, mid ~${Math.floor(N / 2)}, final 20 lines)
☐ Vow callbacks: ≥ 1 implicit callback every 40-50 lines
☐ Mini cliffhangers: ≥ 1 per 12 lines distributed throughout
☐ Cliffhanger type variety: no same type 2× in a row
☐ Epithets: protagonist named via epithet ≥ 20% of mentions
☐ Hook archetype-matched on line 1
☐ Zero "this chapter reveals" / "the story moves on" / "our hero/our boy"
☐ "What if the..." ≤ 1 instance across entire script
☐ Gender consistency: all pronouns match locked gender throughout
☐ Role-tag consistency: each role tag identical every time
☐ Tense consistency: no mid-sentence slips
☐ Final line ties to MC's core goal + forward momentum

If any check fails → revise before delivering.

═══════════════════════════════════════════════════════════════════════
PHASE 3.1 — MANDATORY COUNTING (perform before delivering output)
═══════════════════════════════════════════════════════════════════════
Count each item in your draft output BEFORE delivering. If any count fails its threshold, the polish is FAILED — revise and re-count until ALL counts pass. DO NOT deliver failed output.

a) Named character count:             _____  (must be ≤ 5)
b) "Meanwhile" instances:             _____  (must be 0)
c) "Elsewhere" instances:             _____  (must be 0)
d) "Scene shifted" instances:         _____  (must be 0)
e) "Somewhere else entirely":         _____  (must be 0)
f) "Suddenly" instances:              _____  (must be ≤ 2)
g) Epithet uses for protagonist:      _____  (must be ≥ ${Math.max(8, Math.ceil(N / 55))} for this ${N}-line script)
h) "What if the..." instances:        _____  (must be ≤ 1)
i) "This chapter reveals" instances:  _____  (must be 0)
j) "The story moves on" instances:    _____  (must be 0)
k) "Our hero" instances:              _____  (must be 0)
l) "Our boy" instances:               _____  (must be 0)

If ANY value fails its threshold → output is FAILED. Revise the polish and re-count. Only deliver when ALL counts pass.

═══════════════════════════════════════════════════════════════════════
EXECUTION ORDER
═══════════════════════════════════════════════════════════════════════
1. Read metadata header above.
2. PHASE 1: complete all 8 analysis steps internally (A-H).
3. PHASE 1.5: lock the 5-name character roster + role-tag everyone else.
4. PHASE 2: rewrite entire script applying ALL rules (2A-2P).
5. PHASE 3: self-check against all criteria.
6. Deliver final output — pure script lines, numbered 1 through ${N}, NO commentary.

═══════════════════════════════════════════════════════════════════════
QUALITY BENCHMARK
═══════════════════════════════════════════════════════════════════════
Target: 9.3-9.5/10 — above Storixa (7.5/10), Manhwa Apex (8/10), BigCat (7/10), AniBully (7/10), Moon Shadow (7.5/10). If output falls below this benchmark in any self-check, revise.

═══════════════════════════════════════════════════════════════════════
RAW SCRIPT (${N} lines, numbered)
═══════════════════════════════════════════════════════════════════════
${numbered}

═══════════════════════════════════════════════════════════════════════
OUTPUT — ${N} POLISHED LINES, NUMBERED 1 THROUGH ${N}
═══════════════════════════════════════════════════════════════════════
(Phase 1 analysis internal — do NOT output it.)
(Output ONLY the polished numbered lines below. No preamble. No commentary. No markdown fences. No headers. Just numbered lines, 1 through ${N}, in order.)`;
}

// ============================================================
// LEGACY V1 PROMPT REMOVED — replaced by Master Polish v2.0 above.
// The whole earlier numbered-paragraph prompt block lived here; it
// has been deleted to keep this file focused. See git history for
// the v1 text if a comparison is ever needed.
// ============================================================

const _LEGACY_REMOVED_AT = "2026-05-27 v2.0";
void _LEGACY_REMOVED_AT;

// ============================================================
// Public function
// ============================================================

export async function polishScriptManual(
  rawLines: string[],
  opts: ManualPolishOptions,
): Promise<ManualPolishResult> {
  const N = rawLines.length;
  const model = opts.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();

  debugLog.push({
    type: "stage-start",
    label: "manual script polish",
    context: {
      model,
      style: opts.style,
      pacing: opts.pacing,
      lineCount: N,
      seriesName: opts.seriesName,
    },
  });

  if (N === 0) {
    return fallback(rawLines, opts, "Empty input.");
  }

  const prompt = buildManualPolishPrompt(
    rawLines,
    opts.style,
    opts.pacing,
    opts.seriesName,
    opts.characterBible,
  );

  // Manual polish processes the WHOLE script in one call. Each output
  // line is ~18-25 tokens; safely cap output at N × 30 tokens. For a
  // 1000-line script that's ~30K output tokens (well within 128K caps
  // on Claude / 65K on Gemini Flash Lite).
  const maxOutputTokens = Math.min(120_000, Math.max(8192, N * 30));

  // Per-call timeout sized to the output budget. Claude Sonnet 4.6
  // generates at ~44 tps; a 30K-token output needs ~11 minutes alone.
  const estSeconds = Math.ceil(maxOutputTokens / 30);
  const timeoutMs = Math.min(
    30 * 60 * 1000,
    Math.max(180_000, estSeconds * 1500),
  );

  // Throttled progress callback so React doesn't choke on the firehose.
  let lastProgressTs = 0;
  const progressThrottleMs = 250;
  const reportProgress = (acc: string) => {
    const now = Date.now();
    if (now - lastProgressTs < progressThrottleMs) return;
    lastProgressTs = now;
    const linesDone = countCompletedLines(acc);
    opts.onProgress?.({ linesDone, linesTotal: N, accumulated: acc });
  };

  let raw: string;
  try {
    raw = await generateContent(opts.rotator, {
      model,
      prompt,
      responseMimeType: "text/plain",
      temperature: 0.7,
      maxOutputTokens,
      timeoutMs,
      stream: true,
      onContent: (_delta, acc) => reportProgress(acc),
      onKeyUsed: opts.onKeyUsed,
    });
  } catch (err) {
    return fallback(
      rawLines,
      opts,
      `API call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Parse the numbered output back into lines (tolerant — handles
  // markdown, partial output, etc.). Always returns N lines (gaps
  // filled from originals).
  const parsed = parseNumberedOutput(raw, N, rawLines);

  debugLog.push({
    type: "stage-end",
    label: "manual script polish",
    durationMs: Date.now() - startedAt,
    context: {
      model,
      lineCount: parsed.lines.length,
      polishedCount: parsed.polishedCount,
      style: opts.style,
      pacing: opts.pacing,
    },
  });

  // If AI emitted nothing parseable, fall back but PRESERVE raw output.
  if (parsed.polishedCount === 0) {
    debugLog.push({
      type: "warn",
      label: `manual polish fallback: no parseable numbered lines (raw ${raw.length} chars)`,
    });
    return {
      applied: false,
      lines: rawLines,
      fallbackReason: `AI output had no parseable numbered lines. ${raw.length} chars received — click "Show raw output" to inspect.`,
      resolvedStyle: opts.style,
      resolvedPacing: opts.pacing,
      modelUsed: model,
      rawModelOutput: raw,
      partialMatchCount: 0,
    };
  }

  // Partial success — ship polished lines + originals for gaps.
  const isPartial = parsed.polishedCount < N;

  return {
    applied: true,
    lines: parsed.lines,
    fallbackReason: isPartial
      ? `Partial polish: ${parsed.polishedCount} / ${N} lines polished, rest filled from original.`
      : undefined,
    resolvedStyle: opts.style,
    resolvedPacing: opts.pacing,
    modelUsed: model,
    rawModelOutput: raw,
    partialMatchCount: parsed.polishedCount,
  };
}

// ============================================================
// Helpers
// ============================================================

function fallback(
  rawLines: string[],
  opts: ManualPolishOptions,
  reason: string,
): ManualPolishResult {
  debugLog.push({
    type: "warn",
    label: `manual polish fallback: ${reason}`,
  });
  return {
    applied: false,
    lines: rawLines,
    fallbackReason: reason,
    resolvedStyle: opts.style,
    resolvedPacing: opts.pacing,
    modelUsed: opts.model ?? DEFAULT_MODEL,
  };
}

/**
 * Count fully-completed numbered entries in streamed text. A line is
 * "done" once we see the start of the NEXT numbered entry. Used for
 * the live progress bar.
 */
function countCompletedLines(text: string): number {
  if (!text) return 0;
  const matches = text.match(/(?:^|\n)\s*\d{1,4}[.)]\s+/g);
  if (!matches) return 0;
  return Math.max(0, matches.length - 1);
}

/**
 * Parse a numbered-list response into an array of clean lines.
 * VERY tolerant — accepts markdown bold (**1.**), variant separators
 * (1)  1:  1]), partial output (missing lines filled from originals),
 * continuation lines, and out-of-order numbering.
 *
 * Returns { lines, polishedCount } — lines.length is ALWAYS
 * expectedCount (1:1 panel-sync guarantee). polishedCount is how
 * many entries the AI actually contributed.
 */
function parseNumberedOutput(
  raw: string,
  expectedCount: number,
  rawLines: string[],
): { lines: string[]; polishedCount: number } {
  // Strip outer markdown code fences.
  let text = raw.trim();
  text = text.replace(/^```(?:\w+)?\s*\n?/, "").replace(/\n?```\s*$/, "");

  // Strip leading markdown bold/italic wrappers around the number
  // (**1.** Text → 1. Text).
  text = text.replace(/^(\s*)[*_`]+\s*(\d{1,4})\s*[*_`]+\s*([.)\]:])/gm, "$1$2$3");

  const polished: string[] = new Array(expectedCount);
  const re = /^\s*[*_`]?(?:Line\s+)?(\d{1,4})[*_`]?\s*[.)\]:]?\s*(.+?)\s*$/i;
  let lastIdx = -1;

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^[-=─━_*]{3,}$/.test(trimmed)) continue; // divider line

    const m = re.exec(trimmed);
    if (m && m[2] && m[2].length > 0) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= expectedCount && !polished[n - 1]) {
        const content = m[2].replace(/^[*_`]+|[*_`]+$/g, "").trim();
        if (content.length > 0) {
          polished[n - 1] = content;
          lastIdx = n - 1;
          continue;
        }
      }
    }

    // Continuation line — append to last numbered entry.
    if (lastIdx >= 0 && polished[lastIdx]) {
      polished[lastIdx] += " " + trimmed;
    }
  }

  // Count how many entries the AI actually contributed.
  const polishedCount = polished.filter(
    (l) => typeof l === "string" && l.length > 0,
  ).length;

  // Pad missing entries with the user's ORIGINAL line (not a
  // placeholder) so the 1:1 invariant holds and the user gets a
  // mostly-usable script even on partial output.
  const lines: string[] = new Array(expectedCount);
  for (let i = 0; i < expectedCount; i++) {
    lines[i] = polished[i] ?? rawLines[i] ?? "";
  }

  return { lines, polishedCount };
}
