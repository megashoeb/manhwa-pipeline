import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  AlertCircle,
  Sparkles,
  Download,
  FileText,
  Files,
  Mic,
  Wand2,
} from "lucide-react";
import clsx from "clsx";

import { PdfUploader } from "./components/PdfUploader";
import { ImageGrid } from "./components/ImageGrid";
import { FilterStatsView } from "./components/FilterStats";
import { FilterSettingsPanel } from "./components/FilterSettings";
import { ApiKeyManager } from "./components/ApiKeyManager";
import { ScriptOutput } from "./components/ScriptOutput";
import { BulkMode } from "./components/BulkMode";
import { PolishMode } from "./components/PolishMode";
import { TtsMode } from "./components/TtsMode";
import { DebugPanel } from "./components/DebugPanel";

import {
  extractPdfPages,
  revokeExtractedPages,
} from "./core/pdfToImages";
import {
  runFilterPipeline,
  revokeFilterResult,
} from "./core/filterPipeline";
import { KeyRotator } from "./core/keyRotator";
import {
  generateScript,
  applyTitlePageExclusions,
} from "./core/scriptPipeline";
import { downloadKeptImagesZip } from "./core/downloads";

import {
  DEFAULT_FILTER_SETTINGS,
  type ExtractedPage,
  type FilterResult,
  type FilterSettings,
  type ScriptResult,
} from "./types/manhwa";

interface Progress {
  current: number;
  total: number;
  label: string;
}

const GEMINI_MODEL = "gemini-3.1-flash-lite";

type AppMode = "single" | "bulk" | "polish" | "tts";

