// Manages a pool of Gemini API keys with quota tracking and rotation.
//
// Lifecycle of one key:
//   • Added by the user via the API Key Manager UI.
//   • Each successful Gemini call increments its ``usageDay`` counter.
//   • At local midnight, the counter resets (we tag it with the date
//     it was started so the reset happens on first read after rollover).
//   • If ``usageDay`` reaches the daily cap (default 500), the key is
//     excluded from rotation for the rest of the day.
//   • If the key has hit the per-minute cap (default 15), it's skipped
//     in favour of a different key if one is available, else we wait.
//
// All state is persisted to localStorage so a page reload doesn't
// throw away the day's quota tracking.

import {
  DEFAULT_KEY_LIMITS,
  type ApiKey,
  type ApiKeyUsage,
  type KeyLimits,
} from "../types/manhwa";
import { readJson, writeJson } from "./storage";

const STORAGE_KEYS = {
  KEYS: "manhwa.apiKeys.v1",
  USAGE: "manhwa.apiKeyUsage.v1",
} as const;

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function freshUsage(): ApiKeyUsage {
  return { usageDay: 0, resetDate: today(), recentRequests: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Rotates between user-supplied API keys, picking the least-used
 * healthy key for each Gemini call. Persists across page reloads via
 * ``localStorage``.
 */
export class KeyRotator {
  private keys: ApiKey[];
  private usage: Record<string, ApiKeyUsage>;
  private limits: KeyLimits;
  /** Optional subscriber for UI badge updates. */
  private listeners = new Set<() => void>();

  constructor(limits: KeyLimits = DEFAULT_KEY_LIMITS) {
    this.limits = limits;
    this.keys = readJson<ApiKey[]>(STORAGE_KEYS.KEYS, []);
    this.usage = readJson<Record<string, ApiKeyUsage>>(STORAGE_KEYS.USAGE, {});
    this.resetIfNewDay();
  }

  // ---- subscription -----------------------------------------------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ---- key management ---------------------------------------------

  list(): ApiKey[] {
    return [...this.keys];
  }

  getUsage(value: string): ApiKeyUsage {
    return this.usage[value] ?? freshUsage();
  }

  getLimits(): KeyLimits {
    return this.limits;
  }

  add(key: ApiKey): void {
    // Reject duplicates by value (raw key string).
    if (this.keys.some((k) => k.value === key.value)) return;
    this.keys.push(key);
    this.usage[key.value] = freshUsage();
    this.persist();
    this.notify();
  }

  update(value: string, patch: Partial<ApiKey>): void {
    const idx = this.keys.findIndex((k) => k.value === value);
    if (idx < 0) return;
    this.keys[idx] = { ...this.keys[idx], ...patch };
    this.persist();
    this.notify();
  }

  remove(value: string): void {
    this.keys = this.keys.filter((k) => k.value !== value);
    delete this.usage[value];
    this.persist();
    this.notify();
  }

  // ---- rotation ----------------------------------------------------

  /**
   * Pick the next key to use. Pick order (first match wins):
   *
   *   1. Paid primary keys — bypass RPM/RPD entirely, least-used first.
   *   2. Paid backup keys — same bypass, only consulted if no paid
   *      primaries exist.
   *   3. Free primary keys under both RPM + RPD caps, least-used first.
   *   4. Free backup keys under caps — only if every free primary is
   *      RPM-throttled OR daily-capped.
   *   5. Sleep until the soonest free key clears its RPM window, then
   *      recurse.
   *
   * Throws when every key (across tiers + roles) has hit its daily cap.
   */
  async pick(): Promise<string> {
    this.resetIfNewDay();

    const enabled = this.keys.filter((k) => k.enabled && k.value.trim());
    if (enabled.length === 0) {
      throw new Error(
        "No API keys configured. Add at least one Gemini key in the API Keys panel.",
      );
    }

    const isBackup = (k: ApiKey) => k.role === "backup";
    const isPrimary = (k: ApiKey) => !isBackup(k);

    // ---- Paid keys (no caps) ---------------------------------------
    // Paid primaries take absolute priority. Paid backups only kick in
    // if the user has no paid primaries (i.e. they intentionally marked
    // all paid keys as backup — unusual but supported).
    const paidPrimary = enabled.filter((k) => k.tier === "paid" && isPrimary(k));
    const paidBackup = enabled.filter((k) => k.tier === "paid" && isBackup(k));
    const paidPool = paidPrimary.length > 0 ? paidPrimary : paidBackup;
    if (paidPool.length > 0) {
      const sorted = [...paidPool].sort(
        (a, b) => this.usage[a.value].usageDay - this.usage[b.value].usageDay,
      );
      return sorted[0].value;
    }

    // ---- Free keys (capped) ----------------------------------------
    // Filter to keys still under their daily cap.
    const underDaily = enabled.filter(
      (k) => this.usage[k.value].usageDay < this.limits.dailyLimit,
    );
    if (underDaily.length === 0) {
      throw new Error(
        `All ${enabled.length} API key(s) have hit today's ${this.limits.dailyLimit}-request limit. ` +
          "Add more keys, enable a paid-tier key, or wait until tomorrow.",
      );
    }

    // Try PRIMARY first. ``pickFromPool`` returns the least-used key
    // that's also under the RPM cap; returns null if every key in the
    // pool is RPM-throttled.
    const primaryUnderDaily = underDaily.filter(isPrimary);
    const primaryPick = this.pickFromPool(primaryUnderDaily);
    if (primaryPick) return primaryPick;

    // All primaries either RPM-throttled OR there are no primaries.
    // Fall through to BACKUP keys.
    const backupUnderDaily = underDaily.filter(isBackup);
    const backupPick = this.pickFromPool(backupUnderDaily);
    if (backupPick) return backupPick;

    // Both pools throttled. Wait the shortest amount needed before
    // the oldest tracked request scrolls out of the 60-second window
    // ACROSS all under-daily keys (primary + backup) — sleeping
    // longer for primary's benefit when backups exist would be silly.
    let minWait = 60_000;
    for (const k of underDaily) {
      const oldest = this.usage[k.value].recentRequests[0];
      if (oldest != null) {
        minWait = Math.min(minWait, oldest + 60_000 - Date.now());
      }
    }
    await sleep(Math.max(250, minWait + 100));
    return this.pick();
  }

  /**
   * Return the least-used key in ``pool`` that's also under its RPM
   * cap, or null when every key in the pool is RPM-throttled (or pool
   * is empty). Pure helper, no side effects.
   */
  private pickFromPool(pool: ApiKey[]): string | null {
    if (pool.length === 0) return null;
    const sorted = [...pool].sort(
      (a, b) => this.usage[a.value].usageDay - this.usage[b.value].usageDay,
    );
    for (const k of sorted) {
      if (this.requestsLastMinute(k.value) < this.limits.minuteLimit) {
        return k.value;
      }
    }
    return null;
  }

  /** True when at least one enabled, working paid key exists. */
  hasPaidKey(): boolean {
    return this.keys.some(
      (k) => k.enabled && k.value.trim() !== "" && k.tier === "paid",
    );
  }

  /** Count of enabled paid keys (for concurrency calculation). */
  countPaidKeys(): number {
    return this.keys.filter(
      (k) => k.enabled && k.value.trim() !== "" && k.tier === "paid",
    ).length;
  }

  /** Mark a successful request against the given key. */
  recordSuccess(value: string): void {
    this.resetIfNewDay();
    const u = this.usage[value] ?? freshUsage();
    u.usageDay += 1;
    u.recentRequests.push(Date.now());
    u.recentRequests = u.recentRequests.filter(
      (t) => Date.now() - t < 60_000,
    );
    this.usage[value] = u;
    this.persist();
    this.notify();
  }

  /**
   * Mark a key as having hit a rate limit right now (so we deprioritise
   * it on the next ``pick``). We don't increment ``usageDay`` because the
   * call didn't succeed — but we DO insert a recent-request marker so
   * the RPM filter routes around it for a minute.
   */
  recordRateLimit(value: string): void {
    const u = this.usage[value] ?? freshUsage();
    // Stuff the RPM window so this key is skipped for ~60 seconds.
    const now = Date.now();
    for (let i = 0; i < this.limits.minuteLimit; i++) {
      u.recentRequests.push(now);
    }
    this.usage[value] = u;
    this.persist();
    this.notify();
  }

  // ---- internals ---------------------------------------------------

  private requestsLastMinute(value: string): number {
    const u = this.usage[value];
    if (!u) return 0;
    const cutoff = Date.now() - 60_000;
    return u.recentRequests.filter((t) => t > cutoff).length;
  }

  private resetIfNewDay(): void {
    const t = today();
    let dirty = false;
    for (const k of this.keys) {
      const u = this.usage[k.value];
      if (!u || u.resetDate !== t) {
        this.usage[k.value] = freshUsage();
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  private persist(): void {
    writeJson(STORAGE_KEYS.KEYS, this.keys);
    writeJson(STORAGE_KEYS.USAGE, this.usage);
  }
}
