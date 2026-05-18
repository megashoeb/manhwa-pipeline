// Session store — power-cut-safe checkpointing for bulk pipeline runs.
//
// Why this exists:
//   Bulk processing 5-15 chapters can take 10-45 minutes. If the
//   browser closes mid-run (power cut, battery dead, tab crash,
//   accidental refresh) all completed-chapter work is lost from
//   in-memory ``accumulated[]``. The user has to restart from
//   chapter 1, re-running every Gemini call (slow + costs free-tier
//   quota).
//
// What we do:
//   • Before processing starts, register the run as a "session" with
//     a fingerprint of the input PDFs (name + size + lastModified).
//   • After each chapter completes, save its ``CombinedChapterEntry``
//     to IndexedDB as a "checkpoint" keyed by [sessionId, chapterIndex].
//   • On app load, ``BulkMode`` checks for any incomplete session. If
//     the same set of PDFs is re-uploaded, we offer to resume — the
//     completed chapters are loaded from IDB and skipped, only the
//     remaining ones run.
//   • After the final ZIP downloads successfully, the session is
//     marked complete and deleted on the next prune pass.
//
// IndexedDB instead of localStorage because:
//   • localStorage is 5 MB, way too small for image blobs.
//   • IDB stores Blobs natively via structured clone — no base64
//     conversion overhead.
//   • IDB is async — doesn't block the main thread during writes.

import type { CombinedChapterEntry } from "./combinedDownload";

const DB_NAME = "manhwa-pipeline";
const DB_VERSION = 1;
const STORE_SESSIONS = "sessions";
const STORE_CHECKPOINTS = "checkpoints";

/** Stale sessions get pruned after this — they're almost certainly abandoned. */
const SESSION_TTL_DAYS = 7;

/**
 * Identifies one PDF input by its filesystem fingerprint. We can't
 * read the file contents to hash (the file object becomes invalid
 * after the original processing run), but name + size + lastModified
 * together are uniquely identifying for >99% of realistic cases.
 */
export interface PdfFingerprint {
  name: string;
  size: number;
  lastModified: number;
}

/** Metadata for one bulk-processing run. */
export interface SessionMeta {
  id: string; // ISO timestamp + random suffix
  startedAt: number;
  /** Fingerprints of input PDFs in the original upload order. */
  pdfFingerprints: PdfFingerprint[];
  /** Options that were used (longFormRecap, etc.). Match required on resume. */
  options: {
    longFormRecap: boolean;
    concurrency?: number;
  };
  /** Set to true when the final ZIP downloaded successfully. */
  isComplete: boolean;
  /** How many chapters have been checkpointed so far. */
  checkpointCount: number;
}

// ---------------------------------------------------------------------
// DB connection (singleton)
// ---------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_CHECKPOINTS)) {
        const cps = db.createObjectStore(STORE_CHECKPOINTS, {
          keyPath: ["sessionId", "chapterIndex"],
        });
        cps.createIndex("bySession", "sessionId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Generate a fresh session ID. Timestamp + 4-char random suffix means
 * two sessions started in the same millisecond still differ.
 */
export function newSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${rand}`;
}

/** Compute a stable fingerprint from a File object. */
export function fingerprintFile(file: File): PdfFingerprint {
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  };
}

/** Same length AND each fingerprint matches in the same order. */
export function fingerprintsMatch(
  a: PdfFingerprint[],
  b: PdfFingerprint[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].name !== b[i].name ||
      a[i].size !== b[i].size ||
      a[i].lastModified !== b[i].lastModified
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Create or update a session record. Called once when a bulk run
 * starts. Safe to call repeatedly with the same id — it'll just
 * overwrite the metadata (useful for updating ``checkpointCount``).
 */
export async function saveSession(meta: SessionMeta): Promise<void> {
  const db = await openDb();
  await tx(db, [STORE_SESSIONS], "readwrite", (t) => {
    t.objectStore(STORE_SESSIONS).put(meta);
  });
}

/** Read a single session by id. */
export async function loadSession(id: string): Promise<SessionMeta | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_SESSIONS, "readonly");
    const req = t.objectStore(STORE_SESSIONS).get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * List all incomplete sessions (newest first). Stale ones (older than
 * ``SESSION_TTL_DAYS``) are deleted as a side-effect. Returns at most
 * 10 — there's no realistic case for more.
 */
export async function listActiveSessions(): Promise<SessionMeta[]> {
  const db = await openDb();
  const all = await new Promise<SessionMeta[]>((resolve, reject) => {
    const t = db.transaction(STORE_SESSIONS, "readonly");
    const req = t.objectStore(STORE_SESSIONS).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });

  const ttlCutoff = Date.now() - SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const stale = all.filter((s) => s.startedAt < ttlCutoff || s.isComplete);
  for (const s of stale) {
    // Fire-and-forget cleanup; UI doesn't wait on this.
    deleteSession(s.id).catch(() => {});
  }

  return all
    .filter((s) => s.startedAt >= ttlCutoff && !s.isComplete)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10);
}

/** Store one chapter's processed output. Idempotent — overwrites on re-save. */
export async function saveCheckpoint(
  sessionId: string,
  chapterIndex: number,
  entry: CombinedChapterEntry,
): Promise<void> {
  const db = await openDb();
  await tx(db, [STORE_CHECKPOINTS], "readwrite", (t) => {
    t.objectStore(STORE_CHECKPOINTS).put({
      sessionId,
      chapterIndex,
      entry,
    });
  });
}

/**
 * Load all checkpoints for a session, returned as a sparse array
 * indexed by ``chapterIndex - 1`` (matches the in-memory
 * ``accumulated`` array in bulkQueue).
 */
export async function loadCheckpoints(
  sessionId: string,
): Promise<Map<number, CombinedChapterEntry>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_CHECKPOINTS, "readonly");
    const idx = t.objectStore(STORE_CHECKPOINTS).index("bySession");
    const req = idx.getAll(IDBKeyRange.only(sessionId));
    req.onsuccess = () => {
      const out = new Map<number, CombinedChapterEntry>();
      for (const row of req.result as Array<{
        sessionId: string;
        chapterIndex: number;
        entry: CombinedChapterEntry;
      }>) {
        out.set(row.chapterIndex, row.entry);
      }
      resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Delete a session AND all its checkpoints in one go. */
export async function deleteSession(sessionId: string): Promise<void> {
  const db = await openDb();
  await tx(
    db,
    [STORE_SESSIONS, STORE_CHECKPOINTS],
    "readwrite",
    (t) => {
      t.objectStore(STORE_SESSIONS).delete(sessionId);
      const cpStore = t.objectStore(STORE_CHECKPOINTS);
      const idx = cpStore.index("bySession");
      const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
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

/** Mark a session complete — keeps it in DB for one TTL window then prunes. */
export async function markSessionComplete(sessionId: string): Promise<void> {
  const session = await loadSession(sessionId);
  if (!session) return;
  await saveSession({ ...session, isComplete: true });
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function tx(
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
