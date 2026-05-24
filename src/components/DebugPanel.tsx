// Live debug panel — fixed bottom-right of the app.
//
// Toggle button is always visible. Clicking opens a slide-up panel
// showing:
//   • Live event stream from the debugLog ring buffer
//   • Filter chips (errors only / parse / API / all)
//   • Per-stage timing breakdown
//   • Bottleneck analysis with concrete "make it faster" suggestion
//   • Current in-flight count
//
// Even when the toggle is OFF, the ring buffer keeps capturing events,
// so flipping it ON shows the recent history (last 500 events) of
// whatever was happening. Useful for "I clicked Generate, it errored,
// what actually happened?" workflows.

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  Activity,
  AlertTriangle,
  Bug,
  Eraser,
  X,
  Zap,
} from "lucide-react";

import {
  computePerfInsight,
  debugLog,
  type DebugEvent,
  type DebugEventType,
} from "../core/debugLog";

type Filter = "all" | "errors" | "api" | "parse" | "stage";

export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(debugLog.enabled);
  const [filter, setFilter] = useState<Filter>("all");
  const [, forceRender] = useState(0);

  // Re-render whenever the debugLog emits.
  useEffect(() => {
    return debugLog.subscribe(() => forceRender((n) => n + 1));
  }, []);

  const allEvents = debugLog.list();
  const filtered = useMemo(() => filterEvents(allEvents, filter), [
    allEvents,
    filter,
  ]);

  const insight = useMemo(() => computePerfInsight(), [allEvents.length]);

  const stageRows = useMemo(() => {
    const rows = Array.from(debugLog.stageTotals.entries())
      .map(([label, s]) => ({
        label,
        count: s.count,
        avgMs: s.totalMs / s.count,
        totalMs: s.totalMs,
        maxMs: s.maxMs,
      }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 12);
    return rows;
  }, [allEvents.length]);

  const inFlightCount = debugLog.inFlight.size;
  const errorCount = allEvents.filter(
    (e) => e.type === "api-error" || e.type === "parse-fail" || e.type === "error",
  ).length;

  return (
    <>
      {/* Floating toggle button — always visible bottom-right */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "fixed bottom-4 right-4 z-50 flex h-11 items-center gap-2 rounded-full border px-3 text-xs font-medium shadow-lg transition",
          enabled
            ? "border-amber-500/60 bg-amber-950/80 text-amber-200 hover:bg-amber-900"
            : "border-zinc-700 bg-zinc-900/90 text-zinc-300 hover:bg-zinc-800",
        )}
        title={open ? "Hide debug panel" : "Show debug panel"}
      >
        <Bug className="h-4 w-4" />
        <span className="hidden sm:inline">Debug</span>
        {errorCount > 0 && (
          <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
            {errorCount}
          </span>
        )}
        {inFlightCount > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-blue-300">
            <Activity className="h-3 w-3 animate-pulse" />
            {inFlightCount}
          </span>
        )}
      </button>

      {/* Slide-up panel */}
      {open && (
        <div className="fixed bottom-20 right-4 z-40 flex h-[70vh] w-[min(640px,90vw)] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-950/95 shadow-2xl backdrop-blur">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-3 py-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <Bug className="h-4 w-4 text-amber-400" />
              Debug & Performance
            </div>
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    debugLog.setEnabled(e.target.checked);
                    setEnabled(e.target.checked);
                  }}
                  className="h-3 w-3 accent-amber-500"
                />
                Verbose (mirror to console)
              </label>
              <button
                type="button"
                onClick={() => {
                  debugLog.clear();
                  forceRender((n) => n + 1);
                }}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                title="Clear all events"
              >
                <Eraser className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Perf insight + in-flight */}
          {insight && (
            <div className="border-b border-zinc-800 bg-zinc-900/40 px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] text-amber-300">
                <Zap className="h-3.5 w-3.5" />
                <span className="font-semibold">Bottleneck:</span>{" "}
                <code className="text-zinc-200">{insight.bottleneckStage}</code>
                <span className="text-zinc-500">
                  avg {(insight.bottleneckAvgMs / 1000).toFixed(1)}s
                </span>
              </div>
              <div className="mt-1 text-[11px] text-zinc-400">
                💡 {insight.suggestion}
              </div>
            </div>
          )}

          {/* Stage timing table */}
          {stageRows.length > 0 && (
            <details className="border-b border-zinc-800 bg-zinc-900/30">
              <summary className="cursor-pointer px-3 py-1.5 text-[11px] font-semibold text-zinc-400 hover:bg-zinc-900/60">
                Stage timings ({stageRows.length})
              </summary>
              <div className="overflow-x-auto px-3 pb-2 pt-1">
                <table className="w-full text-[10px]">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="text-left">Stage</th>
                      <th className="text-right">N</th>
                      <th className="text-right">Avg</th>
                      <th className="text-right">Max</th>
                      <th className="text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stageRows.map((r) => (
                      <tr
                        key={r.label}
                        className="border-t border-zinc-800/60 text-zinc-300"
                      >
                        <td className="py-1 pr-2 font-mono">{r.label}</td>
                        <td className="py-1 text-right text-zinc-500">
                          {r.count}
                        </td>
                        <td className="py-1 text-right">
                          {(r.avgMs / 1000).toFixed(2)}s
                        </td>
                        <td className="py-1 text-right text-zinc-500">
                          {(r.maxMs / 1000).toFixed(2)}s
                        </td>
                        <td className="py-1 text-right text-zinc-500">
                          {(r.totalMs / 1000).toFixed(1)}s
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* Filter chips */}
          <div className="flex items-center gap-1 border-b border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-[10px]">
            {(["all", "errors", "api", "parse", "stage"] as Filter[]).map(
              (f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={clsx(
                    "rounded px-2 py-0.5",
                    filter === f
                      ? "bg-amber-600 text-white"
                      : "text-zinc-400 hover:bg-zinc-800",
                  )}
                >
                  {f}
                </button>
              ),
            )}
            <span className="ml-auto text-zinc-500">
              {filtered.length} / {allEvents.length}
            </span>
          </div>

          {/* Event stream */}
          <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[10px]">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-zinc-600">
                No events yet. Run something to see live debug output.
              </div>
            ) : (
              filtered
                .slice(-300)
                .reverse()
                .map((ev) => <EventRow key={ev.id} ev={ev} />)
            )}
          </div>
        </div>
      )}
    </>
  );
}

