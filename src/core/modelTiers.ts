// Spec-defined free-tier Gemini model assignment.
//
// From CLAUDE_CODE_COMMAND.md §3:
//
//   Stage 2 (filler classify) → gemini-2.0-flash-lite   (Unlimited RPD)
//   Stage 3 (script writing)  → gemini-2.5-flash        (10K RPD)
//   Stage 4 (bridges)         → gemini-2.5-flash        (shared)
//   Stage 5 (polish pass)     → gemini-3.1-pro          (250 RPD)
//
// Backups (config-switchable when primary exhausts quota):
//   filler  → gemini-2.5-flash-lite (Unlimited)
//   script  → gemini-2.0-flash      (Unlimited)
//   polish  → gemini-2.5-pro        (1K RPD)
//
// Per-model RPM limits (used by the rate limiter):
//   gemini-2.0-flash-lite : 4000 / min
//   gemini-2.5-flash      : 1000 / min
//   gemini-3.1-pro        :   25 / min   ← bottleneck for big runs
//
// Why split: high-volume image classification is cheap on flash-lite,
// narration needs the better visual reasoning of 2.5-flash, and the
// final polish needs the premium quality of 3.1-pro. Three tiers =
// cost-optimal at competitor quality.

// Tier assignment reflects the user's KEY-VERIFIED model access
// (probe results 2026-05-16). The spec asked for gemini-3.1-pro
// for polish, but Google's API returns 404 for that model name
// (it doesn't exist on v1beta). The actual premium tier is
// gemini-2.5-pro, which is quota-rate-limited (1K RPD) and
// regularly exhausted on this key.
//
// So the "proven-working today" tier is what we ship by default:
//   gemini-3.1-flash-lite — confirmed 200 OK
//   gemini-2.5-flash      — confirmed 200 OK
//
// Other models (2.0-flash-lite, 2.5-pro, 2.0-flash) ARE accessible
// to this key but are 429-throttled today. They go in MODEL_BACKUPS
// — the fallback chain in geminiClient swaps to them automatically
// when the primary hits 429/403/404, and back when quota resets.

// Tier assignment updated 2026-05-16 using probe results against the
// user's actual API key. Four models confirmed accessible:
//
//   gemini-3.1-flash-lite    GA, free,  cheapest baseline
//   gemini-2.5-flash         GA, free,  prev-gen workhorse
//   gemini-3-flash-preview   PREVIEW, $0.50/$3 — newest generation
//   gemini-3.1-pro-preview   PREVIEW, $2/$12 — premium (currently
//                            429-throttled — useful when quota resets)
//
// We use the newest-generation model (gemini-3-flash-preview) on the
// narrative stages (3A/3B/bridges/polish) where quality matters most.
// Curator stays on the cheapest GA model — it just needs to score
// panels, not write prose. Polish has a multi-stage fallback in case
// 3-flash-preview quota runs out mid-run.

export const MODEL_TIERS = {
  /**
   * Stage 2 — panel filler classifier. High volume (one call per 8
   * panels, parallel concurrency 4). flash-lite is fast + cheap + GA.
   * No quality lift would come from putting a heavier model here —
   * the classifier just decides keep/drop on a 0-10 axis.
   */
  filler: "gemini-3.1-flash-lite",
  /**
   * Stage 3 — whole-chapter vision comprehension (3A) + beat
   * segmentation (3B). Switched 2026-05-26 from gemini-3-flash-preview
   * → gemini-2.5-flash because the preview model was hitting heavy
   * 429/503 on the user's free-tier quota and producing truncated /
   * non-JSON output (numbered lists instead of arrays). 2.5-flash is
   * GA, has 1000 RPM on free tier, and follows JSON instructions
   * reliably. Quality loss is minor (gen-2.5 vs gen-3 narration).
   * Flip back to gemini-3-flash-preview when paid quota is funded.
   */
  script: "gemini-2.5-flash",
  /** Stage 4 — continuity bridges (text-only). Shared with script. */
  continuity: "gemini-2.5-flash",
  /**
   * Stage 5 — polish + hook addition. Switched to gemini-2.5-flash
   * for the same reason as script (free-tier preview throttling).
   * For premium polish quality, the new Stage 6 global polish uses
   * gemini-2.5-flash-lite explicitly via globalScriptPolisher.ts —
   * that bypasses this tier setting.
   */
  polish: "gemini-2.5-flash",
  /** Stage 5b — structural editor (skipped in long-form mode anyway). */
  structural: "gemini-2.5-flash",
} as const;

