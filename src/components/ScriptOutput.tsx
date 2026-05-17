import { useState } from "react";
import {
  Download,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Package,
} from "lucide-react";
import clsx from "clsx";

import type {
  FilteredPage,
  FilterStats,
  ScriptResult,
} from "../types/manhwa";
import { downloadFullOutputs } from "../core/downloads";

interface Props {
  result: ScriptResult;
  filename: string | null;
  /** Filtered pages and stats — when both are present, enable the
   *  "Download all (ZIP)" button that bundles images + script + bible. */
  filteredPages?: FilteredPage[];
  filterStats?: FilterStats;
}

/**
 * Renders the finished script with:
 *  - a stats strip (line count, characters detected)
 *  - per-scene collapsible blocks showing which panels became which lines
 *  - download buttons for script .txt, bible .json, AND the full ZIP
 *    bundle (images + script + bible + manifest + README) when the
 *    filter result is available.
 *  - a one-click "copy script to clipboard" button for fast paste into
 *    the MegaShoeb TTS server
 */
export function ScriptOutput({
  result,
  filename,
  filteredPages,
  filterStats,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(result.scriptText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked; fall back to plain download */
    }
  }

  function download(name: string, mime: string, data: string) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function downloadEverything() {
    if (!filteredPages || !filterStats) return;
    setBusy(true);
    setZipProgress({ current: 0, total: 0 });
    try {
      await downloadFullOutputs(
        filteredPages,
        result,
        filterStats,
        filename,
        (current, total) => setZipProgress({ current, total }),
      );
    } finally {
      setBusy(false);
      setZipProgress(null);
    }
  }

  const baseName = (filename ?? "chapter").replace(/\.pdf$/i, "");
  const characterCount = Object.keys(result.bible.characters).length;
  const canDownloadAll = filteredPages != null && filterStats != null;

  return (
    <div className="space-y-4">
      {/* Stats strip */}
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm">
        <Stat label="lines" value={result.lines.length} />
        <Stat label="scenes" value={result.scenes.length} />
        <Stat label="characters" value={characterCount} />
        {result.bible.tone && (
          <span className="text-xs italic text-zinc-500">
            {result.bible.tone}
          </span>
        )}
      </div>

      {/* Character bible preview */}
      {characterCount > 0 && (
        <div className="rounded border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Character bible
          </div>
          <div className="space-y-1 text-sm">
            {Object.entries(result.bible.characters).map(([name, desc]) => (
              <div key={name}>
                <span className="font-semibold text-zinc-200">{name}</span>
                <span className="text-zinc-400"> — {desc}</span>
              </div>
            ))}
          </div>
          {result.bible.uncertain?.length > 0 && (
            <div className="mt-2 space-y-0.5 text-xs text-zinc-500">
              <div className="font-medium text-zinc-600">
                Unnamed characters:
              </div>
              {result.bible.uncertain.map((u, i) => (
                <div key={i}>• {u}</div>
              ))}
            </div>
          )}
          {result.bible.premise && (
            <div className="mt-2 text-xs italic text-zinc-500">
              {result.bible.premise}
            </div>
          )}
        </div>
      )}

      {/* Download / copy row */}
      <div className="flex flex-wrap items-center gap-2">
        {canDownloadAll && (
          <button
            type="button"
            onClick={downloadEverything}
            disabled={busy}
            className={clsx(
              "flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-semibold text-white transition",
              busy
                ? "cursor-not-allowed bg-zinc-700"
                : "bg-emerald-600 hover:bg-emerald-500",
            )}
            title="Bundle images + script + bible + manifest + README into one ZIP"
          >
            <Package className="h-3.5 w-3.5" />
            {busy
              ? zipProgress
                ? `Zipping ${zipProgress.current}/${zipProgress.total}…`
                : "Zipping…"
              : "Download everything (ZIP)"}
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            download(`${baseName}_script.txt`, "text/plain", result.scriptText)
          }
          className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          <Download className="h-3.5 w-3.5" />
          script.txt
        </button>
        <button
          type="button"
          onClick={() =>
            download(
              `${baseName}_bible.json`,
              "application/json",
              JSON.stringify(result.bible, null, 2),
            )
          }
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          <Download className="h-3.5 w-3.5" />
          bible.json
        </button>
        <button
          type="button"
          onClick={copyScript}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy script
            </>
          )}
        </button>
        <button
          type="button"
          onClick={() => setAllOpen((v) => !v)}
          className="ml-auto text-xs text-zinc-400 hover:text-zinc-200"
        >
          {allOpen ? "Collapse all scenes" : "Expand all scenes"}
        </button>
      </div>

      {/* Scene blocks */}
      <div className="space-y-2">
        {result.scenes.map((scene) => (
          <SceneBlock key={scene.sceneIndex} scene={scene} forceOpen={allOpen} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-base font-semibold text-zinc-200">{value}</span>
      <span className="text-xs uppercase tracking-wide text-zinc-500">
        {label}
      </span>
    </div>
  );
}

function SceneBlock({
  scene,
  forceOpen,
}: {
  scene: {
    sceneIndex: number;
    panelIndices: number[];
    lines: string[];
  };
  forceOpen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const effectivelyOpen = forceOpen || open;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-zinc-900/60"
      >
        <div className="flex items-center gap-2 text-sm">
          {effectivelyOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
          )}
          <span className="font-medium text-zinc-200">
            Scene {scene.sceneIndex + 1}
          </span>
          <span className="text-xs text-zinc-500">
            panels {scene.panelIndices[0]}–
            {scene.panelIndices[scene.panelIndices.length - 1]} •{" "}
            {scene.lines.length} lines
          </span>
        </div>
      </button>
      {effectivelyOpen && (
        <ol className="space-y-1.5 px-4 pb-3 pt-1 text-sm">
          {scene.lines.map((line, i) => (
            <li key={i} className="flex gap-2">
              <span className="w-8 select-none font-mono text-xs text-zinc-600">
                {String(scene.panelIndices[i] ?? i + 1).padStart(3, "0")}
              </span>
              <span className="text-zinc-200">{line}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