function filterEvents(events: DebugEvent[], filter: Filter): DebugEvent[] {
  if (filter === "all") return events;
  if (filter === "errors") {
    return events.filter(
      (e) =>
        e.type === "api-error" ||
        e.type === "parse-fail" ||
        e.type === "error" ||
        e.type === "warn" ||
        e.type === "retry",
    );
  }
  if (filter === "api") {
    return events.filter(
      (e) =>
        e.type === "api-call" ||
        e.type === "api-success" ||
        e.type === "api-error",
    );
  }
  if (filter === "parse") {
    return events.filter(
      (e) =>
        e.type === "parse-success" ||
        e.type === "parse-repair" ||
        e.type === "parse-fail",
    );
  }
  if (filter === "stage") {
    return events.filter(
      (e) => e.type === "stage-start" || e.type === "stage-end",
    );
  }
  return events;
}

function EventRow({ ev }: { ev: DebugEvent }) {
  const time = new Date(ev.ts).toLocaleTimeString();
  const typeColor = colorForType(ev.type);
  return (
    <div
      className={clsx(
        "mb-0.5 flex gap-2 rounded px-1 py-0.5 hover:bg-zinc-900/60",
        ev.type === "api-error" || ev.type === "parse-fail" || ev.type === "error"
          ? "bg-red-950/30"
          : "",
      )}
    >
      <span className="shrink-0 text-zinc-600">{time.slice(-12)}</span>
      <span className={clsx("shrink-0 w-[88px]", typeColor)}>{ev.type}</span>
      <span className="flex-1 break-words text-zinc-300">
        {ev.label}
        {ev.durationMs != null && (
          <span className="ml-1 text-amber-300">
            ({(ev.durationMs / 1000).toFixed(2)}s)
          </span>
        )}
        {ev.context && Object.keys(ev.context).length > 0 && (
          <span className="ml-1 text-zinc-500">
            {Object.entries(ev.context)
              .slice(0, 4)
              .map(([k, v]) => `${k}=${truncate(String(v), 30)}`)
              .join(" ")}
          </span>
        )}
        {ev.detail && (
          <div className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-900/60 px-1 py-0.5 text-[9px] text-zinc-500">
            {truncate(ev.detail, 500)}
          </div>
        )}
      </span>
      {(ev.type === "api-error" ||
        ev.type === "parse-fail" ||
        ev.type === "error") && (
        <AlertTriangle className="h-3 w-3 shrink-0 text-red-400" />
      )}
    </div>
  );
}

function colorForType(type: DebugEventType): string {
  switch (type) {
    case "api-call":
      return "text-blue-400";
    case "api-success":
      return "text-emerald-400";
    case "api-error":
      return "text-red-400";
    case "parse-success":
      return "text-emerald-500/70";
    case "parse-repair":
      return "text-amber-400";
    case "parse-fail":
      return "text-red-400";
    case "stage-start":
      return "text-zinc-500";
    case "stage-end":
      return "text-zinc-400";
    case "retry":
      return "text-amber-400";
    case "warn":
      return "text-amber-300";
    case "error":
      return "text-red-400";
    case "info":
      return "text-zinc-400";
    default:
      return "text-zinc-400";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
