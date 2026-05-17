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
   * segmentation (3B). Gemini 3 generation noticeably better at
   * "fill the connective context, motivation, stakes" work this
   * stage needs. Preview model so price-aware users may want to
   * downgrade to gemini-2.5-flash (free GA) — flip the constant.
   */
  script: "gemini-3-flash-preview",
  /** Stage 4 — continuity bridges (text-only). Shared with script. */
  continuity: "gemini-3-flash-preview",
  /**
   * Stage 5 — polish + hook addition. Quality matters most here. We
   * use gemini-3-flash-preview by default since the premium
   * gemini-3.1-pro-preview is currently 429-throttled. When the
   * user's pro quota resets they can flip this to
   * gemini-3.1-pro-preview for a small quality bump on the hook +
   * dialogue weaving.
   */
  polish: "gemini-3-flash-preview",
  /** Stage 5b — structural editor (skipped in long-form mode anyway). */
  structural: "gemini-3-flash-preview",
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
