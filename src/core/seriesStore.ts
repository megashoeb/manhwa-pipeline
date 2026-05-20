// Series store — persistent multi-batch project accumulation.
//
// Use case: a manhwa with 50 chapters that the user wants to recap as
// ONE giant video, but who only has free-tier API budget for 10
// chapters at a time. Without series mode they'd have to upload all
// 50 in one shot (impossible on a slow connection / quota) and lose
// chapters on any browser crash.
//
// Series mode lets them:
//   1. Day 1: upload chapters 1-10 → process → append to a NEW series
//      called "Solo Leveling". 10 chapters saved to disk.
//   2. Day 2: upload chapters 11-15 → process → append to SAME series.
//      Series now has 15 chapters.
//   3. ... continue across days/weeks ...
//   4. Day N: upload the final chapters → process → click "Finalize
//      series". Pipeline generates an AI outro paragraph + builds the
//      mega-ZIP of all accumulated chapters + ending. Series marked
//      finalized.
//
// Storage:
//   • IndexedDB ``manhwa-pipeline`` DB (same as sessionStore).
//   • Two object stores:
//     - ``series`` — metadata per series (id, title, chapter count, etc.)
//     - ``seriesChapters`` — one record per chapter, keyed by
//       [seriesId, chapterNumber]. Blob bytes structured-clone natively.
//   • Optional disk mirror on desktop (Electron) — same redundancy
//     pattern as sessionStore, but skipped for now (sessionStore's disk
//     backup already covers in-progress runs; once chapters are
//     appended to a series, they're "safe" enough in IDB).

import type { CombinedChapterEntry } from "./combinedDownload";
import type { MasterBible } from "../types/manhwa";

const DB_NAME = "manhwa-pipeline";
const DB_VERSION = 2; // bump from sessionStore's v1 — adds 2 new stores
const STORE_SERIES = "series";
const STORE_SERIES_CHAPTERS = "seriesChapters";

export interface Series {
  /** UUID-ish, timestamp-based for ordering. */
  id: string;
  /** User-supplied title — shown in UI selector. */
  title: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last modified timestamp — bumped on every append. */
  updatedAt: number;
  /**
   * Total chapter count after all batches. Cached here so the UI
   * doesn't need to load every chapter record just to render
   * "Solo Leveling (15)" in the selector.
   */
  chapterCount: number;
  /**
   * Set to true after the user clicks "Finalize" and the mega-ZIP
   * downloads. Finalized series are hidden from the selector by
   * default but kept in DB so the user can re-download the ZIP later.
   */
  isFinalized: boolean;
  /**
   * Accumulated master bible across all batches. Lets the pipeline
   * keep character continuity even when chapter 1 was processed days
   * before chapter 50.
   */
  masterBible?: MasterBible;
}

/** Internal record shape stored in seriesChapters store. */
interface SeriesChapterRow {
  seriesId: string;
  chapterNumber: number; // 1-based, sequential across all batches in this series
  entry: CombinedChapterEntry;
  addedAt: number;
}

// ---------------------------------------------------------------------
// DB connection (separate singleton from sessionStore so the schema
// version bump only triggers ONCE — both modules go through this)
// ---------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // v1 stores from sessionStore — create them if not present
      // (handles users opening the app fresh after this upgrade).
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("checkpoints")) {
        const cps = db.createObjectStore("checkpoints", {
          keyPath: ["sessionId", "chapterIndex"],
        });
        cps.createIndex("bySession", "sessionId", { unique: false });
      }
      // v2 stores — series feature
      if (!db.objectStoreNames.contains(STORE_SERIES)) {
        db.createObjectStore(STORE_SERIES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SERIES_CHAPTERS)) {
        const sc = db.createObjectStore(STORE_SERIES_CHAPTERS, {
          keyPath: ["seriesId", "chapterNumber"],
        });
        sc.createIndex("bySeries", "seriesId", { unique: false });
      }
      void e; // satisfy strict-unused
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// ---------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------

export function newSeriesId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `series-${Date.now()}-${rand}`;
}

export async function createSeries(title: string): Promise<Series> {
  const series: Series = {
    id: newSeriesId(),
    title: title.trim() || "Untitled series",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    chapterCount: 0,
    isFinalized: false,
  };
  const db = await openDb();
  await runTx(db, [STORE_SERIES], "readwrite", (t) => {
    t.objectStore(STORE_SERIES).put(series);
  });
  return series;
}

export async function loadSeries(id: string): Promise<Series | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SERIES, "readonly");
    const req = t.objectStore(STORE_SERIES).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** All non-finalized series, newest first. */
