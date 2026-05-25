// OpenRouter client — OpenAI-compatible API wrapper.
//
// Lets the pipeline talk to any model OpenRouter hosts (Qwen,
// DeepSeek, Mistral, etc.) using a single API key. The user's
// motivation: their Gemini bill was Rs 500 per 10-chapter run, and
// Qwen3.5-Flash on OpenRouter is Rs 5 per 10 chapters — same
// vision-language capability, ~100x cheaper.
//
// This module mirrors the surface of generateContent() in geminiClient
// so the dispatcher there can route to either provider transparently.
// Same retry logic, same image handling, same JSON-mode support.

import type { KeyRotator } from "./keyRotator";
import { debugLog } from "./debugLog";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * OpenAI-compatible message content block. Text-only messages use a
 * plain string; vision-augmented messages use the array form with
 * mixed text/image parts.
 */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type Message = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

interface OpenRouterRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  top_p?: number;
  /** Set when caller asks for JSON-mode structured output. */
  response_format?: { type: "json_object" };
  /** Optional max tokens hint (legacy OpenAI). */
  max_tokens?: number;
  /** Newer OpenAI-style cap, also accepted by some Qwen routes. */
  max_completion_tokens?: number;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: { role: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: number | string };
}

/**
 * Same error shape as GeminiError so the dispatcher and retry loop
 * can route them uniformly.
 */
export class OpenRouterError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: string,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** HTTP statuses that mean "try again in a moment" — same as Gemini. */
const SERVER_ERROR_STATUSES = new Set([500, 502, 503, 504]);

// Tuned for paid OpenRouter on Qwen3.5-Flash: the rare server-side
// error usually clears within a couple of seconds (Alibaba CN routes
// can briefly drop). 2 attempts × short backoff = ~3s max retry
// overhead vs the old 4 × exponential which capped at 31.5s.
// Combined with the JSON-repair layer in jsonRepair.ts, most "errors"
// don't reach this retry loop at all — they get fixed inline.
const MAX_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 120_000;

function backoffMs(attempt: number): number {
  // 1s, 2s — quick recovery, no exponential ramp. If a provider is
  // genuinely down a 12s wait wouldn't help anyway (waste the user's
  // time); better to fail fast and let the chapter-level retry handle
  // longer outages.
  return [1_000, 2_000][attempt] ?? 2_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// OpenRouter / Alibaba enforces a 30 MB per-request cap on image
// content. We size panels conservatively to fit a 30-panel chapter
// (the common comprehend stage payload) under that ceiling. Gemini
// has no such cap so this code path is OpenRouter-only.
//
// Sizing tiers — chosen empirically after the user hit HTTP 413
// errors on a 30-panel comprehend call at 768 px / quality 0.85:
//
//   ≤ 12 panels  → 512 px max edge, quality 0.75  (good OCR fidelity)
//   ≤ 25 panels  → 384 px max edge, quality 0.7   (still readable text)
//   > 25 panels  → 256 px max edge, quality 0.65  (recognisable scene
//                                                   but small dialogue)
//
// The post-encode safety check below catches any oversize cases that
// slip through (chapters with abnormally tall panels) and re-encodes
// at the next tier down.
function sizingForImageCount(count: number): {
  maxEdge: number;
  quality: number;
} {
  if (count <= 12) return { maxEdge: 512, quality: 0.75 };
  if (count <= 25) return { maxEdge: 384, quality: 0.7 };
  return { maxEdge: 256, quality: 0.65 };
}
const OPENROUTER_TOTAL_BUDGET_BYTES = 22 * 1024 * 1024; // 22 MB hard cap (well under 30 MB with safety margin)

/**
 * Aggressively downscale + re-encode a single blob to keep the
 * total request payload under OpenRouter's 30 MB cap. Always
 * re-encodes (even if dimensions are already small) because we want
 * the lower-quality JPEG output for size, not the original.
 */
async function downscaleForOpenRouter(
  blob: Blob,
  maxEdge: number,
  quality: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxEdge / longest);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        "image/jpeg",
        quality,
      );
    });
    // Release backing store immediately.
    canvas.width = 0;
    canvas.height = 0;
    return out;
  } finally {
    bitmap.close();
  }
}

