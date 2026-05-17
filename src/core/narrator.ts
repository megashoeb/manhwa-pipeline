// Stage 4c — per-scene narration.
//
// Sends one scene's worth of panels (typically 4–8 images) to Gemini
// with the character bible threaded in for name continuity. Asks for
// EXACTLY N sentences so the 1:1 panel↔line invariant the SRT step
// depends on is preserved.
//
// Same prompt that produced competitor-quality output in the Python
// mini-test on the user's actual chapter.

import type { CharacterBible, FilteredPage } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";
import { generateContent } from "./geminiClient";

export interface NarrateOptions {
  model: string;
  rotator: KeyRotator;
  bible: CharacterBible;
  /** Short context recap of the previous scene (1–2 sentences). */
  prevSceneSummary?: string;
  /**
   * Long-form recap mode (default ``false``). When ``true`` the
   * narrator targets MUCH shorter paragraphs — 2 sentences, 30-45
   * words — instead of the standard 3-5 sentences / 60-100 words.
   * Used when a single video covers 70-80 chapters and each chapter
   * only gets ~2 minutes of screen time. Skips the 60/25/15 rhythm
   * rule entirely (every paragraph is punchy in this mode).
   */
  longFormRecap?: boolean;
  onKeyUsed?: (masked: string) => void;
}

/**
 * Narrate one scene's panels.
 *
 * Returns exactly ``scenePanels.length`` strings, one per panel, in
 * input order. If Gemini's output count doesn't match (rare with the
 * tight prompt), the caller is responsible for retrying — we surface
 * the mismatch so it's debuggable rather than silently truncating.
 */
export async function narrateScene(
  scenePanels: FilteredPage[],
  {
    model,
    rotator,
    bible,
    prevSceneSummary,
    longFormRecap,
    onKeyUsed,
  }: NarrateOptions,
): Promise<string[]> {
  if (scenePanels.length === 0) return [];

  const prompt = buildPrompt(
    scenePanels.length,
    bible,
    prevSceneSummary ?? "",
    longFormRecap ?? false,
  );

  const raw = await generateContent(rotator, {
    model,
    prompt,
    images: scenePanels.map((p) => p.blob),
    temperature: 0.85,
    topP: 0.95,
    onKeyUsed,
  });

  return parseNumberedLines(raw);
}

// ---- prompt construction ------------------------------------------

/** Paragraph-rhythm budget for an N-panel scene. */
function paragraphRhythm(n: number): {
  standard: number;
  punchy: number;
  deep: number;
} {
  if (n <= 2) return { standard: n, punchy: 0, deep: 0 };
  if (n === 3) return { standard: 2, punchy: 1, deep: 0 };
  // 60 / 25 / 15 split — more punchy beats for pacing variety, with
  // safety floors so every non-trivial scene gets at least one of each.
  const punchy = Math.max(1, Math.round(n * 0.25));
  const deep = Math.max(1, Math.round(n * 0.15));
  // Standard fills the rest. Math.max guards rounding edge cases.
  const standard = Math.max(1, n - punchy - deep);
  return { standard, punchy, deep };
}

