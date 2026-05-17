// Master character bible — accumulates characters across many chapters.
//
// Why it matters for 30-40 chapter scale: in single-chapter mode each
// run independently extracts a bible from the opening panels, so a
// character named in chapter 1 becomes "the masked man" again in
// chapter 5 (because their name didn't appear in chapter 5's first
// pages). The master bible keeps every known character alive across
// the whole series, so the narrator stays consistent.
//
// Persisted to localStorage under one stable key so the user can pick
// up partial bulk runs across browser sessions.

import type { CharacterBible, MasterBible } from "../types/manhwa";
import { readJson, removeKey, writeJson } from "./storage";

const STORAGE_KEY = "manhwa.masterBible.v1";

const EMPTY: MasterBible = {
  characters: {},
  uncertain: [],
  setting: "",
  premise: "",
  tone: "",
  updatedAt: "",
  chapterCount: 0,
  chapterSources: [],
};

export function loadMasterBible(): MasterBible {
  return readJson<MasterBible>(STORAGE_KEY, EMPTY);
}

export function saveMasterBible(bible: MasterBible): void {
  writeJson(STORAGE_KEY, bible);
}

export function clearMasterBible(): void {
  removeKey(STORAGE_KEY);
}

/** Strip the bookkeeping fields to make a plain ``CharacterBible``. */
export function asCharacterBible(master: MasterBible): CharacterBible {
  return {
    characters: master.characters,
    uncertain: master.uncertain,
    setting: master.setting,
    premise: master.premise,
    tone: master.tone,
  };
}

/**
 * Merge a chapter's bible into the master bible.
 *
 * The Gemini prompt explicitly tells the model to return a COMPLETE
 * updated bible (previous characters + new ones from this chapter),
 * not just deltas. So our merge here is just: adopt Gemini's output,
 * bump the chapter counter, append the source filename.
 *
 * If Gemini somehow dropped a character that was in the previous
 * bible, we restore it — defensive but cheap.
 */
export function mergeBible(
  master: MasterBible,
  chapterBible: CharacterBible,
  chapterFilename: string,
): MasterBible {
  // Defensive: re-add any characters from previous bible that
  // Gemini's response forgot. Prefer Gemini's (more recent) description
  // when both exist.
  const characters: Record<string, string> = { ...master.characters };
  for (const [name, desc] of Object.entries(chapterBible.characters)) {
    characters[name] = desc;
  }

  // Same defensive merge for uncertain — preserve any old entries that
  // describe a still-unnamed character but Gemini didn't echo back.
  const uncertain = dedupe([...(master.uncertain ?? []), ...(chapterBible.uncertain ?? [])]);

  return {
    characters,
    uncertain,
    setting: chapterBible.setting || master.setting,
    premise: chapterBible.premise || master.premise,
    tone: chapterBible.tone || master.tone,
    updatedAt: new Date().toISOString(),
    chapterCount: master.chapterCount + 1,
    chapterSources: [...master.chapterSources, chapterFilename],
  };
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const key = s.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
