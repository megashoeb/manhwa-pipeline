// Standalone Polish tab.
//
// User pastes a raw line-by-line manhwa-recap script, optionally adds
// a series name + character bible, picks a channel-modeled style + a
// pacing preset, and gets back a fully polished rewrite that:
//   - Preserves line count exactly (1:1 panel sync)
//   - Applies the "senior YouTube editor" prompt (see manualPolisher.ts)
//   - Routes through the chosen model (Gemini variants or Claude Sonnet 4.6)
//
// The prompt embeds ALL the channel-modeled style rules, audience
// psychology, cohesion tests, AI-tell elimination, retention engineering,
// TTS optimization, and a self-check protocol.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Loader2,
  Download,
  Copy,
  Check,
  AlertCircle,
  Info,
} from "lucide-react";
import clsx from "clsx";

import { ApiKeyManager } from "./ApiKeyManager";
import type { KeyRotator } from "../core/keyRotator";
import {
  polishScriptManual,
  POLISH_CONTEXT_TEMPLATE,
  extractCharacterNamesFromScript,
  buildAutoDetectHintsBlock,
  type ChannelStyle,
  type PacingPreset,
  type ManualPolishResult,
} from "../core/manualPolisher";

// ============================================================
// Model catalogue (per-1M-token USD prices)
// ============================================================

interface ModelOption {
  id: string;
  label: string;
  inputPerM: number;
  outputPerM: number;
  note: string;
  requiresOpenRouter?: boolean;
}

const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    inputPerM: 0.1,
    outputPerM: 0.4,
    note: "Cheapest. OK quality. Default.",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    inputPerM: 0.3,
    outputPerM: 2.5,
    note: "5× cost. Better rule-following.",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    inputPerM: 1.25,
    outputPerM: 10.0,
    note: "20× cost. Very good adjective variety.",
  },
  {
    id: "claude-sonnet-4.6",
    label: "Claude Sonnet 4.6 ★ (premium)",
    inputPerM: 3.0,
    outputPerM: 15.0,
    note: "30× cost. Best prose + rule adherence.",
    requiresOpenRouter: true,
  },
];

// ============================================================
// Channel-modeled style catalogue (UI-friendly metadata)
// ============================================================

const STYLE_OPTIONS: {
  id: ChannelStyle;
  label: string;
  short: string;
  useFor: string;
}[] = [
  {
    id: "STORIXA-BALANCED",
    label: "Storixa Balanced (default)",
    short: "Clean narrative, mid-paced, monetized winner",
    useFor: "Most chapters, standard underdog arcs, F-rank → SSS",
  },
  {
    id: "MANHWA-APEX-CINEMATIC",
    label: "Manhwa Apex — Cinematic",
    short: "Epic gravitas, slower deliberate pacing",
    useFor: "Mega-recaps, final climaxes, lineage reveals",
  },
  {
    id: "ANIBULLY-PUNCHY",
    label: "AniBully — Punchy",
    short: "Fast pace, momentum-driven, action verbs front-loaded",
    useFor: "Fight-heavy chapters, tournament arcs, chase scenes",
  },
  {
    id: "BIGCAT-DRAMATIC",
    label: "BigCat — Dramatic",
    short: "Character-voice prominent, em-dashes, dramatic stakes",
    useFor: "Character intros, romance, regression realizations",
  },
  {
    id: "MOON-SHADOW-ATMOSPHERIC",
    label: "Moon Shadow — Atmospheric",
    short: "Sensory, immersive, slow-burn intensity",
    useFor: "World-building, mystery setups, mega-recap binge",
  },
];

const PACING_OPTIONS: {
  id: PacingPreset;
  label: string;
  desc: string;
}[] = [
  {
    id: "COLD_OPEN",
    label: "Cold Open",
    desc: "First 10 lines drop into mid-action, then settle into backstory.",
  },
  {
    id: "SLOW_BUILD",
    label: "Slow Build",
    desc: "First 20% calm → middle 60% rising tension → last 20% explosive.",
  },
  {
    id: "WAVE",
    label: "Wave",
    desc: "Alternate fast/slow sections — anti-fatigue rhythm.",
  },
  {
    id: "FAST_THROUGHOUT",
    label: "Fast Throughout",
    desc: "Maintain HIGH energy from line 1 to last.",
  },
];

// ============================================================
// Settings persistence
// ============================================================

