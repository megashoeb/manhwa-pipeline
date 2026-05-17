import { useState } from "react";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import clsx from "clsx";

import {
  DEFAULT_FILTER_SETTINGS,
  type FilterSettings,
} from "../types/manhwa";

interface Props {
  settings: FilterSettings;
  onChange: (next: FilterSettings) => void;
  onApply: () => void;
  busy?: boolean;
  /** True when the current ``settings`` haven't been applied yet. */
  dirty?: boolean;
}

/**
 * Collapsible settings panel for the filter pipeline.
 *
 * Designed so the user can ignore it entirely — the defaults mirror
 * the Python pipeline's well-tested values. Power users can expand
 * the panel, tweak thresholds, hit "Apply" to re-run the filter.
 */
export function FilterSettingsPanel({
  settings,
  onChange,
  onApply,
  busy,
  dirty,
}: Props) {
  const [open, setOpen] = useState(false);

  const set = <K extends keyof FilterSettings>(
    key: K,
    value: FilterSettings[K],
  ) => onChange({ ...settings, [key]: value });

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-zinc-900/60"
      >
        <div className="flex items-center gap-2 text-sm">
          {open ? (
            <ChevronDown className="h-4 w-4 text-zinc-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-zinc-500" />
          )}
          <span className="font-medium text-zinc-300">Filter settings</span>
          <span className="text-xs text-zinc-600">
            (crop {Math.round(settings.cropTopPct * 100)}% / {Math.round(settings.cropBottomPct * 100)}% • blank stddev&lt;{settings.blankStddev} • dedup ≤{settings.dedupeThreshold})
          </span>
        </div>
        {dirty && (
          <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">
            unsaved
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-5 border-t border-zinc-800 px-4 py-4">
          <Group title="Margin cropping">
            <SliderRow
              label="Crop top"
              suffix={`${(settings.cropTopPct * 100).toFixed(0)}%`}
              min={0}
              max={0.15}
              step={0.01}
              value={settings.cropTopPct}
              onChange={(v) => set("cropTopPct", v)}
              hint="Strip page-header text (date/title from browser-print PDFs)."
            />
            <SliderRow
              label="Crop bottom"
              suffix={`${(settings.cropBottomPct * 100).toFixed(0)}%`}
              min={0}
              max={0.15}
              step={0.01}
              value={settings.cropBottomPct}
              onChange={(v) => set("cropBottomPct", v)}
              hint="Strip page-footer (URL / page number from browser-print PDFs)."
            />
          </Group>

          <Group title="Blank-page detection">
            <SliderRow
              label="Stddev ceiling"
              suffix={settings.blankStddev.toString()}
              min={0}
              max={80}
              step={1}
              value={settings.blankStddev}
              onChange={(v) => set("blankStddev", v)}
              hint="Pages below this grayscale stddev are candidate blanks. 0 = disable blank detection."
            />
            <SliderRow
              label="Mean floor"
              suffix={settings.blankMean.toString()}
              min={200}
              max={255}
              step={1}
              value={settings.blankMean}
              onChange={(v) => set("blankMean", v)}
              hint="Page must ALSO be brighter than this to count as blank — guards real dark panels."
            />
          </Group>

          <Group title="Filler / near-duplicate detection">
            <SliderRow
              label="Hamming threshold"
              suffix={settings.dedupeThreshold.toString()}
              min={0}
              max={20}
              step={1}
              value={settings.dedupeThreshold}
              onChange={(v) => set("dedupeThreshold", v)}
              hint="Max phash bit-difference to call two pages 'the same'. Higher = more aggressive dedup."
            />
            <SliderRow
              label="Lookback"
              suffix={`${settings.dedupeLookback} page${settings.dedupeLookback === 1 ? "" : "s"}`}
              min={1}
              max={10}
              step={1}
              value={settings.dedupeLookback}
              onChange={(v) => set("dedupeLookback", v)}
              hint="Compare each page to the previous N KEPT pages. 1 catches consecutive filler."
            />
          </Group>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              onClick={onApply}
              disabled={busy}
              className={clsx(
                "rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition",
                busy
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-blue-500",
              )}
            >
              {busy ? "Applying…" : dirty ? "Apply changes" : "Re-apply filter"}
            </button>
            <button
              type="button"
              onClick={() => onChange(DEFAULT_FILTER_SETTINGS)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function SliderRow({
  label,
  suffix,
  min,
  max,
  step,
  value,
  onChange,
  hint,
}: {
  label: string;
  suffix: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-zinc-300">{label}</span>
        <span className="font-mono text-zinc-400">{suffix}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-blue-500"
      />
      <div className="mt-0.5 text-[11px] text-zinc-600">{hint}</div>
    </div>
  );
}