function buildPrompt(
  n: number,
  bible: CharacterBible,
  prevSummary: string,
  longFormRecap: boolean,
): string {
  const charBlock =
    Object.entries(bible.characters)
      .map(([name, desc]) => `- ${name}: ${desc}`)
      .join("\n") ||
    "(no named characters yet — describe by appearance)";

  // Long-form mode uses a totally different prompt — tight uniform
  // paragraphs (~40 words each) so 80 chapters compress into a
  // 2.5-hour video. The standard prompt below assumes 1 chapter per
  // video with depth and rhythm variety.
  if (longFormRecap) {
    return buildLongFormPrompt(n, charBlock, bible, prevSummary);
  }

  const rhythm = paragraphRhythm(n);
  // At most one in every three paragraphs may BEGIN with a connector.
  const connectorMax = Math.max(1, Math.floor(n / 3));

  return `You are a TOP-TIER YouTube manhwa recap narrator in the style of "Manhwa Fresh" / "Gave" / "Yom Recaps".

CHARACTERS in this story (use these exact names — never "the hero" or "the warrior" when a name is known):
${charBlock}

SETTING: ${bible.setting || "(unspecified)"}
PREMISE: ${bible.premise || "(opening)"}

PREVIOUS NARRATION (the script so far — DO NOT repeat any phrasing, verbs, character descriptors, or sentence-opener patterns you see here):
${prevSummary || "(this is the opening scene of the chapter)"}

═══════════════════════════════════════════════════════════════════════
OUTPUT FORMAT — PER PANEL
═══════════════════════════════════════════════════════════════════════
Each panel = ONE story-beat paragraph, 3–5 sentences, 60–100 words.

═══════════════════════════════════════════════════════════════════════
CRITICAL ANTI-REPETITION RULES (read carefully — your last script
violated these and the audience noticed)
═══════════════════════════════════════════════════════════════════════

1. CONNECTING-PHRASE BUDGET (the most important rule)

   Connecting phrases include: "It turns out", "By now", "Suddenly",
   "Apparently", "Eventually", "Just then", "Meanwhile", "Deep down".

   • For these ${n} paragraphs, AT MOST ${connectorMax} may BEGIN
     with a connecting phrase. The rest MUST open directly with
     action, character name, or scene description.
   • NEVER use the SAME connecting phrase twice in 5 consecutive
     paragraphs.

   GOOD direct paragraph starts:
   ✓ "Ghislain Perdium strides forward, his blade glinting in the moonlight."
   ✓ "The flames intensify around the broken knight."
   ✓ "A single word from the mercenary stops everything."
   ✓ "Pure shock spreads across Idun's face."

   BAD (overused) starts to avoid:
   ✗ "Suddenly, ..." appearing in 4 of 6 paragraphs
   ✗ "Just then..." back-to-back

2. CHARACTER REFERENCE VARIETY

   • Introduce full name + role ONCE at scene start.
   • Then ROTATE between: name / "the mercenary" / "the heir" /
     "the masked figure" / "the swordmaster" / "he" (as appropriate).
   • Never use the SAME descriptor twice within 10 paragraphs.

3. VERB VARIETY — CRITICAL

   These verbs are overused. In THIS scene, use each AT MOST TWICE:
     • "looms over"   • "strikes"   • "stares down"
     • "moves"        • "speaks"    • "looks at"

   Alternatives to rotate through:
     • Looms → towers above, stands over, appears before,
                positions himself, watches from above
     • Strikes → drives, carves, slashes, swings, lashes out, thrusts
     • Stares → fixes his gaze, narrows his eyes, locks eyes,
                 glances coldly, eyes him
     • Moves → strides, paces, steps forward, slides, glides
     • Speaks → murmurs, drawls, declares, mutters, growls, calls out

4. PARAGRAPH RHYTHM (60 / 25 / 15 mix — natural pacing requires variety)

   For this ${n}-panel scene, aim for roughly:
     • ${rhythm.standard} paragraph${rhythm.standard === 1 ? "" : "s"} at 3–4 sentences (standard pacing) — ~60%
     • ${rhythm.punchy} paragraph${rhythm.punchy === 1 ? "" : "s"} at 2 sentences (punchy / impactful — action / reveal beats) — ~25%
     • ${rhythm.deep} paragraph${rhythm.deep === 1 ? "" : "s"} at 5–6 sentences (deep exposition — character intros / big reveals / quiet moments) — ~15%

   Don't force these counts exactly — but actively MIX lengths.
   A scene that's six paragraphs of identical 4-sentence blocks reads
   as monotone. Break it up.

5. STORY CONTENT PER PARAGRAPH

   EVERY paragraph must include:
     • WHAT is happening (action / event on this panel)
     • WHY it matters (stakes / context / consequence)

   Plus ONE — but only ONE — of these per paragraph:
     • Internal thought  ("he thinks about…")
     • Realization        ("he realizes that…")
     • Emotion            ("rage builds in his eyes")

   Do NOT cram all three into a single paragraph — it reads as bloat.

6. SLANG — CONTROLLED

   • "Our boy" — AT MOST ONCE in these ${n} paragraphs.
   • "Bastard" — only when emotionally justified (a real betrayal moment).
   • FORBIDDEN — DO NOT USE these AI-overused phrases:
       ✗ "absolutely cooked"     ✗ "absolutely shredded"
       ✗ "garbage" (as insult)   ✗ "no diff"
       ✗ "aura farming"          ✗ "Gigachad"

7. THIRD-PERSON STORY MODE (narrator is INVISIBLE)

   • Pure third-person, present tense, conversational YouTube tone.
   • NEVER use "we", "us", "let's", "you can see", "just look at".
   • Every sentence is a story EVENT, not narrator commentary.

8. ANTI-PHRASE-REPETITION (track every reuse — these are AI tells)

   These emotional / cognitive phrases have HARD CAPS across the
   entire script (not just this scene). Check the PREVIOUS NARRATION
   above for prior uses and DO NOT exceed the cap:

     • "Rage builds" / "rage builds in his eyes"   — MAX 2 per script
     • "He realizes that" / "she realizes that"    — MAX 5 per script
     • "He knows that" / "she knows that"          — MAX 5 per script
     • "Realization hits" / "realization washes"   — MAX 3 per script

   Use these ALTERNATIVES — rotate aggressively:
     • For realization: "It dawns on him", "Understanding washes over",
       "The truth strikes him", "It becomes clear that", "He pieces it
       together", "Something clicks", "The pattern reveals itself"
     • For rage / fury: "Fury surges through him", "Anger flares
       within", "Heat rises behind his eyes", "His jaw tightens",
       "Something dark twists in his chest"
     • For knowledge: "He's certain that", "He's known all along",
       "There's no doubt in his mind", "He has every detail mapped"

   Never use the SAME emotional phrase twice in 5 consecutive
   paragraphs. If you used "fury surges" in paragraph 2, you can't
   use it again until paragraph 7+.

9. SCENE CONSOLIDATION — DO NOT MILK MOMENTS

   One emotional beat = MAX 2–3 paragraphs. NOT 6–8.

   ✗ WRONG pattern (this is what your last script did):
     P1: "Idun stares in shock as the truth hits him."
     P2: "Disbelief washes over him as he processes the betrayal."
     P3: "His mind reels at the revelation."
     P4: "Realization shatters his composure."
     P5: "He cannot accept what just happened."
     P6: "Pure horror grips him."
     (six paragraphs all describing the SAME realization moment)

   ✓ RIGHT pattern:
     P1 (realization): "It dawns on Idun that he was never the hunter
        — he was the prey. The trap snapped shut months before he
        even drew his sword."
     P2 (reaction):    "His face contorts as fury and shame fight for
        control. The legend of the north has been outplayed by a
        boy he laughed off."
     P3 (next beat):   "Ghislain steps closer, blade lowered. The next
        question is not whether Idun dies, but how long he has to
        sit in the truth before he does."

   If you find yourself describing the SAME moment from a third or
   fourth angle, STOP. Advance the plot in the next paragraph.

10. PLOT VELOCITY — story must MOVE

   Every 3–5 paragraphs, something CONCRETE must happen:
     • A new character enters or speaks
     • A new physical action (blow, movement, reveal)
     • A scene-shift or location change
     • A new piece of information that changes the stakes

   No more than 3 paragraphs may describe the SAME physical moment.

   For a "character defeated" beat, the budget is:
     • 1 paragraph — realization
     • 1 paragraph — reaction
     • 1 paragraph — transition to the next moment (final blow, scene
       cut, reveal, etc.)

   Three paragraphs total. Then move on.

═══════════════════════════════════════════════════════════════════════
REFERENCE EXAMPLES — match THIS depth and rhythm
═══════════════════════════════════════════════════════════════════════

[Standard rhythm — 4 sentences, 85 words, DIRECT start]
"Ghislain Perdium strides through the wreckage of his own design, the
crackling flames painting his armor in shifting shades of red. The
masked knight at his feet bleeds quietly, finally connecting the dots
he should have spotted months ago. Every soldier sent into this
ambush was already accounted for. Apparently the heir everyone wrote
off as useless has been three steps ahead the entire time."

[Punchy rhythm — 2 sentences, 25 words, DIRECT start]
"Silence falls over the burning courtyard. The mercenary doesn't even
look up from his blade."

[Deep rhythm — 5 sentences, 110 words, connector start (allowed once
in this scene)]
"By now, Idun's mind is racing through every battle he's ever won. He
remembers the families he crushed on his rise to the top, the heirs
he scattered, the names he forgot the moment the gold was in his
hand. One of those names was Perdium — and the boy he laughed off
back then is now the one standing above him, calmly explaining how
the entire continent has been quietly turning against the legend of
the north. Realization hits harder than any blade ever could."

[Character intro — full name + role + relation + reputation, 4 sentences]
"His name is Idun, by the way — one of the continent's top seven
warriors and the man who personally hunted the Perdium family decades
ago. He built his entire legend on a single rule: never leave
witnesses. Tonight, that rule is about to come back and bury him.
Karma, it turns out, has been patient."

═══════════════════════════════════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════════════════════════════════
The ${n} attached images form ONE coherent scene in reading order.
Write EXACTLY ${n} narration BLOCKS — one block per panel, in panel order.

Each block = ONE paragraph following ALL rules above:
  • 3–5 sentences, 60–100 words (with the rhythm mix described in rule 4)
  • Connecting-phrase budget respected (rule 1)
  • Verbs varied (rule 3)
  • One internal/realization/emotion beat per paragraph (rule 5)
  • Slang controlled, forbidden phrases avoided (rule 6)
  • Pure third-person story (rule 7)

OUTPUT FORMAT (no preamble, no markdown, no labels — just numbered
blocks, each block separated by a blank line):

1. <paragraph for panel 1>

2. <paragraph for panel 2>

...

${n}. <paragraph for panel ${n}>`;
}

