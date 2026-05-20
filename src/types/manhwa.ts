// Shared types used across the manhwa pipeline.

/**
 * One page extracted from a PDF, held in memory.
 *
 * The ``blob`` is the encoded JPEG (small — ~500KB). The ``url`` is an
 * object URL that React can render in ``<img>`` directly. Always call
 * ``revokeExtractedPages`` when discarding a batch so the browser
 * frees the underlying memory.
 */
export interface ExtractedPage {
  /** 1-based page number from the original PDF (matches the user's mental model). */
  index: number;
  width: number;
  height: number;
  /** Encoded JPEG bytes. Cheap to keep in memory for batches up to ~3K pages. */
  blob: Blob;
  /** `URL.createObjectURL(blob)` — render directly in ``<img src=...>``. */
  url: string;
}

/**
 * A page that has gone through the filter pipeline (crop → blank → dedup).
 *
 * The ``blob`` / ``url`` here point at the CROPPED image, not the
 * original. The original is still held separately by the App so the
 * filter can be re-run with different settings.
 */
export interface FilteredPage {
  /** 1-based index in the *original* PDF (preserves user mental model). */
  index: number;
  width: number;
  height: number;
  /** Cropped JPEG bytes. */
  blob: Blob;
  url: string;
  kept: boolean;
  /** Human-readable explanation — surfaced in the UI tooltip and manifest. */
  reason: string;
  /** Hex string of the phash, for the manifest. Empty for blank/uncomputed pages. */
  phash: string;
}

/** Tunable thresholds for the filter pipeline. */
export interface FilterSettings {
  /** Fraction of image height to strip from the top (0–0.20 typical). */
  cropTopPct: number;
  /** Fraction of image height to strip from the bottom. */
  cropBottomPct: number;
  /** Grayscale stddev ceiling for blank detection. 0 disables. */
  blankStddev: number;
  /** Grayscale mean floor for blank detection (combined with stddev). */
  blankMean: number;
  /** phash Hamming-distance ceiling to call two pages "the same". */
  dedupeThreshold: number;
  /** Number of previously kept pages to compare against (1 = consecutive only). */
  dedupeLookback: number;
}

export const DEFAULT_FILTER_SETTINGS: FilterSettings = {
  cropTopPct: 0.05,
  cropBottomPct: 0.05,
  blankStddev: 40,
  blankMean: 240,
  dedupeThreshold: 5,
  dedupeLookback: 1,
};

/** Aggregate filter outcome — what the UI shows above the grid. */
export interface FilterStats {
  total: number;
  kept: number;
  droppedBlank: number;
  droppedDuplicate: number;
  /**
   * Title / scanlation-credits pages detected by Gemini during bible
   * extraction. Counted separately so the user can see WHY each kind of
   * page was excluded.
   */
  droppedTitlePage?: number;
}

export interface FilterResult {
  pages: FilteredPage[];
  stats: FilterStats;
}

// =====================================================================
// Gemini / API-key state
// =====================================================================

/**
 * One Gemini API key, with the metadata we need to rotate intelligently.
 *
 * ``value`` is the raw key string and is the only secret here — we
 * mask it everywhere except in the request itself.
 */
export interface ApiKey {
  /** The raw `AIzaSy…` key. Never displayed in full in the UI. */
  value: string;
  /** Short human-readable label, e.g. "Main key", "Backup". User-editable. */
  label: string;
  /** Disable a key without deleting it (useful when troubleshooting quotas). */
  enabled: boolean;
  /**
   * "free" (default) — enforce the 15 RPM / 500 RPD free-tier caps.
   * "paid" — billing-enabled key; rotator does NOT throttle on RPM or
   * RPD because paid Tier 1 starts at ~1000 RPM with no daily cap. A
   * single paid key unlocks high-concurrency mode (up to PAID_MAX_CONCURRENCY
   * parallel chapters) in bulkQueue, turning 4-hour 50-chapter runs
   * into ~30-minute runs.
   *
   * Omitted on legacy ApiKey records — treated as "free" for backward compat.
   */
  tier?: "free" | "paid";
}

