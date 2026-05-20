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
   * Pick the next key to use. Waits (sleeps) when every FREE key is
   * RPM-throttled. Paid keys never throttle (Gemini paid Tier 1 starts
   * at ~1000 RPM with no daily cap — irrelevant for our use). Throws
   * only when every key (free + paid) is unusable.
   */
  async pick(): Promise<string> {
    this.resetIfNewDay();

    const enabled = this.keys.filter((k) => k.enabled && k.value.trim());
    if (enabled.length === 0) {
      throw new Error(
        "No API keys configured. Add at least one Gemini key in the API Keys panel.",
      );
    }

    // Paid keys: bypass RPM/RPD entirely. We still track usage so the
    // user can see stats, but a paid key is always immediately
    // returnable. Prefer the least-used paid key so usage spreads
    // across multiple paid keys if the user has more than one.
    const paid = enabled.filter((k) => k.tier === "paid");
    if (paid.length > 0) {
      const sortedPaid = [...paid].sort(
        (a, b) => this.usage[a.value].usageDay - this.usage[b.value].usageDay,
      );
      return sortedPaid[0].value;
    }

    // Free keys only path. Filter out daily-capped keys.
    const underDaily = enabled.filter(
      (k) => this.usage[k.value].usageDay < this.limits.dailyLimit,
    );
    if (underDaily.length === 0) {
      throw new Error(
        `All ${enabled.length} API key(s) have hit today's ${this.limits.dailyLimit}-request limit. ` +
          "Add more keys, enable a paid-tier key, or wait until tomorrow.",
      );
    }

    // Sort least-used first so we spread load across all available keys.
    const sorted = [...underDaily].sort(
      (a, b) => this.usage[a.value].usageDay - this.usage[b.value].usageDay,
    );

    // Walk in order; return the first key that's also under its RPM cap.
    for (const k of sorted) {
      if (this.requestsLastMinute(k.value) < this.limits.minuteLimit) {
        return k.value;
      }
    }

    // Every healthy key is RPM-throttled. Wait the shortest amount of
    // time needed before the oldest tracked request scrolls out of the
    // 60-second window.
    let minWait = 60_000;
    for (const k of sorted) {
      const oldest = this.usage[k.value].recentRequests[0];
      if (oldest != null) {
        minWait = Math.min(minWait, oldest + 60_000 - Date.now());
      }
    }
    await sleep(Math.max(250, minWait + 100));
    // After waiting, recurse — at least one key should now be available.
    return this.pick();
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
