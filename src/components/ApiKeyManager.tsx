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
  const [newTier, setNewTier] = useState<"free" | "paid">("free");
  const [newRole, setNewRole] = useState<"primary" | "backup">("primary");
  const [newProvider, setNewProvider] = useState<"gemini" | "openrouter">(
    "gemini",
  );
  const [showFull, setShowFull] = useState<Record<string, boolean>>({});

  // Re-render whenever the rotator's state changes (usage tick, add, etc.).
  useEffect(() => rotator.subscribe(() => forceRender((n) => n + 1)), [rotator]);

  const keys = rotator.list();
  const limits = rotator.getLimits();
  // "Calls remaining" only counts free-tier keys against the daily cap;
  // paid keys don't have one and are tracked separately.
  const totalAvailable = keys
    .filter((k) => k.enabled && k.tier !== "paid")
    .reduce(
      (sum, k) => sum + Math.max(0, limits.dailyLimit - rotator.getUsage(k.value).usageDay),
      0,
    );
  const paidCount = keys.filter((k) => k.enabled && k.tier === "paid").length;
  const primaryCount = keys.filter(
    (k) => k.enabled && k.role !== "backup",
  ).length;
  const backupCount = keys.filter(
    (k) => k.enabled && k.role === "backup",
  ).length;

  function submit() {
    const value = newValue.trim();
    if (!value) return;
    const label = newLabel.trim() || `Key ${keys.length + 1}`;
    rotator.add({
      value,
      label,
      enabled: true,
      tier: newTier,
      role: newRole,
      provider: newProvider,
    });
    setNewLabel("");
    setNewValue("");
    setNewTier("free");
    setNewRole("primary");
    setNewProvider("gemini");
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
              ({primaryCount} primary{backupCount > 0 && ` + ${backupCount} backup`}
              {paidCount > 0 && (
                <span className="ml-1 rounded bg-amber-900/60 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                  {paidCount} paid
                </span>
              )}{" "}
              •{" "}
              {paidCount > 0
                ? "no daily cap"
                : `${totalAvailable.toLocaleString()} calls remaining today`}
              )
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
                  {/* Provider selector — Gemini vs OpenRouter. Flip
                      this and the dispatcher routes all subsequent
                      calls through this key to that provider's API. */}
                  <select
                    value={k.provider ?? "gemini"}
                    onChange={(e) =>
                      rotator.update(k.value, {
                        provider: e.target.value as "gemini" | "openrouter",
                      })
                    }
                    className={clsx(
                      "rounded border bg-zinc-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      k.provider === "openrouter"
                        ? "border-indigo-500/60 text-indigo-300"
                        : "border-zinc-700 text-zinc-400",
                    )}
                    title={
                      k.provider === "openrouter"
                        ? "OpenRouter — routes to Qwen3.5-Flash by default (vision + ~100x cheaper than Gemini preview)"
                        : "Google Gemini — generativelanguage.googleapis.com"
                    }
                  >
                    <option value="gemini">Gemini</option>
                    <option value="openrouter">OpenRouter</option>
                  </select>
                  {/* Tier selector — switch a key between free and paid
                      after creation. Paid keys bypass the rotator's
                      RPM/RPD caps and unlock high-concurrency mode. */}
                  <select
                    value={k.tier ?? "free"}
                    onChange={(e) =>
                      rotator.update(k.value, {
                        tier: e.target.value as "free" | "paid",
                      })
                    }
                    className={clsx(
                      "rounded border bg-zinc-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      k.tier === "paid"
                        ? "border-amber-500/60 text-amber-300"
                        : "border-zinc-700 text-zinc-400",
                    )}
                    title={
                      k.tier === "paid"
                        ? "Paid tier — RPM/RPD caps disabled, high parallelism enabled"
                        : "Free tier — 15 RPM / 500 RPD per Google's free-tier limits"
                    }
                  >
                    <option value="free">Free</option>
                    <option value="paid">Paid</option>
                  </select>
                  {/* Role selector — primary keys are used in normal
                      rotation; backups only kick in when all primaries
                      are RPM-throttled / daily-capped. Independent of
                      tier (you can have a paid backup or free primary). */}
                  <select
                    value={k.role ?? "primary"}
                    onChange={(e) =>
                      rotator.update(k.value, {
                        role: e.target.value as "primary" | "backup",
                      })
                    }
                    className={clsx(
                      "rounded border bg-zinc-950 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                      k.role === "backup"
                        ? "border-zinc-500/70 text-zinc-300"
                        : "border-zinc-700 text-zinc-400",
                    )}
                    title={
                      k.role === "backup"
                        ? "Backup — only used when every primary is currently rate-limited or daily-capped"
                        : "Primary — used in the normal rotation pool"
                    }
                  >
                    <option value="primary">Primary</option>
                    <option value="backup">Backup</option>
                  </select>
                  <div
                    className={clsx(
                      "text-xs tabular-nums",
                      k.provider === "openrouter"
                        ? "text-indigo-300/70"
                        : k.tier === "paid"
                          ? "text-amber-300/70"
                          : "text-zinc-400",
                    )}
                  >
                    {k.provider === "openrouter"
                      ? `${usage.usageDay} OR calls`
                      : k.tier === "paid"
                        ? `${usage.usageDay} calls today`
                        : `${usage.usageDay}/${limits.dailyLimit}`}
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
              {/* Usage bar — paid keys get a static amber bar (no cap
                  to fill); free keys get the standard red/amber/green
                  fill based on dailyPct. */}
              <div className="mt-1.5 h-1 overflow-hidden rounded bg-zinc-800">
                {k.tier === "paid" ? (
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-amber-400"
                    style={{ width: "100%" }}
                    title="Paid tier — no daily cap"
                  />
                ) : (
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
                )}
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
            <div className="flex items-center gap-3">
              <label className="text-xs text-zinc-400">Provider:</label>
              <label className="flex items-center gap-1 text-xs text-zinc-300">
                <input
                  type="radio"
                  name="newProvider"
                  checked={newProvider === "gemini"}
                  onChange={() => setNewProvider("gemini")}
                  className="accent-blue-500"
                />
                Google Gemini (AIzaSy…)
              </label>
              <label className="flex items-center gap-1 text-xs text-indigo-300">
                <input
                  type="radio"
                  name="newProvider"
                  checked={newProvider === "openrouter"}
                  onChange={() => setNewProvider("openrouter")}
                  className="accent-indigo-500"
                />
                OpenRouter (sk-or-…) — Qwen3.5-Flash, 100× cheaper
              </label>
            </div>
            {newProvider === "openrouter" && (
              <div className="rounded border border-indigo-700/40 bg-indigo-950/30 px-2 py-1.5 text-[11px] text-indigo-200">
                Need an OpenRouter key?{" "}
                <a
                  href="https://openrouter.ai/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-indigo-100"
                >
                  Get one here
                </a>
                . Add $5 credit ≈ 1000 chapters' worth on Qwen3.5-Flash.
                Tier/role still apply — but OpenRouter has no fixed RPM cap,
                so Free + Paid behave the same for it.
              </div>
            )}
            <div className="flex items-center gap-3">
              <label className="text-xs text-zinc-400">Tier:</label>
              <label className="flex items-center gap-1 text-xs text-zinc-300">
                <input
                  type="radio"
                  name="newTier"
                  checked={newTier === "free"}
                  onChange={() => setNewTier("free")}
                  className="accent-blue-500"
                />
                Free (15 RPM / 500 RPD cap)
              </label>
              <label className="flex items-center gap-1 text-xs text-amber-300">
                <input
                  type="radio"
                  name="newTier"
                  checked={newTier === "paid"}
                  onChange={() => setNewTier("paid")}
                  className="accent-amber-500"
                />
                Paid (no caps, unlocks 10× parallel)
              </label>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-zinc-400">Role:</label>
              <label className="flex items-center gap-1 text-xs text-zinc-300">
                <input
                  type="radio"
                  name="newRole"
                  checked={newRole === "primary"}
                  onChange={() => setNewRole("primary")}
                  className="accent-blue-500"
                />
                Primary (used in normal rotation)
              </label>
              <label className="flex items-center gap-1 text-xs text-zinc-400">
                <input
                  type="radio"
                  name="newRole"
                  checked={newRole === "backup"}
                  onChange={() => setNewRole("backup")}
                  className="accent-zinc-400"
                />
                Backup (only when primaries throttled)
              </label>
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
                  setNewTier("free");
                  setNewRole("primary");
                  setNewProvider("gemini");
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