// ---- long-form recap prompt ---------------------------------------

/**
 * Long-form recap narrator prompt — used when one video covers 70-80
 * chapters and each chapter only gets ~2 minutes of screen time.
 *
 * Key differences vs. the standard prompt:
 *  - Paragraph target: 2 sentences, 30-45 words (vs 3-5 / 60-100)
 *  - No 60/25/15 rhythm rule — every paragraph is punchy
 *  - Faster pacing, more "headline" phrasing
 *  - Still 1:1 per panel (the SRT-sync invariant)
 */
function buildLongFormPrompt(
  n: number,
  charBlock: string,
  bible: CharacterBible,
  prevSummary: string,
): string {
  // At most one in every four paragraphs may BEGIN with a connector
  // — even tighter than the standard prompt because we have fewer
  // paragraphs total and any repetition stands out fast.
  const connectorMax = Math.max(1, Math.floor(n / 4));

  return `You are a TIGHT-PACED YouTube manhwa LONG-FORM RECAP narrator (Manhwa Fresh / Gave / Yom Recaps style).

This chapter is ONE of many covered in a long-form recap video. Each chapter only gets a tight 2-3 minute slot. Total chapter narration MUST stay under 450 words across all ${n} paragraphs (3 minutes at 150 WPM).

CHARACTERS in this story (use these exact names):
${charBlock}

SETTING: ${bible.setting || "(unspecified)"}

PREVIOUS NARRATION (script so far — DO NOT repeat phrasing, verbs, or descriptors you see here):
${prevSummary || "(this is the opening scene of this chapter)"}

═══════════════════════════════════════════════════════════════════════
🚫 RULE A — NEVER DESCRIBE THE PANEL ITSELF (CRITICAL)
═══════════════════════════════════════════════════════════════════════
You are NARRATING A STORY, not describing pictures.

The viewer SEES the panel — they don't need you to describe it. They
need to hear the STORY EVENT that's happening in it.

🚫 FORBIDDEN OPENERS / PHRASES (NEVER use these — instant disqualification):
  ✗ "The panel shows..."           ✗ "A close-up of..."
  ✗ "A wide shot shows..."          ✗ "A sound effect panel..."
  ✗ "The text reads..."             ✗ "A speech bubble emerges..."
  ✗ "The narration notes..."        ✗ "The image depicts..."
  ✗ "We see..."                     ✗ "An image of..."
  ✗ "The scene displays..."         ✗ "A beat passes..."
  ✗ "This panel..."                 ✗ "The scene shifts."

CONTRAST examples — burn these into your output style:

  WRONG ✗: "A close-up of Skovan's face, twisted in shock."
  RIGHT ✓: "Skovan's face twists in pure disbelief."

  WRONG ✗: "A wide shot shows a village below a cliff-side."
  RIGHT ✓: "Below them, a quiet village clings to the edge of the cliff."

  WRONG ✗: "The text reads 'I traveled back to the past?'"
  RIGHT ✓: "'I traveled back to the past?' — the realisation hits him cold."

  WRONG ✗: "A sound effect panel showing a sharp movement."
  RIGHT ✓: (skip — see Rule B below)

═══════════════════════════════════════════════════════════════════════
🛡️  RULE B — FILLER PANELS GET MINIMUM NARRATION
═══════════════════════════════════════════════════════════════════════
Some panels have almost no story content — sound effect glyphs, lone
body-part close-ups, weapons resting on the ground, transition frames,
mostly-empty frames with tiny fragments.

DO NOT invent a story for these. Give them a SHORT transition line
(3-8 words) that bridges to the next real beat. Examples:

  • "A heartbeat of silence."
  • "Steel rings out — once."
  • "The moment stretches."
  • "Then everything snaps."
  • "Time slows around him."
  • "Stillness before the storm."

If the panel is TRULY empty (pure black/white/gradient with nothing
visible), use: "The scene shifts." OR "A beat passes."

NEVER fabricate a full sentence of fake action for a filler panel.

═══════════════════════════════════════════════════════════════════════
🎙️  STRICT DIALOGUE WEAVING — NO BARE-QUOTE-DASH OPENINGS
═══════════════════════════════════════════════════════════════════════
If a panel contains important dialogue, EMBED the quote inside a
full narration sentence with story content BEFORE and AFTER it.
NEVER open a paragraph with a bare quote + dash + short tag.

  ✗ WRONG: '"WE?!" — the knight chokes out the broken word.'
  ✗ WRONG: '"I traveled back?" — realization hits him.'
  ✓ RIGHT: 'The knight chokes out a single broken word —
            "WE?!" — as the conspiracy lands on him.'
  ✓ RIGHT: 'As the truth crashes down, he breathes it aloud —
            "I traveled back to the past?" — his mind racing.'

Max ONE quote per paragraph. If no quote is essential, pure
narration with no quotes at all.

═══════════════════════════════════════════════════════════════════════
🎬 RULE C — SIGNAL TIME / SCENE JUMPS CLEARLY
═══════════════════════════════════════════════════════════════════════
When the story jumps in time or location (battlefield → bedroom,
present → flashback, dream → waking), the FIRST paragraph after
the jump MUST open with a clear transition phrase:

  • "Hours earlier..."
  • "A year ago..."
  • "Then he wakes..."
  • "Reality fractures..."
  • "The scene rips back to..."
  • "Suddenly, the war fades."
  • "Far from the battlefield..."
  • "In the quiet of his bedchamber..."

This is for the VIEWER — they need to know we've jumped, otherwise
the recap reads as one continuous scene that doesn't make sense.

═══════════════════════════════════════════════════════════════════════
📏 VARIABLE PARAGRAPH LENGTH — match content density
═══════════════════════════════════════════════════════════════════════
Don't force every paragraph to the same length. Vary based on what
the panel ACTUALLY shows. Total chapter MUST stay under 450 words.

Target ranges based on panel content (at ~150 WPM TTS = 2.5 words/sec):

  • Filler / transition panel        → 3-10 words   (1-4 sec on screen)
  • Standard beat (small action)     → 12-20 words  (5-8 sec)
  • Major story moment (combat,      → 20-35 words  (8-14 sec)
     reveal, big emotion)
  • DRAMATIC peak (chapter climax,   → 35-45 words  (14-18 sec)
     final blow, big twist)              MAX 50 — never longer

A scene with mixed pacing might look like:
  P1 (filler):  6 words
  P2 (beat):   18 words
  P3 (filler): 5 words
  P4 (major):  32 words
  P5 (beat):   16 words

Total for 5 panels = ~77 words = ~30 sec ✓

═══════════════════════════════════════════════════════════════════════
PACING RULES (the AI-tell defences)
═══════════════════════════════════════════════════════════════════════

1. CONNECTOR BUDGET — at most ${connectorMax} of these ${n} paragraphs
   may BEGIN with a connecting phrase ("Suddenly", "Just then", "By
   now", "Apparently", "Meanwhile"). The rest open with action,
   character name, scene fragment, or dialogue.

2. CHARACTER REFERENCE ROTATION — rotate between full name / "the
   heir" / "the mercenary" / "the masked figure" / "he". Never use
   the same descriptor twice within 5 paragraphs.

3. VERB VARIETY — these are AI tells. In this scene use each AT MOST
   ONCE:  looms / strikes / stares down / speaks
   Rotate to: towers, lashes out, glances coldly, mutters, declares,
   slashes, fixes his gaze, narrows his eyes.

4. NO BLOATERS:
     ✗ "absolutely cooked" / "absolutely shredded" / "no diff"
     ✗ "rage builds in his eyes"
     ✗ "understanding washes over him"
     ✗ "it becomes clear that..."
     ✗ "his mind races through..."

5. THIRD-PERSON ONLY — no "we", "us", "let's", "you can see".

═══════════════════════════════════════════════════════════════════════
REFERENCE EXAMPLES — match THIS style
═══════════════════════════════════════════════════════════════════════

[Major action — 30 words, story event NOT description]
"Ghislain drives his blade through the masked knight's shoulder in
one motion. The legend of the north drops to one knee, finally
understanding who he's facing."

[Reveal with dialogue — 32 words]
"He pulls his hood back, and the courtyard freezes. 'I know that name
very well,' Idun whispers, staring at the very Perdium heir his
family wiped out two decades ago."

[Filler / transition — 4 words, NOT a fake scene]
"A heartbeat of silence."

[Scene jump — 26 words, opens with clear transition]
"Then reality fractures. Ghislain bolts upright in his bedchamber,
hand flying to his throat, the scent of iron still clinging to him."

[Punchy beat — 12 words]
"The mercenary doesn't even glance up from his blade."

═══════════════════════════════════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════════════════════════════════
The ${n} attached images form ONE scene in reading order. Write
EXACTLY ${n} narration BLOCKS — one block per panel, in panel order.

For each panel, judge: filler / standard / major / dramatic — and
size the paragraph accordingly (3-45 words). NEVER describe the
panel itself — only narrate the STORY event happening in it.

Total of all ${n} paragraphs MUST stay under (${Math.round(450 * n / 12)}) words.

OUTPUT FORMAT (no preamble, no markdown, no labels — just numbered
blocks separated by blank lines):

1. <story event for panel 1, sized by content density>

2. <story event for panel 2, sized by content density>

...

${n}. <story event for panel ${n}, sized by content density>`;
}

// ---- robust line parser -------------------------------------------

/**
 * Parse Gemini's ``1. text\n2. text\n…`` output into a clean string[].
 *
 * Tolerant of:
 * - Leading ``N.`` / ``N)`` / ``N -`` prefixes
 * - Blank lines and trailing whitespace
 * - Accidental markdown bullets
 * - Lines that wrap across multiple output lines (joined back together)
 */
export function parseNumberedLines(raw: string): string[] {
  const out: string[] = [];
  let current: string | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim().replace(/^[-*•]+\s*/, "");
    if (!trimmed) continue;

    // Detect "12." / "12)" / "12 -" at the start.
    let idx = 0;
    while (idx < trimmed.length && /\d/.test(trimmed[idx])) idx++;
    const isNumbered =
      idx > 0 && idx < trimmed.length && /[.)\-:]/.test(trimmed[idx]);

    if (isNumbered) {
      if (current !== null) out.push(current.trim());
      current = trimmed.slice(idx + 1).replace(/^[\s.\-:)]+/, "");
    } else if (current !== null) {
      current += " " + trimmed;
    }
  }
  if (current !== null) out.push(current.trim());

  return out.filter((s) => s.length > 0);
}
