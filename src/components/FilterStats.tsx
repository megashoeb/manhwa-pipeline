import type { FilterStats } from "../types/manhwa";

interface Props {
  stats: FilterStats;
  elapsedMs?: number | null;
}

/**
 * Compact stats strip shown above the filtered image grid.
 *
 * Surfaces the split between "kept" / "blank-dropped" / "duplicate-
 * dropped" so the user can immediately tell whether the filter
 * settings are doing what they expect.
 */
export function FilterStatsView({ stats, elapsedMs }: Props) {
  const dropped = stats.droppedBlank + stats.droppedDuplicate;
  const fillerPct = stats.total > 0 ? (dropped / stats.total) * 100 : 0;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <Stat label="total" value={stats.total} tone="zinc" />
        <Stat label="kept" value={stats.kept} tone="emerald" />
        <Stat label="blank" value={stats.droppedBlank} tone="orange" />
        <Stat label="duplicate" value={stats.droppedDuplicate} tone="purple" />
        {stats.droppedTitlePage != null && stats.droppedTitlePage > 0 && (
          <Stat
            label="title"
            value={stats.droppedTitlePage}
            tone="amber"
          />
        )}
        <Stat
          label="filler"
          value={`${fillerPct.toFixed(1)}%`}
          tone="zinc"
        />
        {elapsedMs != null && (
          <div className="ml-auto text-xs text-zinc-500">
            {(elapsedMs / 1000).toFixed(1)} s
          </div>
        )}
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
  value: number | string;
  tone: "zinc" | "emerald" | "orange" | "purple" | "amber";
}) {
  const colour =
    tone === "emerald"
      ? "text-emerald-400"
      : tone === "orange"
        ? "text-orange-400"
        : tone === "purple"
          ? "text-purple-400"
          : tone === "amber"
            ? "text-amber-400"
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