export const MODEL_BACKUPS = {
  filler: "gemini-2.5-flash",
  script: "gemini-2.5-flash",
  /**
   * If gemini-3-flash-preview burns its free / paid quota mid-run
   * the polish falls back to gemini-2.5-flash (proven free, prev
   * gen). Polish quality dips slightly but the run completes.
   */
  polish: "gemini-2.5-flash",
  structural: "gemini-2.5-flash",
} as const;

/**
 * Per-model RPM ceilings from the spec. The keyRotator uses these
 * to throttle calls before a 429 is even attempted — better than
 * eating a backoff penalty.
 */
export const MODEL_RPM_LIMITS: Record<string, number> = {
  "gemini-2.0-flash-lite": 4000,
  "gemini-2.5-flash-lite": 4000,
  "gemini-2.5-flash": 1000,
  "gemini-2.0-flash": 1000,
  "gemini-3.1-pro": 25,
  "gemini-2.5-pro": 25,
  // Current single-model fallback used in pre-spec runs.
  "gemini-3.1-flash-lite": 4000,
};

/**
 * Translate a pipeline-level Gemini model name to the OpenRouter
 * equivalent. The dispatcher in geminiClient calls this when the
 * key rotator hands it an OpenRouter key so the user's per-stage
 * model preferences still resolve to a sensible model on that
 * provider.
 *
 * Default for unknown models = Qwen3.5-Flash. It's:
 *   • Vision-capable (handles curator + comprehend stages)
 *   • Strong text generation (polish + segment + bridges)
 *   • Cheapest VLM on OpenRouter ($0.065 input / $0.26 output per M
 *     tokens, often with promo discounts)
 *   • 1M token context (no truncation concerns)
 *   • ~0.51s latency, 85 tps throughput — way faster than Gemini
 *     preview models
 *
 * Users can override per-key via ApiKey.modelOverride to pick a
 * specific Qwen / DeepSeek / Claude model instead.
 */
export const OPENROUTER_MODEL_MAP: Record<string, string> = {
  // Legacy / pipeline-internal Gemini IDs → Qwen3.5-Flash (cheap + vision
  // + fast). Used by the old PDF Bulk pipeline whose calls aren't
  // quality-sensitive (filter scoring, simple comprehend batches).
  "gemini-3.1-flash-lite": "qwen/qwen3.5-flash-02-23",
  "gemini-2.0-flash": "qwen/qwen3.5-flash-02-23",
  "gemini-2.0-flash-lite": "qwen/qwen3.5-flash-02-23",
  "gemini-3-flash-preview": "qwen/qwen3.5-flash-02-23",
  "gemini-3.1-pro-preview": "qwen/qwen3.6-plus", // step up for premium tier

  // Quality-sensitive folder-mode + global-polish stages: route to the
  // REAL Gemini on OpenRouter so the user gets the model they paid for,
  // not a Qwen substitute. Folder mode in particular needs strong
  // constraint following (panel_index range, crop coords, target line
  // count) that Qwen reliably struggles with.
  "gemini-2.5-flash-lite": "google/gemini-2.5-flash-lite",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
  "gemini-2.5-pro": "google/gemini-2.5-pro",

  // Premium polish tier — Anthropic Claude Sonnet 4.6 via OpenRouter.
  // Used by the standalone Polish tab when the user opts in for the
  // highest-quality script polish (anti-pattern rule adherence, prose
  // smoothness, adjective variety). ~$0.33 per 1000-line polish, ~30×
  // cheaper than Opus while delivering noticeably better polish than
  // Gemini Flash.
  "claude-sonnet-4.6": "anthropic/claude-sonnet-4.6",
};

/** Default OpenRouter model when no mapping exists for the requested Gemini model. */
export const OPENROUTER_DEFAULT_MODEL = "qwen/qwen3.5-flash-02-23";
