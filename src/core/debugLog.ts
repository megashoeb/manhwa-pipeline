// Global debug event bus.
//
// Captures structured events from every pipeline layer (API calls,
// parse attempts, stage timings, errors) into a ring buffer that the
// DebugPanel UI can render live. Goes through a singleton so any
// module can publish without prop drilling, and React components can
// subscribe via a simple listener pattern.
//
// Why not just console.log? Three reasons:
//   1. Debug panel renders inside the app — no DevTools required.
//   2. Events are STRUCTURED (type, timing, payload), so the panel
//      can show timing charts, filter to errors, etc.
//   3. Always running in the background; user flips toggle to see
//      the recent history (no "you needed to start logging earlier"
//      surprise).

export type DebugEventType =
  | "api-call"
  | "api-success"
  | "api-error"
  | "parse-success"
  | "parse-repair"
  | "parse-fail"
  | "stage-start"
  | "stage-end"
  | "retry"
  | "info"
  | "warn"
  | "error";

export interface DebugEvent {
  id: number;
  ts: number;
  type: DebugEventType;
  /** Short human label. */
  label: string;
  /** Optional milliseconds (set on stage-end / api-success). */
  durationMs?: number;
  /** Provider/model/chapter context, if applicable. */
  context?: Record<string, unknown>;
  /** Free-form detail — truncated raw response, stack trace, etc. */
  detail?: string;
}

const MAX_EVENTS = 500;

class DebugLog {
  private events: DebugEvent[] = [];
  private listeners = new Set<() => void>();
  private nextId = 1;
  /** When false, ``push`` is a near-no-op (we still keep the ring
   *  buffer warm so flipping the toggle shows recent history). */
  enabled = false;
  /** Per-stage cumulative timings — used by the perf panel. */
  stageTotals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  /** Currently in-flight API calls (key = correlation id). */
  inFlight = new Map<number, { label: string; startedAt: number }>();

  push(ev: Omit<DebugEvent, "id" | "ts">): number {
    const id = this.nextId++;
    const fullEv: DebugEvent = { ...ev, id, ts: Date.now() };
    this.events.push(fullEv);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (ev.type === "stage-end" && ev.durationMs != null) {
      const entry = this.stageTotals.get(ev.label) ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
      };
      entry.count++;
      entry.totalMs += ev.durationMs;
      entry.maxMs = Math.max(entry.maxMs, ev.durationMs);
      this.stageTotals.set(ev.label, entry);
    }
    if (this.enabled) {
      this.notify();
      // Mirror to console for users who prefer DevTools.
      const tag = `[debug:${ev.type}]`;
      if (ev.type === "api-error" || ev.type === "parse-fail" || ev.type === "error") {
        console.error(tag, ev.label, ev.context ?? "", ev.detail ?? "");
      } else if (ev.type === "warn" || ev.type === "parse-repair" || ev.type === "retry") {
        console.warn(tag, ev.label, ev.context ?? "");
      } else {
        console.log(tag, ev.label, ev.context ?? "");
      }
    }
    return id;
  }

  /** Helper: open a span on stage-start, returns a fn that closes it. */
  startStage(label: string, context?: Record<string, unknown>): () => void {
    const startedAt = Date.now();
    const id = this.push({ type: "stage-start", label, context });
    this.inFlight.set(id, { label, startedAt });
    return () => {
      this.inFlight.delete(id);
      this.push({
        type: "stage-end",
        label,
        durationMs: Date.now() - startedAt,
        context,
      });
    };
  }

  list(): DebugEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
    this.stageTotals.clear();
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* ignore listener errors */
      }
    }
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    try {
      localStorage.setItem("manhwa.debug.enabled", value ? "1" : "0");
    } catch {
      /* ignore quota errors */
    }
    this.notify();
  }
}

export const debugLog = new DebugLog();

// Hydrate the enabled flag from localStorage so it survives reloads.
// Default is now ON — when the user runs into an issue, the next
// thing they'd do is flip the toggle anyway, and the ring buffer
// keeps capturing in either state. Console mirror cost is negligible.
// User can still flip it OFF via the panel checkbox.
try {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem("manhwa.debug.enabled");
    // First-time visitors (stored === null) get debug ON. Users who
    // explicitly turned it off (stored === "0") keep it off.
    debugLog.enabled = stored === null ? true : stored === "1";
  } else {
    debugLog.enabled = true;
  }
} catch {
  debugLog.enabled = true;
}

// ---- Perf analysis helpers ----------------------------------------

export interface PerfInsight {
  /** Stage label with the highest average duration. */
  bottleneckStage: string | null;
  bottleneckAvgMs: number;
  /** Suggested concurrency bump, e.g. "currently 3 → could try 5". */
  suggestion: string;
  /** Avg time per chapter / line (whichever is being analysed). */
  avgPerUnitMs: number;
}

/**
 * Analyse the captured stage-end events and produce a one-line
 * "your bottleneck is X, try Y" recommendation. Returns null when
 * there isn't enough data yet (< 3 stage-end events).
 */
export function computePerfInsight(): PerfInsight | null {
  const stages = Array.from(debugLog.stageTotals.entries())
    .map(([label, s]) => ({
      label,
      avgMs: s.totalMs / s.count,
      maxMs: s.maxMs,
      count: s.count,
    }))
    .filter((s) => s.count >= 1)
    .sort((a, b) => b.avgMs - a.avgMs);

  if (stages.length === 0) return null;

  const top = stages[0];
  let suggestion = "";
  if (top.avgMs < 1500) {
    suggestion = "Pipeline is already fast — most stages < 1.5s.";
  } else if (top.label.includes("script") || top.label.includes("polish")) {
    suggestion =
      "Script/polish dominates — try a faster model (Qwen-Flash → Qwen3-235B-Instruct) or split prompt into smaller calls.";
  } else if (top.label.includes("extract") || top.label.includes("PDF")) {
    suggestion =
      "PDF extraction dominates — lower the render scale (2.78 → 2.0) for less detail, or pre-compress PDFs.";
  } else if (top.label.includes("curator") || top.label.includes("panel")) {
    suggestion =
      "Panel curator dominates — already parallel at concurrency 4 inside; the outer chapter concurrency may give better gains.";
  } else if (top.label.includes("api-call") || top.label.includes("openrouter") || top.label.includes("gemini")) {
    suggestion =
      "Single API calls are slow — bump chapter concurrency from 3 → 5 to overlap waiting time across chapters.";
  } else {
    suggestion = `Top stage "${top.label}" — investigate.`;
  }

  return {
    bottleneckStage: top.label,
    bottleneckAvgMs: top.avgMs,
    suggestion,
    avgPerUnitMs: top.avgMs,
  };
}
