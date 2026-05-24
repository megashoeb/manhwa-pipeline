// Stage 4a — character bible extraction.
//
// Sends the first N kept panels to Gemini in a single multi-image call
// and asks for a structured JSON bible covering character names,
// setting, premise, and tone. This bible is then threaded through
// every per-scene narration call so character names stay consistent.
//
// Same prompt that already proved itself against the user's chapter on
// the Python side — only adapted for the browser SDK shape.

import type { CharacterBible, FilteredPage } from "../types/manhwa";
import type { KeyRotator } from "./keyRotator";
import { generateContent } from "./geminiClient";
import { safeJsonParse } from "./jsonRepair";

// Sized to comfortably include mid-chapter reveals (e.g. "the hooded
// figure IS Ghislain") without blowing past Gemini's 20MB inline-data
// request cap. At ~300 KB per cropped page, 30 pages ≈ 12 MB raw / 16
// MB base64 — well under the limit.
const BIBLE_FROM_FIRST_N = 30;

export interface BibleOptions {
  model: string;
  rotator: KeyRotator;
  /**
   * Bible from previous chapters in the same series. When supplied,
   * the prompt tells Gemini to keep all known characters alive (no
   * drops on absence) and merely append new ones, so the narrator
   * stays consistent across a 30-40 chapter run.
   */
  previousBible?: CharacterBible;
  onKeyUsed?: (masked: string) => void;
}

/**
 * Build a character bible from the opening kept panels of a chapter.
 *
 * Only includes characters whose names actually appear in the panels'
 * text — the prompt explicitly forbids inventing names. Anything we
 * see but couldn't name is captured in ``uncertain`` so the narrator
 * step can still reference them by description.
 */
export async function extractCharacterBible(
  pages: FilteredPage[],
  { model, rotator, previousBible, onKeyUsed }: BibleOptions,
): Promise<CharacterBible> {
  const kept = pages.filter((p) => p.kept);
  const opening = kept.slice(0, BIBLE_FROM_FIRST_N);
  if (opening.length === 0) {
    throw new Error("No kept pages to extract a character bible from.");
  }

  const prompt = buildPrompt(opening.length, previousBible);
  const raw = await generateContent(rotator, {
    model,
    prompt,
    images: opening.map((p) => p.blob),
    responseMimeType: "application/json",
    temperature: 0.3, // bibles should be grounded, not creative
    onKeyUsed,
  });

  // Tolerant JSON parse — handles Qwen / Gemini quirks: code fences,
  // commentary, trailing commas, smart quotes, truncated output.
  // Avoids unnecessary chapter-level retries (each retry = 30s-3min
  // wasted on the same 3% of corrupt-output cases that a repair pass
  // would have fixed in microseconds).
  let parsed: Record<string, unknown>;
  try {
    parsed = safeJsonParse<Record<string, unknown>>(raw, "object");
  } catch (e) {
    throw new Error(
      `Bible response was not valid JSON: ${(e as Error).message}\n` +
        `Raw response: ${raw.slice(0, 600)}`,
    );
  }

  // Title-page indices come back as 1-based positions in the BATCH we
  // sent (1..opening.length). Map them to the original PDF page indices
  // so callers can use them directly against ``FilteredPage.index``.
  const rawTitle = parsed.title_page_indices;
  const titleInBatch = Array.isArray(rawTitle)
    ? rawTitle.filter((n): n is number => typeof n === "number")
    : [];
  const titlePageIndices = titleInBatch
    .map((batchIdx) => opening[batchIdx - 1]?.index)
    .filter((x): x is number => typeof x === "number");

  return {
    characters: (parsed.characters as Record<string, string>) ?? {},
    uncertain: (parsed.uncertain as string[]) ?? [],
    setting: (parsed.setting as string) ?? "",
    premise: (parsed.premise as string) ?? "",
    tone: (parsed.tone as string) ?? "",
    titlePageIndices,
  };
}