/**
 * Build the messages array from a Gemini-style prompt + image blobs.
 * Single user message with mixed content parts when images exist,
 * plain text content otherwise.
 *
 * Vision images go through ``downscaleForOpenRouter`` first to
 * shrink them to a size that fits the provider's 30 MB-per-request
 * cap. If the FIRST pass at 512 px still over-shoots the budget, we
 * re-shrink to 384 px and try again.
 */
async function buildMessages(
  prompt: string,
  images?: Blob[],
  modelId?: string,
): Promise<Message[]> {
  if (!images || images.length === 0) {
    return [{ role: "user", content: prompt }];
  }

  // Provider-specific sizing. Alibaba (Qwen3.x-Flash) enforces a
  // 30 MB per-request cap that forced us to ship tiny thumbnails;
  // Google's Gemini route has no such cap (their vision tower
  // accepts up to 1 MB per image at higher quality), so when the
  // user pinned a google/* model we relax to the same 768 px /
  // quality 0.85 the rest of the pipeline uses for Gemini direct.
  // Anthropic Claude is similar — accepts larger images.
  const isGemini = (modelId ?? "").startsWith("google/");
  const isClaude = (modelId ?? "").startsWith("anthropic/");
  const relaxed = isGemini || isClaude;

  // Pick initial sizing tier from panel count, then verify post-encode.
  let { maxEdge, quality } = relaxed
    ? { maxEdge: 768, quality: 0.85 } // Gemini / Claude — full fidelity
    : sizingForImageCount(images.length); // Qwen — Alibaba-safe tiers
  let downscaled = await Promise.all(
    images.map((b) => downscaleForOpenRouter(b, maxEdge, quality)),
  );
  let totalBytes = downscaled.reduce((sum, b) => sum + b.size, 0);

  // Safety net — if even the count-based tier overshoots (chapters
  // with abnormally tall webtoon panels), keep ratcheting down until
  // we fit. Hard floor at 192 px so we never produce literally
  // unreadable thumbnails.
  while (
    totalBytes * 1.34 > OPENROUTER_TOTAL_BUDGET_BYTES &&
    maxEdge > 192
  ) {
    maxEdge = Math.max(192, Math.round(maxEdge * 0.75));
    quality = Math.max(0.55, quality - 0.05);
    debugLog.push({
      type: "warn",
      label: `Image payload over budget — re-shrinking to ${maxEdge}px / q${quality}`,
      context: {
        previousTotalMB: +(totalBytes / 1024 / 1024).toFixed(2),
        budgetMB: OPENROUTER_TOTAL_BUDGET_BYTES / 1024 / 1024,
        imageCount: images.length,
      },
    });
    downscaled = await Promise.all(
      images.map((b) => downscaleForOpenRouter(b, maxEdge, quality)),
    );
    totalBytes = downscaled.reduce((sum, b) => sum + b.size, 0);
  }

  debugLog.push({
    type: "info",
    label: `OpenRouter payload ready: ${images.length} images @ ${maxEdge}px / q${quality}`,
    context: {
      totalMB: +(totalBytes / 1024 / 1024).toFixed(2),
      avgKBperImage: +(totalBytes / 1024 / images.length).toFixed(1),
    },
  });

  const parts: ContentPart[] = [{ type: "text", text: prompt }];
  for (const blob of downscaled) {
    const base64 = await blobToBase64(blob);
    const mime = blob.type || "image/jpeg";
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${base64}` },
    });
  }
  return [{ role: "user", content: parts }];
}

async function blobToBase64(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the "data:image/jpeg;base64," prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export interface OpenRouterCallOptions {
  /** OpenRouter model id, e.g. "qwen/qwen3.5-flash-02-23". */
  model: string;
  /** Full prompt text. */
  prompt: string;
  /** Image blobs (vision input). */
  images?: Blob[];
  /** "application/json" requests JSON-mode output. */
  responseMimeType?: "text/plain" | "application/json";
  temperature?: number;
  topP?: number;
  /** Hook for the UI to log which key handled the call. */
  onKeyUsed?: (maskedKey: string) => void;
  /**
   * Override the default 6144 output-token cap. Used by stages that
   * legitimately need to produce much longer output — e.g. the global
   * polish pass over a 1500-line script needs ~25K output tokens to
   * round-trip correctly.
   */
  maxOutputTokens?: number;
}

function maskKey(k: string): string {
  if (k.length <= 12) return "•••" + k.slice(-4);
  return k.slice(0, 8) + "…" + k.slice(-4);
}

/**
 * Make one OpenRouter chat completion call with the given API key
 * already chosen by the dispatcher. Returns the assistant's text
 * content. Retries on transient errors (429, 5xx, network) up to
 * MAX_ATTEMPTS with exponential backoff.
 */
export async function callOpenRouter(
  apiKey: string,
  rotator: KeyRotator,
  opts: OpenRouterCallOptions,
): Promise<string> {
  const messages = await buildMessages(opts.prompt, opts.images, opts.model);
  const body: OpenRouterRequest = {
    model: opts.model,
    messages,
  };
  if (opts.responseMimeType === "application/json") {
    body.response_format = { type: "json_object" };
    // Force low temperature on JSON-mode calls — Qwen drifts from
    // valid JSON above ~0.3 (random whitespace, smart quotes, missing
    // commas). 0.2 keeps output deterministic and structurally clean.
    // Caller can still override by passing ``temperature`` explicitly.
    body.temperature = opts.temperature ?? 0.2;
  } else if (opts.temperature != null) {
    body.temperature = opts.temperature;
  }
  if (opts.topP != null) body.top_p = opts.topP;
  // Cap output tokens — without this, Qwen sometimes runs to its full
  // 65K-token output limit even on prompts that should produce ~2K
  // tokens. We set BOTH ``max_tokens`` (OpenAI legacy) and
  // ``max_completion_tokens`` (newer spec) — different OpenRouter
  // upstream providers respect different ones, and Qwen3.5-Flash via
  // Alibaba was observed ignoring max_tokens (a 14,563-token output
  // came back when max_tokens=8192). Setting both fixes the runaway.
  // 6K is enough for whole-chapter narration; structured output
  // stages (curator, segment) need way less.
  const cap = body.max_tokens ?? opts.maxOutputTokens ?? 6144;
  body.max_tokens = cap;
  body.max_completion_tokens = cap;

  opts.onKeyUsed?.(maskKey(apiKey));

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const callStartedAt = Date.now();
    debugLog.push({
      type: "api-call",
      label: `openrouter ${opts.model}`,
      context: {
        attempt: attempt + 1,
        jsonMode: body.response_format != null,
        imageCount: opts.images?.length ?? 0,
        key: maskKey(apiKey),
      },
    });
    const ctrl = new AbortController();
    const timeoutHandle = window.setTimeout(
      () =>
        ctrl.abort(
          new Error(`OpenRouter request timed out after ${REQUEST_TIMEOUT_MS}ms`),
        ),
      REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // OpenRouter ranking headers — optional but appear on their
          // leaderboard. Lets the user see usage stats grouped by app.
          "HTTP-Referer": "https://manhwa-pipeline.vercel.app",
          "X-Title": "Manhwa Recap Pipeline",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        const isTimeout = e instanceof Error && e.name === "AbortError";
        console.warn(
          `OpenRouter ${isTimeout ? "timeout" : "network error"} ` +
            `(attempt ${attempt + 1}/${MAX_ATTEMPTS}, model ${opts.model}) — retrying in ${delay / 1000}s…`,
          e,
        );
        await sleep(delay);
      }
      continue;
    } finally {
      window.clearTimeout(timeoutHandle);
    }

    if (response.status === 429) {
      // OpenRouter rate-limit. Penalise the key briefly (rotator
      // skips it for ~60s) and try again — if user has other keys
      // they'll be picked next.
      rotator.recordRateLimit(apiKey);
      lastErr = new OpenRouterError("Rate limited by OpenRouter", 429);
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        await sleep(delay);
      }
      continue;
    }

    if (SERVER_ERROR_STATUSES.has(response.status)) {
      // Peek at the body to detect the specific "Failed to download
      // multimodal content" error Alibaba's gateway returns when its
      // image-handling service is having an upstream hiccup. That one
      // benefits from longer backoff (the outage typically clears in
      // 30-60 sec) and slightly more attempts than the 2-cap defaults.
      let detailPreview = "";
      try {
        const clone = response.clone();
        detailPreview = (await clone.text()).slice(0, 400);
      } catch {
        /* ignore — body might be already consumed */
      }
      const isAlibabaMultimodalGlitch =
        /Failed to download multimodal content|InternalError\.Algo\.InvalidParameter/i.test(
          detailPreview,
        );
      lastErr = new OpenRouterError(
        `OpenRouter HTTP ${response.status} (server temporarily unavailable)`,
        response.status,
        detailPreview,
      );
      // For the Alibaba multimodal-download glitch, use a longer
      // backoff (3s / 8s / 15s) instead of the default 1s / 2s
      // because the upstream service needs more time to recover.
      // Also give it 1 extra attempt beyond MAX_ATTEMPTS.
      const effectiveMax = isAlibabaMultimodalGlitch
        ? MAX_ATTEMPTS + 1
        : MAX_ATTEMPTS;
      if (attempt < effectiveMax - 1) {
        const delay = isAlibabaMultimodalGlitch
          ? [3000, 8000, 15000][attempt] ?? 15000
          : backoffMs(attempt);
        console.warn(
          `OpenRouter ${response.status} ${isAlibabaMultimodalGlitch ? "(Alibaba multimodal glitch)" : "server error"} ` +
            `(attempt ${attempt + 1}/${effectiveMax}) — retrying in ${delay / 1000}s…`,
        );
        await sleep(delay);
      }
      continue;
    }

    if (!response.ok) {
      // Non-retryable HTTP error (400, 401, 403, 404). Read body for
      // detail and throw — the dispatcher's fallback chain (model
      // swap) can still handle these.
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        /* ignore */
      }
      debugLog.push({
        type: "api-error",
        label: `openrouter ${opts.model} → HTTP ${response.status}`,
        durationMs: Date.now() - callStartedAt,
        context: { status: response.status, attempt: attempt + 1 },
        detail: detail.slice(0, 600),
      });
      throw new OpenRouterError(
        `OpenRouter HTTP ${response.status}: ${detail.slice(0, 200) || response.statusText}`,
        response.status,
        detail.slice(0, 800),
      );
    }

    // Success path.
    const data = (await response.json()) as OpenRouterResponse;
    rotator.recordSuccess(apiKey);

    if (data.error) {
      debugLog.push({
        type: "api-error",
        label: `openrouter ${opts.model} → ${data.error.message || "error"}`,
        durationMs: Date.now() - callStartedAt,
        context: { code: data.error.code, attempt: attempt + 1 },
        detail: JSON.stringify(data.error).slice(0, 600),
      });
      throw new OpenRouterError(
        `OpenRouter error: ${data.error.message || "unknown"}`,
        typeof data.error.code === "number" ? data.error.code : 0,
        JSON.stringify(data.error).slice(0, 800),
      );
    }
    const choice = data.choices?.[0];
    if (!choice) {
      throw new OpenRouterError(
        "OpenRouter returned no choices",
        0,
        JSON.stringify(data).slice(0, 800),
      );
    }
    const text = choice.message?.content?.trim();
    if (!text) {
      throw new OpenRouterError(
        "OpenRouter returned an empty response",
        0,
        JSON.stringify(data).slice(0, 800),
      );
    }
    debugLog.push({
      type: "api-success",
      label: `openrouter ${opts.model}`,
      durationMs: Date.now() - callStartedAt,
      context: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
        attempt: attempt + 1,
      },
    });
    return text;
  }

  if (lastErr instanceof Error) throw lastErr;
  throw new OpenRouterError("Exhausted retries calling OpenRouter", 0);
}