interface PolishSettings {
  model: string;
  style: ChannelStyle;
  pacing: PacingPreset;
}

const SETTINGS_KEY = "manhwa.polishMode.settings.v2";
const DEFAULT_SETTINGS: PolishSettings = {
  model: "gemini-2.5-flash-lite",
  style: "STORIXA-BALANCED",
  pacing: "SLOW_BUILD",
};

function loadSettings(): PolishSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: PolishSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage full — fine */
  }
}

// Series name + bible are persisted separately so users can iterate on
// the script without losing their bible.
const META_KEY = "manhwa.polishMode.meta.v1";
interface PolishMeta {
  seriesName: string;
  characterBible: string;
}
function loadMeta(): PolishMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return { seriesName: "", characterBible: "" };
    return JSON.parse(raw);
  } catch {
    return { seriesName: "", characterBible: "" };
  }
}
function saveMeta(m: PolishMeta) {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {
    /* storage full — fine */
  }
}

// BIBLE_PLACEHOLDER removed 2026-05-27 — superseded by the structured
// POLISH_CONTEXT_TEMPLATE that the user loads via the "Load template"
// button. The old short placeholder gave less structure and led to
// inconsistent Sonnet output. See manualPolisher.POLISH_CONTEXT_TEMPLATE.

// ============================================================
// Main component
// ============================================================

interface PolishModeProps {
  rotator: KeyRotator;
}