function buildPrompt(n: number, prev?: CharacterBible): string {
  const hasPrev = prev && Object.keys(prev.characters).length > 0;
  const prevContext = hasPrev ? buildPreviousContext(prev!) : "";
  const seriesMode = hasPrev
    ? `

THIS IS AN ONGOING SERIES.
You MUST return a COMPLETE updated bible (previous characters + any new ones from this chapter), NOT just the new ones. The previous bible above is your starting point — preserve every name and update descriptions if you learn new info. If a previously "uncertain" character is named in this chapter, MOVE them from "uncertain" to "characters" with that name.`
    : "";

  return `You are analyzing the opening pages of a manhwa chapter. The ${n} images below are the first kept panels of the story in reading order.${prevContext}${seriesMode}

Your task: build a "character bible" by carefully reading text in speech bubbles, narration boxes, and any visible name labels.

Return ONLY valid JSON (no markdown fences, no commentary) with this exact structure:

{
  "characters": {
    "<name as written in the manhwa>": "<one-line description: visual appearance + role + key states (calm/disguised/raging/etc.)>"
  },
  "uncertain": [
    "<EVERY visible unnamed character, with appearance + role + relationship to named characters>"
  ],
  "setting":  "<one sentence on the world/location>",
  "premise":  "<two sentences summarizing what happens in these opening panels>",
  "tone":     "<dark fantasy action | comedy | etc>",
  "title_page_indices": [<1-based positions of credits/title pages in this batch>]
}

Hard rules:
- Only include names you literally SAW written in the panels. Never invent names.
- If no name is shown, list the character under "uncertain" with a DETAILED description (appearance + role + relationship to named characters).
- ALWAYS populate "uncertain" — never leave it empty if there are visible characters whose names aren't shown.
- If a character's name has multiple spellings across panels, pick the most common one.
- Be specific in visual descriptions (hair color, distinguishing features, attire) so later scenes can disambiguate.

CRITICAL — Identity continuity (this is where most manhwa narrations fail):
- Watch for character REVEALS where one character IS another. Common patterns:
  • A disguised figure is unmasked.
  • A "weakling" or "useless" character reveals hidden power.
  • A masked / hooded figure removes their mask.
  • A character mocked by name turns out to be the very powerhouse fighting in another panel.
- If you spot such a reveal, note it EXPLICITLY in the character's description, e.g.:
  "Ghislain Perdium — the supposedly useless oldest son of Count Perdium, REVEALED to be the hooded mercenary with the axe seen in earlier panels."
- If a character appears in different states (disguised vs unmasked, calm vs raging, healthy vs wounded), describe ALL those states together so the narrator never treats them as two separate people.
- Pay attention to dialogue where one character ADDRESSES another by name or title (e.g. "Y-you're that garbage, Ghislain?!" said to a masked figure) — this can connect appearances across panels.

ADDITIONAL TASK — flag NON-STORY pages (scanlation credits / chapter title / cover):
Some early panels in a manhwa chapter are NOT story content. They are SCANLATION TEAM CREDITS or CHAPTER TITLE / COVER pages. Examples of what makes a page "non-story":
- Team labels like "TL:", "PR:", "CL:", "RD:", "TS:", "QC:" with names next to them
- Scanlation studio names / logos like "AsuraScans", "Lezhin", "Kakao", "MangaDex"
- Discord / website URLs ("Asura.gg/discord", "Asuracomic.net", etc.)
- A formal title-card display where the chapter title is the dominant element (e.g. "THE REGRESSED MERCENARY'S MACHINATIONS" in big stylised lettering with no story panel)
- A chapter-number splash (just "Chapter 2" / a large "2" with team credits around it)
- Original-language title cards (Korean / Chinese / Japanese title with no English story content)

In the JSON output, set "title_page_indices" to the 1-BASED panel positions (in THIS batch I sent, not the original PDF numbers) of every page that is PURELY credits / title / cover content. Examples:
- If panels 1 and 2 of the batch are credits + chapter title cards:  "title_page_indices": [1, 2]
- If panels 1, 2 and 4 are credits and a chapter-number splash:       "title_page_indices": [1, 2, 4]
- If none of the batch is credits/title:                              "title_page_indices": []

CRITICAL rules for title_page_indices:
- Only flag pages that are PURELY credits/title content. If a page has BOTH credits AND a real story panel, do NOT flag it.
- Pages with character art that's clearly part of the cover (no speech bubbles, no story dialogue) DO count as title pages.
- When in doubt, do NOT flag — keeping a borderline page produces 1 extra narration line, removing a real story page loses information.`;
}

// (extractFirstJsonObject moved to ./jsonRepair as part of safeJsonParse —
//  the shared module handles fences, balancing, AND structural repair.)

/** Compact text rendering of the previous bible for the prompt. */
function buildPreviousContext(prev: CharacterBible): string {
  const named =
    Object.entries(prev.characters)
      .map(([n, d]) => `  - ${n}: ${d}`)
      .join("\n") || "  (none yet)";
  const unnamed = prev.uncertain.length
    ? prev.uncertain.map((u) => `  - ${u}`).join("\n")
    : "  (none yet)";
  return `

PREVIOUS BIBLE (from earlier chapters in this same series — preserve these):

Known characters:
${named}

Previously uncertain (un-named in earlier chapters):
${unnamed}

Series setting:  ${prev.setting || "(unspecified)"}
Series premise:  ${prev.premise || "(unspecified)"}
Series tone:     ${prev.tone || "(unspecified)"}`;
}