/** Per-key runtime usage tracking. Persisted in localStorage and reset daily. */
export interface ApiKeyUsage {
  /** Requests made today. Resets at local midnight. */
  usageDay: number;
  /** ISO date string (YYYY-MM-DD) the counter belongs to. */
  resetDate: string;
  /** Unix-ms timestamps of recent requests (for sliding-window RPM tracking). */
  recentRequests: number[];
}

/** Rate-limit limits we enforce per key. Match Gemini's free-tier defaults. */
export interface KeyLimits {
  dailyLimit: number;
  minuteLimit: number;
}

export const DEFAULT_KEY_LIMITS: KeyLimits = {
  dailyLimit: 500, // gemini-3.1-flash-lite free-tier RPD (from your dashboard)
  minuteLimit: 15, // gemini-3.1-flash-lite free-tier RPM (from your dashboard)
};

// =====================================================================
// Stage 4 — script generation
// =====================================================================

/** The "character bible" Gemini returns from the opening panels. */
export interface CharacterBible {
  characters: Record<string, string>;
  uncertain: string[];
  setting: string;
  premise: string;
  tone: string;
  /**
   * 1-based ORIGINAL PDF page indices Gemini flagged as scanlation
   * credits or chapter-title/cover pages (e.g. "AsuraScans" branding
   * with TL:/PR:/CL: team labels, the "Chapter 2" splash page).
   *
   * These are filtered out of scene narration so the script starts on
   * actual story content, AND excluded from the downloaded image ZIP.
   * Undefined when the bible call didn't run title detection.
   */
  titlePageIndices?: number[];
}

/** One generated scene — N panels grouped together with their narration. */
export interface SceneOutput {
  sceneIndex: number;
  /** 1-based page indices in the original PDF. */
  panelIndices: number[];
  /** Narration sentences, one per panel — preserves the 1:1 sync invariant. */
  lines: string[];
}

/** Final assembled output of Stage 4. */
export interface ScriptResult {
  bible: CharacterBible;
  scenes: SceneOutput[];
  /** Flattened per-panel narration lines, in order. ``length === kept pages``. */
  lines: string[];
  /** Plain-text script ready to paste into the MegaShoeb TTS server. */
  scriptText: string;
  /**
   * Original PDF page indices the AI flagged as title / credits pages
   * and excluded from narration. Surfaced so the UI can mark them as
   * dropped in the image grid and trim them from the ZIP download.
   */
  titlePageIndices: number[];
}

// =====================================================================
// Pipeline progress
// =====================================================================

export type PipelineStage =
  | "idle"
  | "extracting"
  | "filtering"
  | "bible"
  | "curating"
  | "narrating"
  | "polishing"
  | "structural"
  | "accuracy"
  | "bridging"
  | "packaging"
  | "combining"
  | "done";

/** Live pipeline progress, surfaced to the UI as the run advances. */
export interface PipelineProgress {
  stage: PipelineStage;
  current: number;
  total: number;
  /** Short message shown next to the progress bar — keep it human-friendly. */
  message: string;
}

// =====================================================================
// Bulk mode — queue + master bible (M6)
// =====================================================================

/** Lifecycle of one PDF in the bulk queue. */
export type QueueItemStatus = "pending" | "processing" | "done" | "failed";

/** One row in the bulk queue. */
export interface QueueItem {
  file: File;
  status: QueueItemStatus;
  /** Pipeline stage currently running (only meaningful while ``status === "processing"``). */
  stage?: PipelineStage;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** Filled in once filter completes. */
  keptCount?: number;
  /** Filled in once narration completes. */
  lineCount?: number;
}

/**
 * Master bible — character bible that accumulates across chapters.
 *
 * Threaded into every chapter's Gemini bible extraction so newly seen
 * characters get added while previously known characters stay
 * consistent. Persisted to localStorage so the user can pick up where
 * they left off across browser sessions.
 */
export interface MasterBible extends CharacterBible {
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** Number of chapters that have contributed so far. */
  chapterCount: number;
  /** Filenames (chapter PDFs) that have been processed in order. */
  chapterSources: string[];
}
