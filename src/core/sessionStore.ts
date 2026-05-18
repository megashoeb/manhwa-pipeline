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

// ---------------------------------------------------------------------
// Desktop disk backup (Level 3 redundancy)
//
// In the Electron build the renderer exposes ``window.manhwaApp.diskCheckpoint``
// via preload — same checkpoint data, written to a folder on disk
// in parallel with IndexedDB. If IDB gets evicted or corrupted the
// resume flow falls back to disk transparently.
//
// On the web build the bridge isn't present, so the helpers become
// no-ops and only IDB is used.
// ---------------------------------------------------------------------

interface DiskCheckpointAPI {
  saveMeta: (sessionId: string, meta: SessionMeta) => Promise<void>;
  writeChapter: (
    sessionId: string,
    chapterIndex: number,
    entry: Omit<CombinedChapterEntry, "blobs"> & { blobs: [] },
    blobBuffers: ArrayBuffer[],
  ) => Promise<void>;
  readSession: (sessionId: string) => Promise<{
    meta: SessionMeta;
    chapters: Array<{
      entry: Omit<CombinedChapterEntry, "blobs"> & {
        blobs?: unknown;
        chapterIndex: number;
      };
      blobBuffers: ArrayBuffer[];
    }>;
  } | null>;
  listSessions: () => Promise<
    Array<{ meta: SessionMeta; checkpointCount: number }>
  >;
  deleteSession: (sessionId: string) => Promise<void>;
  baseDir: () => Promise<string>;
  openFolder: (sessionId: string | null) => Promise<void>;
}

interface ManhwaAppBridge {
  isDesktop?: boolean;
  platform?: string;
  version?: string;
  diskCheckpoint?: DiskCheckpointAPI;
}

declare global {
  interface Window {
    manhwaApp?: ManhwaAppBridge;
  }
}

function disk(): DiskCheckpointAPI | null {
  if (typeof window === "undefined") return null;
  return window.manhwaApp?.diskCheckpoint ?? null;
}

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
  // Disk mirror (desktop only). Fire-and-forget so a slow disk write
  // doesn't stall the chapter pipeline. Errors are logged but don't
  // surface — IDB already succeeded.
  disk()
    ?.saveMeta(meta.id, meta)
    .catch((err) => console.warn("Disk session save failed:", err));
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
 * List all incomplete sessions (newest first). Merges sessions from
 * IndexedDB with the disk backup so a browser cache wipe doesn't
 * hide recoverable runs. Stale entries (older than
 * ``SESSION_TTL_DAYS``, or already complete) are deleted as a
 * side-effect.
 */
export async function listActiveSessions(): Promise<SessionMeta[]> {
  const db = await openDb();
  const fromIdb = await new Promise<SessionMeta[]>((resolve, reject) => {
    const t = db.transaction(STORE_SESSIONS, "readonly");
    const req = t.objectStore(STORE_SESSIONS).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });

  // Disk-side sessions (desktop only) — merge into the same set by ID.
  let fromDisk: SessionMeta[] = [];
  const diskApi = disk();
  if (diskApi) {
    try {
      const rows = await diskApi.listSessions();
      fromDisk = rows.map((r) => r.meta);
    } catch (err) {
      console.warn("Disk session list failed:", err);
    }
  }

  // Dedupe by id — IDB metadata wins on overlap (it's the primary source).
  const byId = new Map<string, SessionMeta>();
  for (const s of fromDisk) byId.set(s.id, s);
  for (const s of fromIdb) byId.set(s.id, s);
  const all = [...byId.values()];

  const ttlCutoff = Date.now() - SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const stale = all.filter((s) => s.startedAt < ttlCutoff || s.isComplete);
  for (const s of stale) {
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

  // Disk mirror (desktop only). Convert blobs to ArrayBuffers so IPC
  // can transport them, then strip blobs from the entry JSON (the
  // images get written as proper .jpg files on disk).
  const diskApi = disk();
  if (diskApi) {
    try {
      const blobBuffers = await Promise.all(
        entry.blobs.map((b) => b.arrayBuffer()),
      );
      // Strip blobs from the entry payload — they live as files on disk.
      const { blobs: _drop, ...rest } = entry;
      void _drop; // satisfy strict-unused
      await diskApi.writeChapter(
        sessionId,
        chapterIndex,
        { ...rest, blobs: [] },
        blobBuffers,
      );
    } catch (err) {
      console.warn("Disk checkpoint write failed (continuing on IDB):", err);
    }
  }
}

/**
 * Load all checkpoints for a session. Tries IndexedDB first; if it's
 * empty (e.g. browser cache cleared but the desktop disk backup is
 * still around) falls back to reading from the disk folder via the
 * Electron bridge.
 */
export async function loadCheckpoints(
  sessionId: string,
): Promise<Map<number, CombinedChapterEntry>> {
  const db = await openDb();
  const fromIdb = await new Promise<Map<number, CombinedChapterEntry>>(
    (resolve, reject) => {
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
    },
  );

  if (fromIdb.size > 0) return fromIdb;

  // IDB miss — try disk (desktop only). Lets the user recover even
  // after a browser data clear or quota eviction. Rehydrates Blobs
  // from the ArrayBuffers the main process sends back.
  const diskApi = disk();
  if (!diskApi) return fromIdb;
  try {
    const result = await diskApi.readSession(sessionId);
    if (!result || result.chapters.length === 0) return fromIdb;
    const out = new Map<number, CombinedChapterEntry>();
    for (const { entry, blobBuffers } of result.chapters) {
      const blobs = blobBuffers.map(
        (buf) => new Blob([buf], { type: "image/jpeg" }),
      );
      const reconstructed: CombinedChapterEntry = {
        ...(entry as unknown as CombinedChapterEntry),
        blobs,
      };
      out.set(reconstructed.chapterIndex, reconstructed);
    }
    console.log(
      `[RESUME] Loaded ${out.size} chapter(s) from disk fallback for session ${sessionId}`,
    );
    return out;
  } catch (err) {
    console.warn("Disk checkpoint read failed:", err);
    return fromIdb;
  }
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

  // Mirror delete to disk so the user's checkpoint folder doesn't
  // accumulate stale sessions.
  disk()
    ?.deleteSession(sessionId)
    .catch((err) => console.warn("Disk session delete failed:", err));
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
