import { useEffect, useState } from "react";
import { Key, Plus, Trash2, ExternalLink, Eye, EyeOff } from "lucide-react";
import clsx from "clsx";

import type { KeyRotator } from "../core/keyRotator";
import { maskKey } from "../core/geminiClient";

interface Props {
  rotator: KeyRotator;
}

/**
 * UI for the user to add, label, enable/disable, and delete the
 * Gemini API keys that power Stage 4. Live shows today's usage per
 * key so it's obvious when one is approaching its 500-request daily
 * cap — and when adding another would unlock more capacity.
 */
export function ApiKeyManager({ rotator }: Props) {
  const [, forceRender] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [showFull, setShowFull] = useState<Record<string, boolean>>({});

  // Re-render whenever the rotator's state changes (usage tick, add, etc.).
  useEffect(() => rotator.subscribe(() => forceRender((n) => n + 1)), [rotator]);

  const keys = rotator.list();
  const limits = rotator.getLimits();
  const totalAvailable = keys
    .filter((k) => k.enabled)
    .reduce(
      (sum, k) => sum + Math.max(0, limits.dailyLimit - rotator.getUsage(k.value).usageDay),
      0,
    );

  function submit() {
    const value = newValue.trim();
    if (!value) return;
    const label = newLabel.trim() || `Key ${keys.length + 1}`;
    rotator.add({ value, label, enabled: true });
    setNewLabel("");
    setNewValue("");
    setAdding(false);
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">
            Gemini API keys
          </span>
          {keys.length > 0 && (
            <span className="text-xs text-zinc-500">
              ({keys.filter((k) => k.enabled).length} active •{" "}
              {totalAvailable.toLocaleString()} calls remaining today)
            </span>
          )}
        </div>
        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
        >
          Get a free key
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {/* Key list */}
      <div className="divide-y divide-zinc-800">
        {keys.length === 0 && !adding && (
          <div className="px-4 py-6 text-center text-sm text-zinc-500">
            <div className="mb-1 text-zinc-400">No API keys yet</div>
            <div className="text-xs">
              Add at least one Gemini key to enable script generation.
            </div>
          </div>
        )}

        {keys.map((k) => {
          const usage = rotator.getUsage(k.value);
          const dailyPct = Math.min(
            100,
            (usage.usageDay / limits.dailyLimit) * 100,
          );
          const exhausted = usage.usageDay >= limits.dailyLimit;
          return (
            <div key={k.value} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={k.enabled}
                  onChange={(e) =>
                    rotator.update(k.value, { enabled: e.target.checked })
                  }
                  className="h-4 w-4 accent-blue-500"
                />
                <input
                  type="text"
                  value={k.label}
                  onChange={(e) =>
                    rotator.update(k.value, { label: e.target.value })
                  }
                  className="w-40 truncate rounded border border-transparent bg-transparent px-1 text-sm text-zinc-200 hover:border-zinc-700 focus:border-zinc-600 focus:outline-none"
                />
                <code
                  className="select-all rounded bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-400"
                  title={showFull[k.value] ? k.value : "Click eye to reveal"}
                >
                  {showFull[k.value] ? k.value : maskKey(k.value)}
                </code>
                <button
                  type="button"
                  onClick={() =>
                    setShowFull((s) => ({ ...s, [k.value]: !s[k.value] }))
                  }
                  className="text-zinc-500 hover:text-zinc-300"
                  aria-label={showFull[k.value] ? "Hide key" : "Show key"}
                >
                  {showFull[k.value] ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
                <div className="ml-auto flex items-center gap-3">
                  <div className="text-xs tabular-nums text-zinc-400">
                    {usage.usageDay}/{limits.dailyLimit}
                  </div>
                  <button
                    type="button"
                    onClick={() => rotator.remove(k.value)}
                    className="text-zinc-500 hover:text-red-400"
                    aria-label="Remove key"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {/* Usage bar */}
              <div className="mt-1.5 h-1 overflow-hidden rounded bg-zinc-800">
                <div
                  className={clsx(
                    "h-full transition-all duration-300",
                    exhausted
                      ? "bg-red-500"
                      : dailyPct > 80
                        ? "bg-amber-500"
                        : "bg-emerald-500",
                  )}
                  style={{ width: `${dailyPct}%` }}
                />
              </div>
            </div>
          );
        })}

        {adding && (
          <div className="space-y-2 px-4 py-3">
            <div className="grid grid-cols-[140px_1fr] gap-2">
              <input
                type="text"
                placeholder="Label (optional)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
              <input
                type="text"
                placeholder="AIzaSy…"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={!newValue.trim()}
                className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save key
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setNewLabel("");
                  setNewValue("");
                }}
                className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer / add button */}
      {!adding && (
        <div className="border-t border-zinc-800 px-4 py-2.5">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300"
          >
            <Plus className="h-3.5 w-3.5" />
            Add API key
          </button>
        </div>
      )}
    </div>
  );
}
