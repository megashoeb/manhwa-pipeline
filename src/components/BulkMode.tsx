import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BookOpen,
  CheckCircle2,
  CircleDot,
  Download,
  Files,
  Loader2,
  Play,
  Sparkles,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import clsx from "clsx";

import { FilterSettingsPanel } from "./FilterSettings";
import { ApiKeyManager } from "./ApiKeyManager";

import { runBulkQueue, type BulkProgressUpdate } from "../core/bulkQueue";
import { clearMasterBible, loadMasterBible } from "../core/masterBible";
import {
  deleteSession,
  fingerprintFile,
  fingerprintsMatch,
  listActiveSessions,
  loadCheckpoints,
  type SessionMeta,
} from "../core/sessionStore";
import {
  createSeries,
  deleteSeries,
  listActiveSeries,
  loadSeriesChapters,
  markSeriesFinalized,
  type Series,
} from "../core/seriesStore";
import { generateSeriesEnding } from "../core/endingGenerator";
import { downloadCombinedRecap } from "../core/combinedDownload";

import {
  DEFAULT_FILTER_SETTINGS,
  type FilterSettings,
  type MasterBible,
  type PipelineStage,
  type QueueItem,
} from "../types/manhwa";
import type { KeyRotator } from "../core/keyRotator";

const GEMINI_MODEL = "gemini-3.1-flash-lite";

interface Props {
  rotator: KeyRotator;
}

/**
 * Bulk mode UI — drop N PDFs, hit Start, the queue processes one
 * chapter at a time, auto-downloads a ZIP per chapter, and builds up
 * a master bible that stays consistent across the whole series.
 */