function App() {
  // One KeyRotator instance for the lifetime of the app, persisted to localStorage.
  const rotator = useMemo(() => new KeyRotator(), []);
  const [mode, setMode] = useState<AppMode>("single");

  // ---- extracted + filtered pages ---------------------------------
  const [pages, setPages] = useState<ExtractedPage[]>([]);
  const [filename, setFilename] = useState<string | null>(null);
  const [extractMs, setExtractMs] = useState<number | null>(null);

  const [settings, setSettings] = useState<FilterSettings>(
    DEFAULT_FILTER_SETTINGS,
  );
  const [appliedSettings, setAppliedSettings] = useState<FilterSettings | null>(
    null,
  );
  const [filterResult, setFilterResult] = useState<FilterResult | null>(null);
  const [filterMs, setFilterMs] = useState<number | null>(null);

  // ---- script ------------------------------------------------------
  const [scriptResult, setScriptResult] = useState<ScriptResult | null>(null);
  const [scriptMs, setScriptMs] = useState<number | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);

  // ---- shared UI state --------------------------------------------
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-render when localStorage key list changes (so the "Generate" button
  // un-disables right when the first key is added).
  const [, forceKeyRender] = useState(0);
  useEffect(
    () => rotator.subscribe(() => forceKeyRender((n) => n + 1)),
    [rotator],
  );

  const pagesRef = useRef(pages);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  const dirty =
    appliedSettings !== null &&
    JSON.stringify(appliedSettings) !== JSON.stringify(settings);

  const hasAnyKey =
    rotator.list().filter((k) => k.enabled && k.value.trim()).length > 0;
  const keptCount = filterResult?.stats.kept ?? 0;

  // ---- handlers ----------------------------------------------------

  const handleFile = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setFilename(file.name);
    setExtractMs(null);
    setFilterMs(null);
    setScriptMs(null);
    setScriptResult(null);
    setProgress({ current: 0, total: 0, label: "Reading PDF" });

    // Free anything from a previous run before allocating new memory.
    revokeFilterResult(filterResult);
    setFilterResult(null);
    setAppliedSettings(null);

    revokeExtractedPages(pagesRef.current);
    setPages([]);

    const t0 = performance.now();
    try {
      const extracted = await extractPdfPages(file, {
        scale: 2.0,
        quality: 0.85,
        onProgress: (current, total) =>
          setProgress({ current, total, label: "Extracting page" }),
      });
      setPages(extracted);
      setExtractMs(performance.now() - t0);
      await runFilter(extracted, settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runFilter(srcPages: ExtractedPage[], current: FilterSettings) {
    if (srcPages.length === 0) return;
    setBusy(true);
    setError(null);
    setProgress({ current: 0, total: srcPages.length, label: "Filtering" });

    revokeFilterResult(filterResult);
    setFilterResult(null);
    setScriptResult(null);

    const t0 = performance.now();
    try {
      const result = await runFilterPipeline(srcPages, current, (c, t, msg) =>
        setProgress({ current: c, total: t, label: msg }),
      );
      setFilterResult(result);
      setAppliedSettings(current);
      setFilterMs(performance.now() - t0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const handleApplyFilter = useCallback(() => {
    if (busy) return;
    runFilter(pagesRef.current, settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, busy]);

  const handleDownloadImages = useCallback(async () => {
    if (!filterResult || busy) return;
    setBusy(true);
    setError(null);
    setProgress({
      current: 0,
      total: filterResult.stats.kept,
      label: "Zipping images",
    });
    try {
      await downloadKeptImagesZip(
        filterResult.pages,
        filename,
        (current, total) =>
          setProgress({ current, total, label: "Zipping images" }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [filterResult, busy, filename]);

  const handleGenerateScript = useCallback(async () => {
    if (!filterResult || !hasAnyKey || busy) return;
    setBusy(true);
    setError(null);
    setScriptMs(null);
    setScriptResult(null);
    setCurrentKey(null);

    const t0 = performance.now();
    try {
      const result = await generateScript(filterResult.pages, {
        model: GEMINI_MODEL,
        rotator,
        onProgress: (stage, current, total, msg) => {
          setProgress({
            current,
            total,
            label: stage === "bible" ? "Character bible" : msg,
          });
        },
        onKeyUsed: (m) => setCurrentKey(m),
      });
      setScriptResult(result);
      setScriptMs(performance.now() - t0);

      // Update the filter result so AI-flagged title / credits pages
      // show up as dropped in the grid and disappear from any future
      // ZIP downloads. (downloadKeptImagesZip only includes kept=true.)
      if (result.titlePageIndices.length > 0) {
        setFilterResult((prev) =>
          prev ? applyTitlePageExclusions(prev, result.titlePageIndices) : prev,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress(null);
      setCurrentKey(null);
    }
  }, [filterResult, hasAnyKey, busy, rotator]);

  // ---- render ------------------------------------------------------

  return (
    <div className="min-h-screen">
      <Header />

      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <ModeToggle mode={mode} onChange={setMode} disabled={busy} />

        {mode === "bulk" ? (
          <BulkMode rotator={rotator} />
        ) : mode === "polish" ? (
          <PolishMode rotator={rotator} />
        ) : mode === "tts" ? (
          <TtsMode />
        ) : (
          <SingleModeContent
            pages={pages}
            filename={filename}
            extractMs={extractMs}
            settings={settings}
            setSettings={setSettings}
            filterResult={filterResult}
            filterMs={filterMs}
            scriptResult={scriptResult}
            scriptMs={scriptMs}
            busy={busy}
            progress={progress}
            error={error}
            currentKey={currentKey}
            hasAnyKey={hasAnyKey}
            keptCount={keptCount}
            dirty={dirty}
            rotator={rotator}
            handleFile={handleFile}
            handleApplyFilter={handleApplyFilter}
            handleDownloadImages={handleDownloadImages}
            handleGenerateScript={handleGenerateScript}
          />
        )}
      </main>

      <Footer />
      <DebugPanel />
    </div>
  );
}

// Keeping the single-mode JSX unchanged but wrapped in a sub-component
// so the BulkMode branch sits as a clean sibling.
function SingleModeContent({
  pages,
  filename,
  extractMs,
  settings,
  setSettings,
  filterResult,
  filterMs,
  scriptResult,
  scriptMs,
  busy,
  progress,
  error,
  currentKey,
  hasAnyKey,
  keptCount,
  dirty,
  rotator,
  handleFile,
  handleApplyFilter,
  handleDownloadImages,
  handleGenerateScript,
}: {
  pages: ExtractedPage[];
  filename: string | null;
  extractMs: number | null;
  settings: FilterSettings;
  setSettings: (s: FilterSettings) => void;
  filterResult: FilterResult | null;
  filterMs: number | null;
  scriptResult: ScriptResult | null;
  scriptMs: number | null;
  busy: boolean;
  progress: Progress | null;
  error: string | null;
  currentKey: string | null;
  hasAnyKey: boolean;
  keptCount: number;
  dirty: boolean;
  rotator: KeyRotator;
  handleFile: (file: File) => Promise<void>;
  handleApplyFilter: () => void;
  handleDownloadImages: () => Promise<void>;
  handleGenerateScript: () => Promise<void>;
}) {
  return (
    <>
      <Section title="Step 1 — Upload chapter PDF">
        <PdfUploader onFileSelected={handleFile} disabled={busy} />
      </Section>

        {pages.length > 0 && (
          <Section title="Step 2 — Filter settings (optional)">
            <FilterSettingsPanel
              settings={settings}
              onChange={setSettings}
              onApply={handleApplyFilter}
              busy={busy}
              dirty={dirty}
            />
          </Section>
        )}

        {error && (
          <div className="flex items-start gap-3 rounded border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              <div className="font-medium">Something went wrong</div>
              <div className="mt-1 text-red-400/80">{error}</div>
            </div>
          </div>
        )}

        {busy && progress && (
          <ProgressBlock
            filename={filename}
            progress={progress}
            currentKey={currentKey}
          />
        )}

        {filterResult && !busy && (
          <Section title="Filtered pages">
            <div className="mb-2 text-xs text-zinc-500">
              {filename}
              {extractMs && ` • extracted in ${(extractMs / 1000).toFixed(1)}s`}
            </div>
            <FilterStatsView stats={filterResult.stats} elapsedMs={filterMs} />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleDownloadImages}
                disabled={busy || filterResult.stats.kept === 0}
                className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
              >
                <Download className="h-3.5 w-3.5" />
                Download {filterResult.stats.kept} images (ZIP)
              </button>
              <span className="text-xs text-zinc-500">
                Renamed sequentially{" "}
                <code className="font-mono">0001.jpg</code> →{" "}
                <code className="font-mono">
                  {String(filterResult.stats.kept).padStart(4, "0")}.jpg
                </code>{" "}
                for CapCut auto-sync.
              </span>
            </div>

            <div className="h-3" />
            <ImageGrid pages={filterResult.pages} />
          </Section>
        )}

        {filterResult && (
          <Section title="Step 3 — API keys (one-time setup)">
            <ApiKeyManager rotator={rotator} />
          </Section>
        )}

        {filterResult && (
          <Section title="Step 4 — Generate narration script">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleGenerateScript}
                disabled={busy || !hasAnyKey || keptCount === 0}
                className="flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                <Sparkles className="h-4 w-4" />
                {scriptResult
                  ? "Regenerate script"
                  : `Generate script (${keptCount} panels)`}
              </button>
              {!hasAnyKey && (
                <span className="text-xs text-zinc-500">
                  Add at least one API key above to enable.
                </span>
              )}
              {scriptMs != null && scriptResult && (
                <span className="ml-auto text-xs text-zinc-500">
                  finished in {(scriptMs / 1000).toFixed(1)}s
                </span>
              )}
            </div>
          </Section>
        )}

        {scriptResult && !busy && (
          <Section title="Generated script">
            <ScriptOutput
              result={scriptResult}
              filename={filename}
              filteredPages={filterResult?.pages}
              filterStats={filterResult?.stats}
            />
          </Section>
        )}

      {!busy && pages.length === 0 && !error && <EmptyState />}
    </>
  );
}

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: AppMode;
  onChange: (m: AppMode) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-1">
      <ModeButton
        active={mode === "single"}
        onClick={() => !disabled && onChange("single")}
        icon={<FileText className="h-3.5 w-3.5" />}
        label="Single chapter"
        hint="Drop one PDF, review previews, generate script"
        disabled={disabled}
      />
      <ModeButton
        active={mode === "bulk"}
        onClick={() => !disabled && onChange("bulk")}
        icon={<Files className="h-3.5 w-3.5" />}
        label="Bulk queue"
        hint="Drop many PDFs, auto-download each chapter, master bible"
        disabled={disabled}
      />
      <ModeButton
        active={mode === "polish"}
        onClick={() => !disabled && onChange("polish")}
        icon={<Wand2 className="h-3.5 w-3.5" />}
        label="Polish"
        hint="Paste a script, choose a model, get a polished rewrite (Gemini / Claude Sonnet 4.6)"
        disabled={disabled}
      />
      <ModeButton
        active={mode === "tts"}
        onClick={() => !disabled && onChange("tts")}
        icon={<Mic className="h-3.5 w-3.5" />}
        label="TTS"
        hint="Paste a script, get stitched MP3 + SRT via ai33.pro voices"
        disabled={disabled}
      />
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled && !active}
      title={hint}
      className={clsx(
        "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition",
        active
          ? "bg-blue-600 text-white"
          : disabled
            ? "cursor-not-allowed text-zinc-600"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
      )}
    >
      {icon}
      <span className="font-medium">{label}</span>
    </button>
  );
}

function Header() {
  return (
    <header className="border-b border-zinc-800 bg-zinc-900/40 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-xl">📚</div>
          <div>
            <div className="text-base font-semibold leading-tight">
              Manhwa Pipeline
            </div>
            <div className="text-[11px] text-zinc-500">
              browser-side script generation • v0.5.0
            </div>
          </div>
        </div>
        <div className="hidden text-xs text-zinc-500 sm:block">
          All processing stays on your device.
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-12 border-t border-zinc-800 bg-zinc-900/20 px-4 py-4 text-center text-xs text-zinc-600">
      v0.5.0 — single + bulk modes with master bible. Vercel deploy next.
    </footer>
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

function ProgressBlock({
  filename,
  progress,
  currentKey,
}: {
  filename: string | null;
  progress: Progress;
  currentKey: string | null;
}) {
  const pct = progress.total > 0 ? progress.current / progress.total : 0;
  return (
    <div className="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin text-blue-400" />
      <div className="flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-sm">
            {progress.label}
            {filename && (
              <>
                {" "}
                <span className="font-medium text-zinc-200">{filename}</span>
              </>
            )}
            …
          </div>
          {currentKey && (
            <code className="rounded bg-zinc-950 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
              key {currentKey}
            </code>
          )}
        </div>
        {progress.total > 0 && (
          <>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-zinc-800">
              <div
                className="h-full bg-blue-500 transition-all duration-150"
                style={{ width: `${pct * 100}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              {progress.current} of {progress.total} ({Math.round(pct * 100)}%)
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded border border-zinc-900 bg-zinc-900/30 px-4 py-6 text-center text-sm text-zinc-500">
      <div className="mb-1 text-zinc-400">Nothing extracted yet</div>
      <div className="text-xs">
        Drop a chapter PDF above. Pages will appear as thumbnails, with
        filler / blank pages auto-detected. Then add API keys to generate
        the narration script.
      </div>
    </div>
  );
}

export default App;