export function PolishMode({ rotator }: PolishModeProps) {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [settings, setSettings] = useState<PolishSettings>(() => loadSettings());
  const [meta, setMeta] = useState<PolishMeta>(() => loadMeta());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualPolishResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  // Live streaming progress — updated as the model emits each line.
  const [progress, setProgress] = useState<{
    linesDone: number;
    linesTotal: number;
    accumulated: string;
    startedAt: number;
  } | null>(null);

  const [, forceKeyRender] = useState(0);
  useEffect(
    () => rotator.subscribe(() => forceKeyRender((n) => n + 1)),
    [rotator],
  );
  const hasAnyKey =
    rotator.list().filter((k) => k.enabled && k.value.trim()).length > 0;

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => saveMeta(meta), [meta]);

  const lineCount = useMemo(() => {
    if (!input.trim()) return 0;
    return input.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  }, [input]);

  // ~4 chars/token (rough average across Gemini + Claude).
  // The polish prompt itself is ~6-8K tokens, so add that to the
  // estimate so users see the real cost not just the script tokens.
  const PROMPT_OVERHEAD_TOKENS = 7000;
  const scriptTokens = useMemo(() => Math.ceil(input.length / 4), [input]);
  const bibleTokens = useMemo(
    () => Math.ceil((meta.characterBible.length + meta.seriesName.length) / 4),
    [meta],
  );
  const inputTokens = scriptTokens + bibleTokens + PROMPT_OVERHEAD_TOKENS;
  const estimatedOutputTokens = useMemo(
    () => Math.ceil(scriptTokens * 1.05), // polish preserves length ±5%
    [scriptTokens],
  );

  const selectedModel = MODEL_OPTIONS.find((m) => m.id === settings.model);
  const estimatedCostUsd = useMemo(() => {
    if (!selectedModel) return 0;
    return (
      (inputTokens / 1_000_000) * selectedModel.inputPerM +
      (estimatedOutputTokens / 1_000_000) * selectedModel.outputPerM
    );
  }, [selectedModel, inputTokens, estimatedOutputTokens]);
  const estimatedCostInr = estimatedCostUsd * 83;

  const handlePolish = useCallback(async () => {
    if (!input.trim() || busy || !hasAnyKey) return;
    setBusy(true);
    setError(null);
    setOutput("");
    setResult(null);
    setProgress(null);

    const lines = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) {
      setError("Input is empty after stripping blank lines.");
      setBusy(false);
      return;
    }

    const startedAt = Date.now();
    setProgress({
      linesDone: 0,
      linesTotal: lines.length,
      accumulated: "",
      startedAt,
    });

    try {
      const res = await polishScriptManual(lines, {
        model: settings.model,
        rotator,
        style: settings.style,
        pacing: settings.pacing,
        seriesName: meta.seriesName.trim() || undefined,
        characterBible: meta.characterBible.trim() || undefined,
        onKeyUsed: (m) => setCurrentKey(m),
        onProgress: (info) => {
          setProgress({
            linesDone: info.linesDone,
            linesTotal: info.linesTotal,
            accumulated: info.accumulated,
            startedAt,
          });
        },
      });
      setResult(res);
      setOutput(res.lines.join("\n"));
      if (!res.applied) {
        setError(
          `Polish failed (${res.fallbackReason ?? "unknown"}). Showing the original script unchanged.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setCurrentKey(null);
      setProgress(null);
    }
  }, [input, busy, hasAnyKey, settings, meta, rotator]);

  const handleCopy = useCallback(async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, [output]);

  const handleDownload = useCallback(() => {
    if (!output) return;
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `polished_script_${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [output]);

  return (
    <div className="space-y-6">
      {/* Step 1 — series + polish context */}
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Step 1 — Series name &amp; polish context (fill for 9.5/10 quality)
        </h2>
        <div className="space-y-3">
          <input
            type="text"
            value={meta.seriesName}
            onChange={(e) => setMeta({ ...meta, seriesName: e.target.value })}
            disabled={busy}
            placeholder="e.g. Solo Leveling, The Eternally Regressing Knight"
            className="w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-blue-700 focus:outline-none disabled:opacity-50"
          />

          {/* Quick-action buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setMeta((m) => ({ ...m, characterBible: POLISH_CONTEXT_TEMPLATE }))
              }
              disabled={busy}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700"
              title="Replace the bible field with the full structured polish context template"
            >
              Load template
            </button>
            <button
              type="button"
              onClick={() => {
                if (!input.trim()) return;
                const detected = extractCharacterNamesFromScript(input);
                const lineCount = input
                  .split(/\r?\n/)
                  .filter((l) => l.trim().length > 0).length;
                const hints = buildAutoDetectHintsBlock(detected, lineCount);
                setMeta((m) => ({
                  ...m,
                  characterBible: hints + (m.characterBible || POLISH_CONTEXT_TEMPLATE),
                }));
              }}
              disabled={busy || !input.trim()}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Scan pasted script for character-name hints + load template"
            >
              Auto-detect characters from script
            </button>
            <button
              type="button"
              onClick={() => setMeta((m) => ({ ...m, characterBible: "" }))}
              disabled={busy || !meta.characterBible}
              className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Clear the bible field"
            >
              Clear
            </button>
            <span className="ml-auto text-[11px] text-zinc-500">
              Tip: Load template → Auto-detect → fill 5 names → Polish.
            </span>
          </div>

          <textarea
            value={meta.characterBible}
            onChange={(e) => setMeta({ ...meta, characterBible: e.target.value })}
            disabled={busy}
            placeholder={
              "Paste structured context here. Use the buttons above to:\n" +
              "  • Load template — get a structured form to fill\n" +
              "  • Auto-detect — scan script for character names\n\n" +
              "If left blank, AI auto-detects everything (quality 8.5/10 instead of 9.5/10)."
            }
            rows={14}
            className="w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200 focus:border-blue-700 focus:outline-none disabled:opacity-50"
          />
          <div className="text-[11px] text-zinc-500">
            When the bible contains structured fields (ARCHETYPE, TIER_1_NAMED,
            CORE_GOAL, ROLE_TAGS, etc.), Sonnet treats those values as
            authoritative and skips auto-detection. Quality jumps from{" "}
            <span className="text-zinc-400">8.5/10 → 9.5/10</span>.
          </div>
        </div>
      </section>

      {/* Step 2 — paste script */}
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Step 2 — Paste your script (one line per panel)
        </h2>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          placeholder={`Paste your script here, one line per panel. Example:\n\nThe blade falls without warning.\nKrais drops to one knee, blood pooling at his feet.\nA familiar voice cuts through the haze.\n...`}
          rows={12}
          className="w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200 focus:border-blue-700 focus:outline-none disabled:opacity-50"
        />
        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zinc-500">
          <span>{lineCount} line{lineCount === 1 ? "" : "s"}</span>
          <span>•</span>
          <span>~{scriptTokens.toLocaleString()} script tokens</span>
          <span>•</span>
          <span>~{estimatedOutputTokens.toLocaleString()} output tokens (est.)</span>
        </div>
      </section>

      {/* Step 3 — settings */}
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Step 3 — Polish settings
        </h2>
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          disabled={busy}
        />
      </section>

      {/* Step 4 — cost estimate */}
      <section>
        <div className="rounded border border-zinc-800 bg-zinc-900/40 px-4 py-3">
          <div className="flex items-start gap-2 text-xs">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-blue-400" />
            <div className="flex-1">
              <div className="text-zinc-300">
                Estimated cost:{" "}
                <span className="font-semibold text-zinc-100">
                  ${estimatedCostUsd.toFixed(4)} ≈ ₹{estimatedCostInr.toFixed(2)}
                </span>
                {selectedModel && (
                  <span className="ml-2 text-zinc-500">
                    via {selectedModel.label}
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                {inputTokens.toLocaleString()} input (script + bible + prompt) +
                ~{estimatedOutputTokens.toLocaleString()} output tokens. Real
                cost may vary ±10%.
              </div>
              {selectedModel?.requiresOpenRouter && (
                <div className="mt-1 text-[11px] text-amber-300/80">
                  ⚠ This model requires an OpenRouter API key (not Gemini direct).
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Step 5 — API keys */}
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
          Step 4 — API keys
        </h2>
        <ApiKeyManager rotator={rotator} />
      </section>

      {/* Step 6 — polish button */}
      <section>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handlePolish}
            disabled={busy || !hasAnyKey || lineCount === 0}
            className="flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {busy
              ? "Polishing…"
              : `Polish ${lineCount} line${lineCount === 1 ? "" : "s"}`}
          </button>
          {!hasAnyKey && lineCount > 0 && (
            <span className="text-xs text-zinc-500">
              Add at least one API key above to enable.
            </span>
          )}
          {currentKey && (
            <code className="rounded bg-zinc-950 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
              key {currentKey}
            </code>
          )}
        </div>
      </section>

      {/* Live progress (streaming) */}
      {busy && progress && (
        <LiveProgress
          linesDone={progress.linesDone}
          linesTotal={progress.linesTotal}
          accumulated={progress.accumulated}
          startedAt={progress.startedAt}
        />
      )}

      {/* Error */}
      {error && (
        <div className="space-y-2 rounded border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex-1">
              <div className="font-medium">Something went wrong</div>
              <div className="mt-1 text-red-400/80">{error}</div>
            </div>
          </div>
          {result?.rawModelOutput && (
            <details className="ml-7 text-xs text-red-300/70">
              <summary className="cursor-pointer text-red-300/90 hover:text-red-200">
                Show raw model output ({result.rawModelOutput.length.toLocaleString()}{" "}
                chars) — you can salvage it manually
              </summary>
              <div className="mt-2 space-y-2">
                <textarea
                  value={result.rawModelOutput}
                  readOnly
                  rows={10}
                  className="w-full rounded border border-red-900/40 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-300"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (result.rawModelOutput) {
                        navigator.clipboard.writeText(result.rawModelOutput);
                      }
                    }}
                    className="rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700"
                  >
                    Copy raw output
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!result.rawModelOutput) return;
                      const blob = new Blob([result.rawModelOutput], {
                        type: "text/plain;charset=utf-8",
                      });
                      const url = URL.createObjectURL(blob);
                      const ts = new Date()
                        .toISOString()
                        .slice(0, 19)
                        .replace(/[:T]/g, "-");
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `raw_model_output_${ts}.txt`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }}
                    className="rounded bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700"
                  >
                    Download raw .txt
                  </button>
                </div>
              </div>
            </details>
          )}
        </div>
      )}

      {/* Partial polish warning (applied=true but some lines fell back to originals) */}
      {result?.applied && result.fallbackReason && (
        <div className="rounded border border-amber-900/40 bg-amber-950/30 px-4 py-2 text-xs text-amber-200/80">
          ⚠ {result.fallbackReason}
        </div>
      )}

      {/* Output */}
      {output && (
        <section>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
            Polished output{" "}
            {result?.applied ? (
              <span className="ml-2 rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                ✓ Polished • {result.resolvedStyle.replace(/_/g, " ")} •{" "}
                {result.resolvedPacing.replace(/_/g, " ")}
              </span>
            ) : (
              <span className="ml-2 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                Fallback (original)
              </span>
            )}
          </h2>
          <textarea
            value={output}
            readOnly
            rows={12}
            className="w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-200"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" /> Copy to clipboard
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
            >
              <Download className="h-3.5 w-3.5" /> Download .txt
            </button>
            {result?.inputTokens != null && result?.outputTokens != null && (
              <span className="ml-auto text-[11px] text-zinc-500">
                Real usage: {result.inputTokens.toLocaleString()} in /{" "}
                {result.outputTokens.toLocaleString()} out
              </span>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// ============================================================
// Settings panel
// ============================================================

function SettingsPanel({
  settings,
  onChange,
  disabled,
}: {
  settings: PolishSettings;
  onChange: (s: PolishSettings) => void;
  disabled?: boolean;
}) {
  const labelCls =
    "block text-[11px] font-medium uppercase tracking-wider text-zinc-500 mb-1";
  const selectCls =
    "w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 focus:border-blue-700 focus:outline-none disabled:opacity-50";

  const selectedStyle = STYLE_OPTIONS.find((s) => s.id === settings.style);
  const selectedPacing = PACING_OPTIONS.find((p) => p.id === settings.pacing);
  const selectedModelOpt = MODEL_OPTIONS.find((m) => m.id === settings.model);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Model */}
      <div>
        <label className={labelCls}>Model</label>
        <select
          value={settings.model}
          onChange={(e) => onChange({ ...settings, model: e.target.value })}
          disabled={disabled}
          className={clsx(selectCls, "font-medium")}
        >
          {MODEL_OPTIONS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="mt-1 text-[11px] text-zinc-500">
          {selectedModelOpt?.note}
        </div>
      </div>

      {/* Style preset */}
      <div>
        <label className={labelCls}>Style preset (channel-modeled)</label>
        <select
          value={settings.style}
          onChange={(e) =>
            onChange({ ...settings, style: e.target.value as ChannelStyle })
          }
          disabled={disabled}
          className={selectCls}
        >
          {STYLE_OPTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="mt-1 text-[11px] text-zinc-500">
          {selectedStyle && (
            <>
              <span className="text-zinc-400">{selectedStyle.short}</span>
              <br />
              <span>Best for: {selectedStyle.useFor}</span>
            </>
          )}
        </div>
      </div>

      {/* Pacing preset */}
      <div>
        <label className={labelCls}>Pacing preset</label>
        <select
          value={settings.pacing}
          onChange={(e) =>
            onChange({ ...settings, pacing: e.target.value as PacingPreset })
          }
          disabled={disabled}
          className={selectCls}
        >
          {PACING_OPTIONS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="mt-1 text-[11px] text-zinc-500">
          {selectedPacing?.desc}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Live streaming progress panel
// ============================================================

function LiveProgress({
  linesDone,
  linesTotal,
  accumulated,
  startedAt,
}: {
  linesDone: number;
  linesTotal: number;
  accumulated: string;
  startedAt: number;
}) {
  // Re-render once a second so the elapsed clock + ETA tick live even
  // when no new tokens arrive (during long inter-token gaps).
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const pct = linesTotal > 0 ? Math.min(100, (linesDone / linesTotal) * 100) : 0;
  const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
  const elapsedFmt = formatDuration(elapsedSec);

  // Estimate remaining time from current throughput. Need at least 5
  // lines / 10 seconds of data for a stable estimate.
  let etaFmt = "calculating…";
  if (linesDone >= 5 && elapsedSec >= 10) {
    const linesPerSec = linesDone / elapsedSec;
    const remainingLines = Math.max(0, linesTotal - linesDone);
    const etaSec = Math.ceil(remainingLines / linesPerSec);
    etaFmt = formatDuration(etaSec);
  }

  // Show the last ~12 lines of accumulated text as a live preview.
  // Trim to the tail because Sonnet outputs grow large fast and we
  // don't want a 30K-char textarea repainting every 250ms.
  const previewLines = accumulated
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const tail = previewLines.slice(-12).join("\n");

  return (
    <div className="space-y-2 rounded border border-blue-900/40 bg-blue-950/20 px-4 py-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
          <span className="font-medium text-zinc-200">
            Polishing… {linesDone} / {linesTotal} lines
          </span>
          <span className="text-zinc-500">({pct.toFixed(1)}%)</span>
        </div>
        <div className="text-[11px] text-zinc-500">
          <span>elapsed {elapsedFmt}</span>
          <span className="mx-1.5">•</span>
          <span>ETA {etaFmt}</span>
        </div>
      </div>
      <div className="h-2 overflow-hidden rounded bg-zinc-900">
        <div
          className="h-full bg-blue-500 transition-all duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      {tail && (
        <details className="text-[11px] text-zinc-500" open>
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-300">
            Live preview (last 12 lines)
          </summary>
          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-950/60 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-300">
            {tail}
          </pre>
        </details>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}