export function BulkMode({ rotator }: Props) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [settings, setSettings] = useState<FilterSettings>(
    DEFAULT_FILTER_SETTINGS,
  );
  const [masterBible, setMasterBible] = useState<MasterBible>(() =>
    loadMasterBible(),
  );

  // Long-form recap mode — AI curates each chapter down to its
  // story-driving panels (~15-30) and the queue produces ONE combined
  // ZIP at the end instead of per-chapter ZIPs. Designed for 70-80
  // chapter overnight runs that become a single 2-3 hour video.
  const [longFormRecap, setLongFormRecap] = useState(false);
  // Parallel chapter processing — runs N chapters at once where N is
  // the number of enabled API keys. Big speedup for large runs at the
  // cost of slightly weaker cross-chapter narrative continuity
  // (chapter handoff becomes "last-completed sibling" instead of
  // "strict chapter N-1"). Default OFF for spec compliance.
  const [parallelChapters, setParallelChapters] = useState(false);
  // Last successful combined-ZIP blob — populated after each long-form
  // run completes, so the user can re-download the archive without
  // re-running the queue. Cleared when a new run starts so the button
  // never offers a stale file.
  const [lastZip, setLastZip] = useState<{
    blob: Blob;
    filename: string;
    chapters: number;
    at: number; // Date.now() — for "downloaded N seconds ago" UI
  } | null>(null);

  const [busy, setBusy] = useState(false);
  // Per-item progress map — in parallel mode multiple chapters fire
  // onProgress concurrently. Storing as a Map keyed by item index lets
  // each queue row show its OWN current stage + percent without the
  // top bar flickering between chapters.
  const [progressByItem, setProgressByItem] = useState<
    Map<number, BulkProgressUpdate>
  >(new Map());
  // Cross-chapter progress (itemIndex === -1) — bridges + combined ZIP
  // build. Shown ONCE at the top because these aren't per-chapter.
  const [crossProgress, setCrossProgress] =
    useState<BulkProgressUpdate | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [bulkStartedAt, setBulkStartedAt] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ---- Resumable sessions ---------------------------------------
  // IndexedDB-backed checkpoints saved after each chapter. If the
  // browser closed mid-run (power cut, crash, refresh), we can pick
  // up exactly where we left off — the user just re-uploads the
  // same PDFs and clicks Resume. ``activeSessions`` is hydrated on
  // mount; ``matchingSession`` is the one whose PDF fingerprints
  // line up with the currently-queued items.
  const [activeSessions, setActiveSessions] = useState<
    Array<{ meta: SessionMeta; checkpointCount: number }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sessions = await listActiveSessions();
        if (cancelled) return;
        const enriched = await Promise.all(
          sessions.map(async (meta) => {
            const cps = await loadCheckpoints(meta.id);
            return { meta, checkpointCount: cps.size };
          }),
        );
        if (!cancelled) setActiveSessions(enriched);
      } catch (err) {
        console.warn("Failed to load resumable sessions:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const matchingSession = useMemo(() => {
    if (items.length === 0 || activeSessions.length === 0) return null;
    const currentFps = items.map((it) => fingerprintFile(it.file));
    return (
      activeSessions.find((s) =>
        fingerprintsMatch(s.meta.pdfFingerprints, currentFps),
      ) ?? null
    );
  }, [items, activeSessions]);

  const discardSession = useCallback(
    async (sessionId: string) => {
      if (
        !window.confirm(
          "Discard this saved session? All checkpoint data will be deleted and you'll have to start the run from chapter 1.",
        )
      )
        return;
      await deleteSession(sessionId).catch(() => {});
      setActiveSessions((prev) =>
        prev.filter((s) => s.meta.id !== sessionId),
      );
    },
    [],
  );

  // ---- Series mode -----------------------------------------------
  // Persistent multi-batch projects: user uploads 10 chapters today,
  // 10 tomorrow, etc., all appended to the same series. When done,
  // they hit "Finalize" — pipeline generates an AI outro and builds
  // a mega-ZIP across every batch.
  const [activeSeriesList, setActiveSeriesList] = useState<Series[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>("");
  const [addToSeries, setAddToSeries] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [seriesStatus, setSeriesStatus] = useState<string>("");

  const refreshSeries = useCallback(async () => {
    try {
      const list = await listActiveSeries();
      setActiveSeriesList(list);
      // Preserve current selection if it's still active; otherwise
      // pick the newest series so the dropdown isn't empty.
      setSelectedSeriesId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev;
        return list[0]?.id ?? "";
      });
    } catch (err) {
      console.warn("Failed to load active series:", err);
    }
  }, []);

  useEffect(() => {
    refreshSeries();
  }, [refreshSeries]);

  const activeSeries = useMemo(
    () => activeSeriesList.find((s) => s.id === selectedSeriesId) ?? null,
    [activeSeriesList, selectedSeriesId],
  );

  const createNewSeries = useCallback(async () => {
    const title = window.prompt(
      "Series name (e.g. 'Solo Leveling', 'Tower of God'):",
      "",
    );
    if (!title || !title.trim()) return;
    try {
      const s = await createSeries(title);
      await refreshSeries();
      setSelectedSeriesId(s.id);
      setAddToSeries(true);
    } catch (err) {
      window.alert(
        `Failed to create series: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [refreshSeries]);

  const discardSeries = useCallback(
    async (seriesId: string) => {
      const s = activeSeriesList.find((x) => x.id === seriesId);
      const label = s ? `"${s.title}" (${s.chapterCount} chapters)` : "this series";
      if (
        !window.confirm(
          `Delete ${label}? All accumulated chapter data will be lost. Cannot be undone.`,
        )
      )
        return;
      await deleteSeries(seriesId).catch(() => {});
      await refreshSeries();
    },
    [activeSeriesList, refreshSeries],
  );

  /**
   * Finalize the active series: generate AI outro, then build the
   * mega-ZIP across ALL accumulated batches. Marks the series as
   * finalized in IDB so it disappears from the active selector.
   */
  const finalizeSeries = useCallback(async () => {
    if (!activeSeries) return;
    if (
      !window.confirm(
        `Finalize "${activeSeries.title}" (${activeSeries.chapterCount} chapters)?\n\n` +
          "An AI-generated outro paragraph will be added and the final mega-ZIP " +
          "will download. After this the series cannot be added to.",
      )
    )
      return;

    setFinalizing(true);
    setSeriesStatus("Loading all accumulated chapters…");
    try {
      const chapters = await loadSeriesChapters(activeSeries.id);
      if (chapters.length === 0) {
        window.alert("This series has no chapters yet — process some first.");
        setFinalizing(false);
        return;
      }

      setSeriesStatus(
        `Generating outro for ${chapters.length} chapters via Gemini…`,
      );
      // Pull the trailing beats of the LAST chapter as context for the outro.
      const lastChapter = chapters[chapters.length - 1];
      const tailLines = lastChapter.script.lines.slice(-6);
      const ending = await generateSeriesEnding({
        seriesTitle: activeSeries.title,
        tailLines,
        chapterCount: chapters.length,
        rotator,
        onKeyUsed: (m) => setCurrentKey(m),
      });

      // Append ending as a synthetic final beat tied to the last chapter's
      // last image (preserves 1:1 image↔beat invariant in the master ZIP).
      const lastBlobs = lastChapter.blobs;
      const tailImage = lastBlobs[lastBlobs.length - 1];
      const endingEntry = {
        chapterIndex: chapters.length + 1,
        chapterName: `Ending — ${activeSeries.title}`,
        blobs: tailImage ? [tailImage] : [],
        script: {
          // ScriptResult shape — only ``lines`` is read by combinedDownload,
          // everything else is contextual. Cast to bypass strict shape check.
          lines: [ending],
          scriptText: ending,
          bible: { characters: {} },
          scenes: [
            {
              panelIndices: [],
              lines: [ending],
            },
          ],
          titlePageIndices: [],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      };

      const finalEntries = tailImage ? [...chapters, endingEntry] : chapters;

      setSeriesStatus("Building mega-ZIP — this can take a minute…");
      const safeTitle = activeSeries.title
        .replace(/[^a-zA-Z0-9 _-]+/g, "")
        .replace(/\s+/g, "_")
        .slice(0, 40)
        || "series";
      await downloadCombinedRecap(finalEntries, {
        outputName: `${safeTitle}_FINAL_${chapters.length}ch_${Date.now()}`,
        onProgress: (c, t, msg) => setSeriesStatus(`${msg} (${c}/${t})`),
        onArchiveReady: (blob, filename) => {
          setLastZip({
            blob,
            filename,
            chapters: chapters.length,
            at: Date.now(),
          });
        },
      });
      await markSeriesFinalized(activeSeries.id);
      await refreshSeries();
      setSeriesStatus(`Finalized — ${chapters.length} chapters + outro saved.`);
    } catch (err) {
      console.error("Finalize failed:", err);
      setSeriesStatus(
        `Finalize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setFinalizing(false);
    }
  }, [activeSeries, rotator, refreshSeries]);

  // ---- Retry failed only ----------------------------------------
  // After a run completes, the user can click "Retry failed" to
  // re-process JUST the chapters that ended with status === "failed",
  // without re-doing the ones that succeeded. Implemented as a
  // partial re-run that flips failed rows back to pending + calls
  // start() — the existing skip-checkpointed logic in bulkQueue will
  // bypass the done ones.
  const retryFailed = useCallback(async () => {
    if (busy) return;
    const failedCount = items.filter((it) => it.status === "failed").length;
    if (failedCount === 0) return;
    setItems((prev) =>
      prev.map((it) =>
        it.status === "failed"
          ? { file: it.file, status: "pending" as const }
          : it,
      ),
    );
    // Defer start() to next tick so setItems flushes first.
    window.setTimeout(() => start(), 0);
  }, [busy, items]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render whenever the rotator state changes (usage, keys added).
  const [, forceRender] = useState(0);
  useEffect(
    () => rotator.subscribe(() => forceRender((n) => n + 1)),
    [rotator],
  );

  const hasAnyKey = useMemo(
    () => rotator.list().some((k) => k.enabled && k.value.trim()),
    // rotator.subscribe forces re-render so this stays fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rotator.list().length, busy],
  );

  const stats = useMemo(() => {
    const done = items.filter((i) => i.status === "done").length;
    const failed = items.filter((i) => i.status === "failed").length;
    const pending = items.filter((i) => i.status === "pending").length;
    const processing = items.filter((i) => i.status === "processing").length;
    return { done, failed, pending, processing, total: items.length };
  }, [items]);

  // ---- file handling --------------------------------------------

  function addFiles(picked: FileList | File[] | null) {
    if (!picked) return;
    const incoming = Array.from(picked).filter((f) =>
      f.name.toLowerCase().endsWith(".pdf"),
    );
    if (incoming.length === 0) return;
    setItems((prev) => {
      const seen = new Set(prev.map((p) => `${p.file.name}::${p.file.size}`));
      const additions: QueueItem[] = [];
      for (const f of incoming) {
        const key = `${f.name}::${f.size}`;
        if (seen.has(key)) continue;
        seen.add(key);
        additions.push({ file: f, status: "pending" });
      }
      // Sort A→Z by name so the queue is always in reading order.
      //   • ``numeric: true``    → chapter_2 < chapter_10  (natural sort)
      //   • ``sensitivity: "base"`` → ``Chapter 1.pdf`` and ``chapter 2.pdf``
      //                             collate together (case-insensitive)
      const next = [...prev, ...additions];
      next.sort((a, b) =>
        a.file.name.localeCompare(b.file.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
      return next;
    });
  }

  function removeItem(idx: number) {
    if (busy) return;
    setItems((prev) => prev.filter((_, i) => i !== idx));
  }

  function clearAll() {
    if (busy) return;
    setItems([]);
  }

  // ---- run control ----------------------------------------------

  const start = useCallback(async (resumeSessionId?: string) => {
    if (busy || items.length === 0 || !hasAnyKey) return;
    // Reset all non-done items back to pending so a re-run continues
    // through previously-failed ones too.
    setItems((prev) =>
      prev.map((it) =>
        it.status === "done"
          ? it
          : { file: it.file, status: "pending" as const },
      ),
    );
    setBusy(true);
    setBulkStartedAt(Date.now());
    // Clear any stale "Download again" blob from a previous run — the
    // new run will produce a fresh archive.
    setLastZip(null);
    // Wipe any leftover progress state from a prior run.
    setProgressByItem(new Map());
    setCrossProgress(null);
    abortRef.current = new AbortController();

    // We pass the (re-)filtered list. Done items are skipped inside
    // the queue runner because their status will be "done" already.
    const queueFiles = items
      .filter((it) => it.status !== "done")
      .map((it) => it.file);
    const indexMap = new Map<File, number>();
    items.forEach((it, idx) => indexMap.set(it.file, idx));

    // Parallel mode resolves to "N chapters in flight at once".
    // • With a PAID key: cap at PAID_MAX_CONCURRENCY (10) — paid Tier 1
    //   easily handles this and a single key unlocks full parallelism
    //   without juggling 10 free Google accounts. This was the user's
    //   exact ask: "ek paid key se max parallel chala do".
    // • Free-only: N = number of enabled free keys (1 RPM-bucket per
    //   key keeps throttle contention low).
    // • concurrency undefined → bulkQueue defaults to 1 (sequential).
    const PAID_MAX_CONCURRENCY = 10;
    const enabledKeyCount = rotator
      .list()
      .filter((k) => k.enabled && k.value.trim()).length;
    const hasPaid = rotator.hasPaidKey();
    let concurrency: number | undefined;
    if (parallelChapters) {
      if (hasPaid) {
        // One paid key is enough to unlock high parallelism. If the user
        // also added some free keys we still cap at PAID_MAX_CONCURRENCY
        // because going beyond that hits diminishing returns.
        concurrency = Math.min(
          PAID_MAX_CONCURRENCY,
          Math.max(enabledKeyCount, PAID_MAX_CONCURRENCY),
        );
      } else if (enabledKeyCount > 1) {
        concurrency = enabledKeyCount;
      }
    }

    await runBulkQueue({
      files: queueFiles,
      rotator,
      model: GEMINI_MODEL,
      filterSettings: settings,
      longFormRecap,
      concurrency,
      sessionId: resumeSessionId,
      // Series mode: append-to-series instead of building per-batch
      // ZIP, but only when long-form mode is on (regular per-chapter
      // mode doesn't accumulate into a combined output anyway).
      appendToSeriesId:
        longFormRecap && addToSeries && selectedSeriesId
          ? selectedSeriesId
          : undefined,
      onItemUpdate: (queueIdx, patch) => {
        const realIdx = indexMap.get(queueFiles[queueIdx]);
        if (realIdx == null) return;
        setItems((prev) => {
          const next = [...prev];
          next[realIdx] = { ...next[realIdx], ...patch };
          return next;
        });
        // Clear progress entry when item finishes — keeps the queue
        // row showing the final "done/failed" summary instead of
        // stale progress info.
        if (patch.status === "done" || patch.status === "failed") {
          setProgressByItem((prev) => {
            if (!prev.has(realIdx)) return prev;
            const next = new Map(prev);
            next.delete(realIdx);
            return next;
          });
        }
      },
      onProgress: (u) => {
        // Cross-chapter event (combining ZIP, stitching bridges) —
        // not tied to a specific chapter; show separately at the top.
        if (u.itemIndex < 0) {
          setCrossProgress(u);
          return;
        }
        const realIdx = indexMap.get(queueFiles[u.itemIndex]);
        if (realIdx == null) return;
        setProgressByItem((prev) => {
          const next = new Map(prev);
          next.set(realIdx, { ...u, itemIndex: realIdx });
          return next;
        });
      },
      onMasterBibleUpdate: (bible) => setMasterBible(bible),
      // Capture the final combined-ZIP blob so the user can hit
      // "Download again" after the run finishes. The auto-download
      // ALSO fires (this callback is fire-and-store, not a replacement).
      onArchiveReady: (blob, filename) => {
        setLastZip({
          blob,
          filename,
          chapters: items.filter((it) => it.status !== "failed").length,
          at: Date.now(),
        });
      },
      onKeyUsed: (m) => setCurrentKey(m),
      abortSignal: abortRef.current.signal,
    });

    setBusy(false);
    setProgressByItem(new Map());
    setCrossProgress(null);
    setCurrentKey(null);
    // Refresh resumable sessions — the just-finished session was
    // deleted by bulkQueue on successful completion, so this clears
    // the resume banner from the UI.
    listActiveSessions()
      .then(async (sessions) => {
        const enriched = await Promise.all(
          sessions.map(async (meta) => {
            const cps = await loadCheckpoints(meta.id);
            return { meta, checkpointCount: cps.size };
          }),
        );
        setActiveSessions(enriched);
      })
      .catch(() => {});
    // Series mode: refresh the series chapter-count after append.
    refreshSeries().catch(() => {});
  }, [
    busy,
    items,
    hasAnyKey,
    rotator,
    settings,
    longFormRecap,
    parallelChapters,
    addToSeries,
    selectedSeriesId,
    refreshSeries,
  ]);

  function cancel() {
    abortRef.current?.abort();
  }

  function resetBible() {
    if (
      !window.confirm(
        "Clear the master bible? This will reset character continuity for the next bulk run. " +
          "Already-downloaded chapter ZIPs are unaffected.",
      )
    )
      return;
    clearMasterBible();
    setMasterBible(loadMasterBible());
  }

  // ---- render ---------------------------------------------------

  return (
    <div className="space-y-8">
      {/* Resume banner — shows when previously-interrupted session(s)
          exist in IndexedDB. Once the user uploads matching PDFs, the
          banner highlights itself + offers a one-click resume. */}
      {!busy && activeSessions.length > 0 && (
        <ResumeBanner
          sessions={activeSessions}
          matchingSessionId={matchingSession?.meta.id ?? null}
          onResume={(sessionId) => start(sessionId)}
          onDiscard={discardSession}
        />
      )}

      {/* Series panel — multi-batch project accumulation. Lets the
          user process 50-chapter projects across multiple days
          (e.g. 10 chapters / day for a week) into a single mega-ZIP. */}
      <SeriesPanel
        seriesList={activeSeriesList}
        selectedSeriesId={selectedSeriesId}
        onSelect={setSelectedSeriesId}
        addToSeries={addToSeries}
        onToggleAdd={setAddToSeries}
        onCreateNew={createNewSeries}
        onDiscard={discardSeries}
        onFinalize={finalizeSeries}
        busy={busy}
        finalizing={finalizing}
        finalizingStatus={seriesStatus}
        longFormRecap={longFormRecap}
      />

      {/* Step 1 — drop PDFs */}
      <Section title="Step 1 — Drop chapter PDFs (multiple)">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (busy) return;
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => !busy && inputRef.current?.click()}
          className={clsx(
            "rounded-lg border-2 border-dashed p-8 text-center transition select-none",
            busy
              ? "cursor-not-allowed opacity-50 border-zinc-700"
              : "cursor-pointer",
            !busy && isDragging
              ? "border-blue-400 bg-blue-500/10"
              : "border-zinc-700 hover:border-zinc-500",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              if (e.target) e.target.value = ""; // allow re-picking same file
            }}
          />
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800">
              <Files className="h-6 w-6 text-zinc-300" />
            </div>
            <div className="text-sm font-medium text-zinc-200">
              Drop multiple PDFs here, or click to browse
            </div>
            <div className="text-[11px] text-zinc-500">
              PDFs are queued and processed one chapter at a time. Each
              completed chapter auto-downloads as a ZIP.
            </div>
          </div>
        </div>

        {items.length > 0 && (
          <div className="mt-3 flex items-center justify-between">
            <div className="text-xs text-zinc-500">
              <span className="font-semibold text-zinc-200">
                {items.length}
              </span>{" "}
              file{items.length === 1 ? "" : "s"} queued
              <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                sorted A→Z
              </span>
            </div>
            {!busy && (
              <button
                type="button"
                onClick={clearAll}
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" />
                Clear queue
              </button>
            )}
          </div>
        )}
      </Section>

      {/* Step 1.5 — long-form recap mode */}
      {items.length > 0 && (
        <Section title="Step 1.5 — Output mode">
          <LongFormToggle
            value={longFormRecap}
            onChange={setLongFormRecap}
            busy={busy}
            chapterCount={items.length}
          />
          <div className="mt-3">
            <ParallelToggle
              value={parallelChapters}
              onChange={setParallelChapters}
              busy={busy}
              enabledKeyCount={rotator
                .list()
                .filter((k) => k.enabled && k.value.trim()).length}
              hasPaidKey={rotator.hasPaidKey()}
              chapterCount={items.length}
            />
          </div>
        </Section>
      )}

      {/* Step 2 — filter */}
      {items.length > 0 && (
        <Section title="Step 2 — Filter settings (apply to every chapter)">
          <FilterSettingsPanel
            settings={settings}
            onChange={setSettings}
            onApply={() => {}}
            busy={busy}
            dirty={false}
          />
          <div className="mt-2 text-[11px] text-zinc-500">
            Changes apply to every chapter in the queue. There's no
            "re-apply" here — the filter runs as part of the per-chapter pipeline.
          </div>
        </Section>
      )}

      {/* Step 3 — keys */}
      {items.length > 0 && (
        <Section title="Step 3 — API keys (more keys = more daily capacity)">
          <ApiKeyManager rotator={rotator} />
        </Section>
      )}

      {/* Step 4 — master bible */}
      {items.length > 0 && (
        <Section title="Step 4 — Master character bible (cross-chapter continuity)">
          <MasterBibleCard bible={masterBible} onReset={resetBible} />
        </Section>
      )}

      {/* Step 5 — start */}
      {items.length > 0 && (
        <Section title="Step 5 — Run the queue">
          <div className="flex flex-wrap items-center gap-3">
            {!busy ? (
              <button
                type="button"
                onClick={() => start()}
                disabled={!hasAnyKey || items.length === 0}
                className="flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                <Play className="h-4 w-4" />
                {stats.done > 0
                  ? `Resume queue (${stats.pending + stats.failed} remaining)`
                  : longFormRecap
                    ? `Start long-form recap (${items.length} chapters → 1 ZIP)`
                    : `Start bulk run (${items.length} chapters)`}
              </button>
            ) : (
              <button
                type="button"
                onClick={cancel}
                className="flex items-center gap-2 rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
              >
                <Square className="h-4 w-4" />
                Cancel after current chapter
              </button>
            )}

            {!hasAnyKey && (
              <span className="text-xs text-zinc-500">
                Add at least one API key (Step 3) to enable.
              </span>
            )}

            {busy && currentKey && (
              <span className="ml-auto text-[11px] text-zinc-500">
                using key{" "}
                <code className="font-mono text-zinc-400">{currentKey}</code>
              </span>
            )}
          </div>
        </Section>
      )}

      {/* Live progress + queue list */}
      {items.length > 0 && (busy || stats.done + stats.failed > 0) && (
        <Section title="Queue status">
          <BulkSummary
            stats={stats}
            elapsedMs={bulkStartedAt ? Date.now() - bulkStartedAt : null}
            busy={busy}
          />
          {/* Cross-chapter operations (continuity bridges / combined
              ZIP build) — shown ONCE at the top because they're not
              tied to any single chapter. Per-chapter progress lives
              inside the QueueList below. */}
          {crossProgress && busy && (
            <ProgressLine progress={crossProgress} fileName={undefined} />
          )}
          {/* Retry-failed-only button — appears after a run completes
              if any chapter ended in "failed". Re-runs JUST the failed
              files; already-done chapters are skipped via checkpoint. */}
          {!busy && stats.failed > 0 && (
            <div className="mt-3 flex items-center justify-between rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2">
              <div className="text-xs text-amber-200">
                <span className="font-semibold">{stats.failed}</span> chapter
                {stats.failed === 1 ? "" : "s"} failed after auto-retry. Click
                to re-process just the failed ones.
              </div>
              <button
                type="button"
                onClick={retryFailed}
                disabled={!hasAnyKey}
                className="rounded bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Retry {stats.failed} failed
              </button>
            </div>
          )}
          {/* Re-download button — shows when a combined ZIP is in
              memory. Lets the user trigger another download without
              re-running the queue (useful if the auto-download was
              dismissed / lost / saved to wrong folder). */}
          {lastZip && !busy && (
            <DownloadAgainCard
              filename={lastZip.filename}
              chapters={lastZip.chapters}
              sizeBytes={lastZip.blob.size}
              onDownload={() => triggerBlobDownload(lastZip.blob, lastZip.filename)}
            />
          )}
          <QueueList
            items={items}
            progressByItem={progressByItem}
            busy={busy}
            onRemove={removeItem}
          />
        </Section>
      )}
    </div>
  );
}

// =====================================================================
// Sub-components
// =====================================================================

/**
 * Resume banner — appears at the top of BulkMode when one or more
 * unfinished sessions exist in IndexedDB. The user can:
 *   • See how many chapters of which run were completed before the
 *     browser closed (power cut / crash / accidental refresh).
 *   • Re-upload the same PDFs to enable a one-click Resume button.
 *   • Discard a session entirely (e.g. they changed their mind and
 *     don't want to redo this run).
 *
 * When the currently-queued PDFs match a saved session's fingerprints,
 * that session's Resume button is highlighted. Otherwise the user
 * just sees the saved sessions as references — they can match them
 * by name or just discard.
 */
function ResumeBanner({
  sessions,
  matchingSessionId,
  onResume,
  onDiscard,
}: {
  sessions: Array<{ meta: SessionMeta; checkpointCount: number }>;
  matchingSessionId: string | null;
  onResume: (sessionId: string) => void;
  onDiscard: (sessionId: string) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-700/40 bg-amber-950/30 p-4">
      <div className="mb-2 flex items-center gap-2 text-amber-300">
        <CircleDot className="h-4 w-4" />
        <span className="text-sm font-semibold">
          {sessions.length === 1
            ? "Previous session found — resume from where it stopped"
            : `${sessions.length} previous sessions found — resume any`}
        </span>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-amber-200/80">
        A bulk run was interrupted (power cut / browser closed / tab
        crashed). Completed chapters are saved to your browser. Re-upload
        the <span className="font-semibold">same PDFs</span> to enable
        Resume — already-processed chapters will be skipped automatically.
      </p>
      <div className="space-y-2">
        {sessions.map(({ meta, checkpointCount }) => {
          const isMatch = meta.id === matchingSessionId;
          const startedAt = new Date(meta.startedAt);
          const ageMs = Date.now() - meta.startedAt;
          const ageLabel =
            ageMs < 60_000
              ? "just now"
              : ageMs < 3_600_000
                ? `${Math.round(ageMs / 60_000)} min ago`
                : ageMs < 86_400_000
                  ? `${Math.round(ageMs / 3_600_000)} h ago`
                  : `${Math.round(ageMs / 86_400_000)} d ago`;
          return (
            <div
              key={meta.id}
              className={clsx(
                "flex items-center justify-between gap-3 rounded border px-3 py-2 text-xs",
                isMatch
                  ? "border-emerald-600/60 bg-emerald-950/30"
                  : "border-zinc-700/50 bg-zinc-900/40",
              )}
            >
              <div className="min-w-0 flex-1">
                <div
                  className={clsx(
                    "font-mono text-[11px] truncate",
                    isMatch ? "text-emerald-200" : "text-zinc-300",
                  )}
                >
                  {checkpointCount} / {meta.pdfFingerprints.length} chapters
                  done — started {ageLabel}
                  {meta.options.longFormRecap ? " · long-form" : ""}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-zinc-500">
                  {meta.pdfFingerprints
                    .slice(0, 3)
                    .map((p) => p.name)
                    .join(", ")}
                  {meta.pdfFingerprints.length > 3 &&
                    ` +${meta.pdfFingerprints.length - 3} more`}{" "}
                  · {startedAt.toLocaleString()}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {isMatch ? (
                  <button
                    type="button"
                    onClick={() => onResume(meta.id)}
                    className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                  >
                    <Play className="h-3 w-3" />
                    Resume
                  </button>
                ) : (
                  <span className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-500">
                    Upload same PDFs
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onDiscard(meta.id)}
                  className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:border-red-500/60 hover:text-red-400"
                  title="Delete this saved session"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Series mode panel — multi-batch project accumulation.
 *
 * Workflow the panel supports:
 *   1. User clicks "New series" → enters a title (e.g. "Solo Leveling").
 *   2. They check "Add to series" → next bulk run appends to that
 *      series instead of building a per-batch combined ZIP.
 *   3. They can come back the next day, upload more chapters, leave
 *      "Add to series" on → those chapters get appended too.
 *   4. When done across all batches, click "Finalize" → pipeline
 *      generates an AI outro and the mega-ZIP downloads.
 *
 * Only meaningful in long-form recap mode (regular per-chapter mode
 * doesn't accumulate). The panel shows a hint when long-form is off.
 */
function SeriesPanel({
  seriesList,
  selectedSeriesId,
  onSelect,
  addToSeries,
  onToggleAdd,
  onCreateNew,
  onDiscard,
  onFinalize,
  busy,
  finalizing,
  finalizingStatus,
  longFormRecap,
}: {
  seriesList: Series[];
  selectedSeriesId: string;
  onSelect: (id: string) => void;
  addToSeries: boolean;
  onToggleAdd: (v: boolean) => void;
  onCreateNew: () => void;
  onDiscard: (id: string) => void;
  onFinalize: () => void;
  busy: boolean;
  finalizing: boolean;
  finalizingStatus: string;
  longFormRecap: boolean;
}) {
  const active = seriesList.find((s) => s.id === selectedSeriesId);
  const hasSeries = seriesList.length > 0;
  const canAdd = longFormRecap && hasSeries && !busy;
  const canFinalize =
    longFormRecap && active && active.chapterCount > 0 && !busy && !finalizing;

  return (
    <div className="rounded-lg border border-indigo-700/40 bg-indigo-950/20 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-indigo-300" />
          <span className="text-sm font-semibold text-indigo-200">
            Series mode
          </span>
          <span className="rounded bg-indigo-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-indigo-300">
            multi-batch
          </span>
        </div>
        <button
          type="button"
          onClick={onCreateNew}
          disabled={busy}
          className="rounded bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + New series
        </button>
      </div>

      <p className="mb-3 text-[12px] leading-relaxed text-indigo-200/70">
        Process big projects (30-100 chapters) across multiple days. Each batch
        appends to the active series; click <strong>Finalize</strong> when done
        for the master ZIP with AI-generated outro.
      </p>

      {!longFormRecap && hasSeries && (
        <div className="mb-3 rounded border border-zinc-700/60 bg-zinc-900/40 px-2 py-1.5 text-[11px] text-zinc-400">
          Series mode requires <strong>Long-form recap</strong> to be enabled
          below.
        </div>
      )}

      {hasSeries ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-xs text-indigo-200/80">Active series:</label>
            <select
              value={selectedSeriesId}
              onChange={(e) => onSelect(e.target.value)}
              disabled={busy}
              className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              {seriesList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} — {s.chapterCount} chapter
                  {s.chapterCount === 1 ? "" : "s"}
                </option>
              ))}
            </select>
            {active && (
              <button
                type="button"
                onClick={() => onDiscard(active.id)}
                disabled={busy}
                className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:border-red-500/60 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                title="Delete this series + all accumulated chapters"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>

          <label
            className={clsx(
              "flex items-center gap-2 text-xs",
              canAdd
                ? "cursor-pointer text-indigo-200"
                : "cursor-not-allowed text-zinc-500",
            )}
          >
            <input
              type="checkbox"
              checked={addToSeries && canAdd}
              disabled={!canAdd}
              onChange={(e) => onToggleAdd(e.target.checked)}
              className="h-3.5 w-3.5 accent-indigo-500"
            />
            Append next bulk run to{" "}
            <strong className="text-indigo-100">{active?.title}</strong>{" "}
            (instead of downloading a separate ZIP)
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onFinalize}
              disabled={!canFinalize}
              className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              title={
                canFinalize
                  ? "Generate AI outro + build mega-ZIP of all accumulated chapters"
                  : active && active.chapterCount === 0
                    ? "Add some chapters first"
                    : "Disabled while busy"
              }
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Finalize {active?.title ?? "series"} (
              {active?.chapterCount ?? 0} ch + outro)
            </button>
            {finalizing && (
              <span className="flex items-center gap-1 text-[11px] text-indigo-200">
                <Loader2 className="h-3 w-3 animate-spin" />
                {finalizingStatus || "Finalizing…"}
              </span>
            )}
            {!finalizing && finalizingStatus && (
              <span className="text-[11px] text-indigo-200/70">
                {finalizingStatus}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded border border-dashed border-indigo-700/40 bg-indigo-950/30 px-3 py-3 text-center text-xs text-indigo-200/70">
          No active series yet — click <strong>+ New series</strong> to start
          one.
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Trigger a browser download for an in-memory Blob. Same mechanism
 *  combinedDownload uses internally — re-implemented locally so the
 *  Download Again button doesn't need to import anything from /core. */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DownloadAgainCard({
  filename,
  chapters,
  sizeBytes,
  onDownload,
}: {
  filename: string;
  chapters: number;
  sizeBytes: number;
  onDownload: () => void;
}) {
  const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
  return (
    <div className="mt-3 flex items-center gap-3 rounded border border-emerald-700/60 bg-emerald-950/30 px-4 py-3">
      <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-emerald-400" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-100">
          Combined ZIP ready &mdash; {chapters} chapter
          {chapters === 1 ? "" : "s"}
        </div>
        <div className="truncate text-[11px] text-zinc-500">
          <code className="font-mono">{filename}</code> &middot; {sizeMB} MB
          &middot; already downloaded automatically
        </div>
      </div>
      <button
        type="button"
        onClick={onDownload}
        className="flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
      >
        <Download className="h-3.5 w-3.5" />
        Download again
      </button>
    </div>
  );
}

function ParallelToggle({
  value,
  onChange,
  busy,
  enabledKeyCount,
  hasPaidKey,
  chapterCount,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  busy: boolean;
  enabledKeyCount: number;
  hasPaidKey: boolean;
  chapterCount: number;
}) {
  // Speedup math — assumes ~10 min per chapter sequential.
  // Free-only: N parallel workers = N enabled keys.
  // Paid mode: unlocks up to 10 concurrent regardless of key count
  // (single paid key handles 1000+ RPM, way more than we'll ever push).
  const PAID_MAX_CONCURRENCY = 10;
  const workerCap = hasPaidKey
    ? Math.max(PAID_MAX_CONCURRENCY, enabledKeyCount)
    : enabledKeyCount;
  const effectiveWorkers = Math.max(1, Math.min(workerCap, chapterCount));
  const sequentialMin = chapterCount * 10;
  const parallelMin = Math.ceil(chapterCount / effectiveWorkers) * 10;
  const savedMin = sequentialMin - parallelMin;
  // With a paid key, even 1 enabled key is enough to enable parallel.
  // Without paid, need 2+ free keys to make parallel meaningful.
  const canEnable = hasPaidKey || enabledKeyCount >= 2;

  return (
    <div
      className={clsx(
        "rounded border bg-zinc-900/40 transition",
        value && canEnable
          ? "border-orange-700/60 bg-orange-950/20"
          : "border-zinc-800",
        !canEnable && "opacity-60",
      )}
    >
      <label
        className={clsx(
          "flex items-start gap-3 px-4 py-3",
          busy || !canEnable ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <input
          type="checkbox"
          checked={value && canEnable}
          disabled={busy || !canEnable}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer accent-orange-500"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-200">
              Process chapters in parallel
            </span>
            {value && canEnable && (
              <span className="rounded bg-orange-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-orange-300">
                {effectiveWorkers}× faster
              </span>
            )}
            {hasPaidKey && (
              <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                paid mode
              </span>
            )}
            {!canEnable && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                needs 2+ keys (or 1 paid)
              </span>
            )}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-zinc-400">
            Run up to <strong className="text-zinc-200">{effectiveWorkers}</strong> chapters at once
            {hasPaidKey
              ? " (paid key unlocks high concurrency — no rate-limit pauses)."
              : " (one per enabled key)."}{" "}
            Speedup is roughly {effectiveWorkers}× on large runs.
          </div>
          {value && canEnable && chapterCount > 1 && (
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-zinc-500 sm:grid-cols-3">
              <div>
                Sequential: ~<span className="font-semibold text-zinc-300">{sequentialMin}</span> min
              </div>
              <div>
                Parallel: ~<span className="font-semibold text-zinc-300">{parallelMin}</span> min
              </div>
              <div className="text-emerald-400">
                Saves ~<span className="font-semibold">{savedMin}</span> min
              </div>
            </div>
          )}
          <div className="mt-2 text-[11px] italic text-zinc-500">
            Trade-off: chapter-to-chapter narrative handoff (each chapter
            seeing the previous chapter's last 4 beats) becomes
            "best-effort" — siblings finish in arbitrary order, so a
            chapter may pick up tail from whichever sibling completed
            last, not strictly chapter N−1. Master bible + continuity
            bridges still work fully. For action-heavy or self-contained
            chapters this barely matters; for dialogue-heavy political
            intrigue, keep this OFF.
          </div>
        </div>
      </label>
    </div>
  );
}

function LongFormToggle({
  value,
  onChange,
  busy,
  chapterCount,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  busy: boolean;
  chapterCount: number;
}) {
  // Rough budget for the user's mental model. Standard preset: ~9
  // narration paragraphs per chapter × ~16 sec per line at 150 WPM
  // TTS with the tight long-form paragraph length (~40 words). These
  // are estimates, not promises — the curator AI auto-decides the
  // actual count within the 5-12 range, and TTS speed varies.
  const estLinesPerChapter = 9;
  const estSecondsPerLine = 16;
  const estMinutes = Math.round(
    (chapterCount * estLinesPerChapter * estSecondsPerLine) / 60,
  );

  return (
    <div
      className={clsx(
        "rounded border bg-zinc-900/40 transition",
        value
          ? "border-purple-700/60 bg-purple-950/20"
          : "border-zinc-800",
      )}
    >
      <label
        className={clsx(
          "flex items-start gap-3 px-4 py-3",
          busy ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        )}
      >
        <input
          type="checkbox"
          checked={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer accent-purple-500"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Sparkles
              className={clsx(
                "h-4 w-4 flex-shrink-0",
                value ? "text-purple-400" : "text-zinc-500",
              )}
            />
            <span className="text-sm font-medium text-zinc-200">
              Long-form recap (compress + combine)
            </span>
            {value && (
              <span className="rounded bg-purple-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-purple-300">
                on
              </span>
            )}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-zinc-400">
            AI selects only the story-driving panels per chapter (combat,
            reveals, character intros — typically 15-30 panels each) and the
            queue produces <strong className="text-zinc-200">one combined ZIP</strong> at the end with
            flat <code className="text-[11px] text-zinc-300">chapter_NN_panel_MM.jpg</code> naming
            and a single master <code className="text-[11px] text-zinc-300">script.txt</code>.
          </div>
          {value && (
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-zinc-500 sm:grid-cols-4">
              <div>
                <span className="font-semibold text-zinc-300">
                  {chapterCount}
                </span>{" "}
                chapters
              </div>
              <div>
                ~<span className="font-semibold text-zinc-300">
                  {chapterCount * estLinesPerChapter}
                </span>{" "}
                total lines
              </div>
              <div>
                ~<span className="font-semibold text-zinc-300">
                  {estMinutes}
                </span>{" "}
                min video
              </div>
              <div>
                +<span className="font-semibold text-zinc-300">1</span> API
                call per chapter
              </div>
            </div>
          )}
          {!value && (
            <div className="mt-1.5 text-[11px] italic text-zinc-500">
              Off → standard bulk mode: each chapter auto-downloads as its own
              ZIP, full panel-by-panel narration.
            </div>
          )}
        </div>
      </label>
    </div>
  );
}

function MasterBibleCard({
  bible,
  onReset,
}: {
  bible: MasterBible;
  onReset: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const charCount = Object.keys(bible.characters).length;
  const empty = bible.chapterCount === 0;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">
            Master bible
          </span>
          {empty ? (
            <span className="text-xs text-zinc-500">(empty — first run)</span>
          ) : (
            <span className="text-xs text-zinc-500">
              {charCount} character{charCount === 1 ? "" : "s"} •{" "}
              {bible.chapterCount} chapter
              {bible.chapterCount === 1 ? "" : "s"} processed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!empty && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              {expanded ? "Hide" : "View"}
            </button>
          )}
          {!empty && (
            <button
              type="button"
              onClick={onReset}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-red-400"
            >
              <Trash2 className="h-3 w-3" />
              Reset
            </button>
          )}
        </div>
      </div>
      {empty && (
        <div className="px-4 py-3 text-xs text-zinc-500">
          No characters yet. The master bible builds up automatically as
          each chapter is processed, and is shared across every future
          chapter in the queue so the narrator stays consistent.
        </div>
      )}
      {!empty && expanded && (
        <div className="space-y-2 px-4 py-3 text-sm">
          {Object.entries(bible.characters).map(([name, desc]) => (
            <div key={name}>
              <span className="font-semibold text-zinc-200">{name}</span>
              <span className="text-zinc-400"> — {desc}</span>
            </div>
          ))}
          {bible.uncertain.length > 0 && (
            <div className="space-y-0.5 pt-2 text-xs text-zinc-500">
              <div className="font-medium text-zinc-600">
                Unnamed characters:
              </div>
              {bible.uncertain.map((u, i) => (
                <div key={i}>• {u}</div>
              ))}
            </div>
          )}
          {bible.premise && (
            <div className="pt-2 text-xs italic text-zinc-500">
              {bible.premise}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BulkSummary({
  stats,
  elapsedMs,
  busy,
}: {
  stats: { done: number; failed: number; pending: number; total: number };
  elapsedMs: number | null;
  busy: boolean;
}) {
  const remaining = stats.total - stats.done - stats.failed;
  const pct = stats.total > 0 ? ((stats.done + stats.failed) / stats.total) * 100 : 0;
  const avgPerDoneSec =
    elapsedMs && stats.done > 0 ? elapsedMs / 1000 / stats.done : null;
  const etaSec = avgPerDoneSec && remaining > 0 ? avgPerDoneSec * remaining : null;

  return (
    <div className="space-y-2 rounded border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
        <Stat label="done" value={stats.done} tone="emerald" />
        <Stat label="failed" value={stats.failed} tone="red" />
        <Stat label="remaining" value={remaining} tone="zinc" />
        <Stat label="total" value={stats.total} tone="zinc" />
        {elapsedMs != null && (
          <div className="ml-auto text-xs text-zinc-500">
            elapsed {formatDuration(elapsedMs / 1000)}
            {etaSec != null &&
              busy &&
              ` • ETA ~${formatDuration(etaSec)}`}
          </div>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-zinc-800">
        <div
          className="h-full bg-emerald-500 transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "red" | "zinc";
}) {
  const colour =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "red"
        ? "text-red-400"
        : "text-zinc-200";
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-base font-semibold ${colour}`}>{value}</span>
      <span className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
    </div>
  );
}

function ProgressLine({
  progress,
  fileName,
}: {
  progress: BulkProgressUpdate;
  fileName: string | undefined;
}) {
  const pct = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;
  return (
    <div className="mt-3 flex items-center gap-3 rounded border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-blue-400" />
      <div className="flex-1">
        <div className="text-sm">
          {progress.message}
          {fileName && (
            <>
              {" "}
              <span className="text-zinc-500">— {fileName}</span>
            </>
          )}
        </div>
        {progress.total > 0 && (
          <>
            <div className="mt-1.5 h-1 overflow-hidden rounded bg-zinc-800">
              <div
                className="h-full bg-blue-500 transition-all duration-150"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {progress.current} / {progress.total} ({Math.round(pct)}%)
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QueueList({
  items,
  progressByItem,
  busy,
  onRemove,
}: {
  items: QueueItem[];
  progressByItem: Map<number, BulkProgressUpdate>;
  busy: boolean;
  onRemove: (idx: number) => void;
}) {
  return (
    <ol className="mt-3 space-y-1">
      {items.map((item, idx) => {
        const itemProgress = progressByItem.get(idx);
        const isActive = busy && item.status === "processing";
        return (
          <li
            key={`${item.file.name}-${idx}`}
            className={clsx(
              "rounded border px-3 py-2 text-sm",
              isActive
                ? "border-blue-700/60 bg-blue-950/30"
                : item.status === "done"
                  ? "border-emerald-900/60 bg-emerald-950/20"
                  : item.status === "failed"
                    ? "border-red-900/60 bg-red-950/20"
                    : "border-zinc-800 bg-zinc-900/30",
            )}
          >
            <div className="flex items-center gap-3">
              <StatusIcon status={item.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-xs text-zinc-200">
                    {item.file.name}
                  </span>
                  {isActive && itemProgress && (
                    <span className="rounded bg-blue-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-blue-300">
                      {stageLabel(itemProgress.stage)}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {describeItemRow(item, itemProgress)}
                </div>
              </div>
              {!busy && item.status !== "done" && (
                <button
                  type="button"
                  onClick={() => onRemove(idx)}
                  className="text-zinc-500 hover:text-red-400"
                  aria-label="Remove from queue"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {/* Per-item progress bar — fills only when a percent is
                meaningful (extract, classify batches, polish chunks).
                For single Gemini calls (3A/3B/bible/polish) the call
                doesn't expose granularity, so we show an indeterminate
                shimmer instead. */}
            {isActive && itemProgress && (
              <PerItemProgressBar progress={itemProgress} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PerItemProgressBar({ progress }: { progress: BulkProgressUpdate }) {
  const hasPercent = progress.total > 0 && progress.current >= 0;
  if (hasPercent) {
    const pct = Math.min(100, (progress.current / progress.total) * 100);
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-blue-500 transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-[10px] tabular-nums text-zinc-500">
          {progress.current}/{progress.total}
        </span>
      </div>
    );
  }
  // Indeterminate shimmer — Gemini call in flight, no granular signal.
  return (
    <div className="mt-1.5 h-1 overflow-hidden rounded bg-zinc-800">
      <div className="h-full w-1/3 animate-pulse rounded bg-blue-500/60" />
    </div>
  );
}

function StatusIcon({
  status,
}: {
  status: QueueItem["status"];
}) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "processing":
      return <Loader2 className="h-4 w-4 animate-spin text-blue-400" />;
    default:
      return <CircleDot className="h-4 w-4 text-zinc-600" />;
  }
}

/** User-friendly label for each pipeline stage. */
function stageLabel(stage: PipelineStage): string {
  switch (stage) {
    case "extracting":
      return "Extract";
    case "filtering":
      return "Filter";
    case "bible":
      return "Bible";
    case "curating":
      return "Curate";
    case "narrating":
      return "Narrate";
    case "polishing":
      return "Polish";
    case "structural":
      return "Structure";
    case "accuracy":
      return "Verify";
    case "bridging":
      return "Bridge";
    case "combining":
      return "Combine";
    case "packaging":
      return "Package";
    case "done":
      return "Done";
    case "idle":
      return "Idle";
  }
}

function describeItemRow(
  item: QueueItem,
  itemProgress: BulkProgressUpdate | undefined,
): string {
  if (item.status === "done") {
    const dur =
      item.startedAt && item.finishedAt
        ? ` • ${formatDuration((item.finishedAt - item.startedAt) / 1000)}`
        : "";
    return `done — ${item.keptCount ?? "?"} panels, ${item.lineCount ?? "?"} lines${dur}`;
  }
  if (item.status === "failed") {
    return `failed — ${item.error ?? "unknown error"}`;
  }
  if (itemProgress) {
    return itemProgress.message;
  }
  if (item.status === "processing") {
    return item.stage ? `Starting ${stageLabel(item.stage).toLowerCase()}…` : "Processing…";
  }
  return "queued";
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

