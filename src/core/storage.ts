// Tiny typed wrapper around ``localStorage`` so the rest of the app
// doesn't sprinkle ``JSON.parse``/``stringify`` everywhere.
//
// Browser localStorage is synchronous and gives us ~5 MB per origin,
// which is plenty for API keys, usage counters, and the last-used
// filter settings.

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt entry — wipe it so we don't keep crashing on every read.
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return fallback;
  }
}

export function writeJson<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Most likely quota exceeded. We log and continue — the app stays
    // functional, the user just loses persistence on the next reload.
    console.warn(`localStorage write failed for key ${key}`);
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