export async function listActiveSeries(): Promise<Series[]> {
  const db = await openDb();
  const all = await new Promise<Series[]>((resolve, reject) => {
    const t = db.transaction(STORE_SERIES, "readonly");
    const req = t.objectStore(STORE_SERIES).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
  return all
    .filter((s) => !s.isFinalized)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** All series (including finalized) — for a future "Archive" view. */
export async function listAllSeries(): Promise<Series[]> {
  const db = await openDb();
  const all = await new Promise<Series[]>((resolve, reject) => {
    const t = db.transaction(STORE_SERIES, "readonly");
    const req = t.objectStore(STORE_SERIES).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Update series metadata (title, isFinalized, masterBible, etc.). */
export async function updateSeries(
  id: string,
  patch: Partial<Series>,
): Promise<void> {
  const db = await openDb();
  const existing = await loadSeries(id);
  if (!existing) throw new Error(`Series ${id} not found`);
  const updated: Series = {
    ...existing,
    ...patch,
    id, // ensure id is preserved
    updatedAt: Date.now(),
  };
  await runTx(db, [STORE_SERIES], "readwrite", (t) => {
    t.objectStore(STORE_SERIES).put(updated);
  });
}

/**
 * Append a batch of processed chapters to a series. Chapter numbers
 * continue from wherever the series left off (e.g. if the series had
 * 10 chapters, the appended batch becomes 11, 12, …). Updates the
 * series ``chapterCount`` + ``updatedAt`` atomically.
 */
export async function appendChaptersToSeries(
  seriesId: string,
  entries: CombinedChapterEntry[],
): Promise<{ addedCount: number; newTotal: number }> {
  if (entries.length === 0) {
    const s = await loadSeries(seriesId);
    return { addedCount: 0, newTotal: s?.chapterCount ?? 0 };
  }
  const series = await loadSeries(seriesId);
  if (!series) throw new Error(`Series ${seriesId} not found`);
  if (series.isFinalized) {
    throw new Error(
      `Series "${series.title}" is finalized — cannot append more chapters.`,
    );
  }

  const startNumber = series.chapterCount + 1;
  const db = await openDb();
  await runTx(
    db,
    [STORE_SERIES, STORE_SERIES_CHAPTERS],
    "readwrite",
    (t) => {
      const seriesStore = t.objectStore(STORE_SERIES);
      const chapterStore = t.objectStore(STORE_SERIES_CHAPTERS);
      for (let i = 0; i < entries.length; i++) {
        const chapterNumber = startNumber + i;
        const row: SeriesChapterRow = {
          seriesId,
          chapterNumber,
          entry: entries[i],
          addedAt: Date.now(),
        };
        chapterStore.put(row);
      }
      const updated: Series = {
        ...series,
        chapterCount: series.chapterCount + entries.length,
        updatedAt: Date.now(),
      };
      seriesStore.put(updated);
    },
  );
  return {
    addedCount: entries.length,
    newTotal: series.chapterCount + entries.length,
  };
}

/**
 * Load every chapter in a series, ordered by chapterNumber. Used by
 * the "Finalize" flow to feed the combined-ZIP builder.
 */
export async function loadSeriesChapters(
  seriesId: string,
): Promise<CombinedChapterEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SERIES_CHAPTERS, "readonly");
    const idx = t.objectStore(STORE_SERIES_CHAPTERS).index("bySeries");
    const req = idx.getAll(IDBKeyRange.only(seriesId));
    req.onsuccess = () => {
      const rows = (req.result as SeriesChapterRow[]) ?? [];
      rows.sort((a, b) => a.chapterNumber - b.chapterNumber);
      // Renumber chapterIndex sequentially in the returned entries so
      // combinedDownload sees clean 1..N indices (the entries may have
      // been processed in batches with their own per-batch indices).
      const out = rows.map((r, i) => ({
        ...r.entry,
        chapterIndex: i + 1,
      }));
      resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Delete a series + all its chapters (cascade). */
export async function deleteSeries(seriesId: string): Promise<void> {
  const db = await openDb();
  await runTx(
    db,
    [STORE_SERIES, STORE_SERIES_CHAPTERS],
    "readwrite",
    (t) => {
      t.objectStore(STORE_SERIES).delete(seriesId);
      const chapterStore = t.objectStore(STORE_SERIES_CHAPTERS);
      const idx = chapterStore.index("bySeries");
      const cursorReq = idx.openCursor(IDBKeyRange.only(seriesId));
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    },
  );
}

/** Mark series as finalized — won't appear in the active selector. */
export async function markSeriesFinalized(seriesId: string): Promise<void> {
  await updateSeries(seriesId, { isFinalized: true });
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function runTx(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (t: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    try {
      body(t);
    } catch (err) {
      reject(err);
    }
  });
}
