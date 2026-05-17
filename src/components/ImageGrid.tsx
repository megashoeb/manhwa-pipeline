import clsx from "clsx";
import type { ExtractedPage, FilteredPage } from "../types/manhwa";

interface Props {
  pages: ExtractedPage[] | FilteredPage[];
}

/**
 * Responsive thumbnail grid that gracefully handles both raw extracted
 * pages and filtered ones. Filtered pages with ``kept=false`` render
 * dimmed with a colour-coded badge explaining why they were dropped.
 *
 * Uses native ``loading="lazy"`` so a 250-page chapter doesn't try to
 * decode every image at once on first render.
 */
export function ImageGrid({ pages }: Props) {
  if (pages.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="text-sm text-zinc-400">
          {pages.length} page{pages.length === 1 ? "" : "s"}
        </div>
        <div className="text-xs text-zinc-600">
          {pages[0]?.width}×{pages[0]?.height} px • JPEG q=0.85
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
        {pages.map((p) => (
          <ThumbCell key={p.index} page={p} />
        ))}
      </div>
    </div>
  );
}

function ThumbCell({ page }: { page: ExtractedPage | FilteredPage }) {
  const isFiltered = "kept" in page;
  const dropped = isFiltered && !page.kept;
  const reason = isFiltered ? page.reason : "";

  const badgeKind = dropped
    ? reason.startsWith("blank")
      ? ("blank" as const)
      : reason.startsWith("title")
        ? ("title" as const)
        : ("dup" as const)
    : ("kept" as const);

  return (
    <div
      className={clsx(
        "group relative overflow-hidden rounded border bg-zinc-900 transition",
        dropped
          ? "border-zinc-900/70 opacity-40 hover:opacity-90"
          : "border-zinc-800",
      )}
      title={isFiltered ? `page ${page.index} — ${reason}` : undefined}
    >
      <img
        src={page.url}
        alt={`Page ${page.index}`}
        loading="lazy"
        className="aspect-[3/4] w-full object-cover"
      />

      {/* Bottom gradient with page number */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2 pb-1.5 pt-3 text-[11px] font-medium text-white">
        page {String(page.index).padStart(3, "0")}
      </div>

      {/* Top-left status badge (only on filtered pages) */}
      {isFiltered && (
        <div
          className={clsx(
            "pointer-events-none absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            badgeKind === "blank" && "bg-orange-600/90 text-white",
            badgeKind === "dup" && "bg-purple-600/90 text-white",
            badgeKind === "title" && "bg-amber-500/90 text-white",
            badgeKind === "kept" && "bg-emerald-600/80 text-white",
          )}
        >
          {badgeKind === "blank"
            ? "blank"
            : badgeKind === "dup"
              ? "duplicate"
              : badgeKind === "title"
                ? "title"
                : "kept"}
        </div>
      )}
    </div>
  );
}
