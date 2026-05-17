// Browser-side Gemini API client.
//
// Calls ``generativelanguage.googleapis.com`` directly with the user's
// API key — Google's REST endpoint supports CORS for this, so no
// backend proxy is needed.
//
// All requests run through the supplied ``KeyRotator`` so we
// transparently spread load across the user's pool of keys and respect
// per-minute / per-day caps.

import type { KeyRotator } from "./keyRotator";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

export interface GenerateOptions {
  /** Model id, e.g. ``gemini-3.1-flash-lite``. */
  model: string;
  /**
   * Optional secondary model to retry against if ``model`` exhausts
   * its rate-limit budget (typically when the user's quota for a
   * premium model like 3.1-pro is burned through on a large run).
   * On the final attempt of the retry loop, if the last error was a
   * 429 AND a fallback is set, we make ONE MORE attempt using the
   * fallback model (different RPD/RPM budget). Useful pattern:
   *   ``model: "gemini-3.1-pro", fallbackModel: "gemini-2.5-pro"``
   */
  fallbackModel?: string;
  /** Full prompt text. */
  prompt: string;
  /** Images to attach, in order, after the prompt text. */
  images?: Blob[];
  /** ``"application/json"`` puts Gemini in structured-output mode. */
  responseMimeType?: "text/plain" | "application/json";
  temperature?: number;
  topP?: number;
  /** Hook for the UI to log which key handled the call (post-pick). */
  onKeyUsed?: (maskedKey: string) => void;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/**
 * HTTP statuses that mean "the server is sad but you should try again".
 * Google's Gemini API occasionally returns these under load — 503 most
 * commonly when the model is overloaded. We back off and retry rather
 * than fail the chapter.
 */
const SERVER_ERROR_STATUSES = new Set([500, 502, 503, 504]);

/** Total retry budget per Gemini call. */
const MAX_ATTEMPTS = 6;

/** Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s. */
function backoffMs(attempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Make one ``generateContent`` call against the supplied model.
 *
 * Handles:
 *  • Multi-image bodies (PDF panels are attached as inline JPEG bytes).
 *  • Structured JSON mode for the character-bible step.
 *  • Rate-limit retries via the key rotator (429 → swap key, repeat).
 *  • Surfacing safety-filter blocks with a clear error rather than a
 *    cryptic ``undefined`` access.
 */
export async function generateContent(
  rotator: KeyRotator,
  opts: GenerateOptions,
): Promise<string> {
  const parts: GeminiPart[] = [{ text: opts.prompt }];
  if (opts.images?.length) {
    for (const blob of opts.images) {
      const data = await blobToBase64(blob);
      parts.push({
        inline_data: { mime_type: blob.type || "image/jpeg", data },
      });
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (opts.temperature != null) generationConfig.temperature = opts.temperature;
  if (opts.topP != null) generationConfig.topP = opts.topP;
  if (opts.responseMimeType)
    generationConfig.responseMimeType = opts.responseMimeType;

  const body = { contents: [{ parts }], generationConfig };

  // Primary model attempt with full retry budget.
  try {
    return await callWithRetries(rotator, opts.model, body, opts);
  } catch (primaryErr) {
    // Model-fallback layer — kicks in when the caller set a
    // ``fallbackModel`` AND the failure means the primary model is
    // structurally unavailable for THIS key:
    //
    //   • 429 — rate-limit exhausted across all keys for this model's
    //           daily/per-minute budget (transient on time scale of
    //           hours, but fallback gets us through the run today).
    //
    //   • 403 — key does not have access to this model at all
    //           (permanent until the user upgrades their billing tier
    //           or Google rolls the model out to free tier). Without
    //           fallback the entire chapter dies; with fallback we
    //           use the cheaper model so the run completes.
    //
    //   • 404 — model name not recognised by the API (e.g. spec
    //           assumed a model that doesn't exist on the user's
    //           endpoint yet). Same recovery path as 403.
    //
    // Other errors (server outage, safety filter, malformed request,
    // network) pass through unchanged — switching model wouldn't help.
    const shouldFallback =
      primaryErr instanceof GeminiError &&
      (primaryErr.status === 429 ||
        primaryErr.status === 403 ||
        primaryErr.status === 404);
    if (opts.fallbackModel && shouldFallback && primaryErr instanceof GeminiError) {
      const reason =
        primaryErr.status === 429
          ? "exhausted rate-limit budget"
          : primaryErr.status === 403
            ? "is not accessible to this API key (HTTP 403)"
            : "is not recognised by the API (HTTP 404)";
      console.warn(
        `Primary model "${opts.model}" ${reason}. ` +
          `Falling back to "${opts.fallbackModel}".`,
      );
      return await callWithRetries(rotator, opts.fallbackModel, body, opts);
    }
    throw primaryErr;
  }
}

// ---------------------------------------------------------------------
// Internal — single-model retry loop. Factored out so we can call it
// twice (primary model, then fallback model) without duplicating code.
// ---------------------------------------------------------------------

async function callWithRetries(
  rotator: KeyRotator,
  modelId: string,
  body: unknown,
  opts: GenerateOptions,
): Promise<string> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const apiKey = await rotator.pick();
    opts.onKeyUsed?.(maskKey(apiKey));

    let response: Response;
    try {
      response = await fetch(
        `${ENDPOINT}/${modelId}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    } catch (e) {
      // Network error (offline, DNS, CORS, etc.) — wait + retry.
      lastErr = e;
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        console.warn(
          `Gemini network error on attempt ${attempt + 1}/${MAX_ATTEMPTS} (${modelId}), ` +
            `retrying in ${delay / 1000}s …`,
          e,
        );
        await sleep(delay);
      }
      continue;
    }

    if (response.status === 429) {
      // Per-key rate limit. Penalise the key briefly and try another
      // one IMMEDIATELY — no backoff needed if a fresh key is free.
      rotator.recordRateLimit(apiKey);
      lastErr = new GeminiError("Rate limited", 429);
      continue;
    }

    if (SERVER_ERROR_STATUSES.has(response.status)) {
      // Google's server is overloaded / restarting. Don't blame the
      // key (other keys hit the same servers). Wait + retry.
      lastErr = new GeminiError(
        `Gemini API HTTP ${response.status} (server temporarily unavailable)`,
        response.status,
      );
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        console.warn(
          `Gemini HTTP ${response.status} on attempt ${attempt + 1}/${MAX_ATTEMPTS} (${modelId}), ` +
            `backing off ${delay / 1000}s before retry …`,
        );
        await sleep(delay);
      }
      continue;
    }

    if (!response.ok) {
      // 4xx errors are caller errors (bad request, bad key, blocked).
      // Don't retry — surface the problem clearly to the user.
      const detail = await safeText(response);
      throw new GeminiError(
        `Gemini API HTTP ${response.status}`,
        response.status,
        detail,
      );
    }

    const data = (await response.json()) as GeminiResponse;
    rotator.recordSuccess(apiKey);

    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new GeminiError(
        "Gemini returned no candidates (likely blocked by a safety filter).",
        0,
        JSON.stringify(data).slice(0, 800),
      );
    }
    if (candidate.finishReason === "SAFETY") {
      throw new GeminiError(
        "Response blocked by Gemini's safety filter. " +
          "Try lowering the violence content of the panel batch or split the scene.",
        0,
        JSON.stringify(candidate.safetyRatings).slice(0, 800),
      );
    }

    const text = candidate.content?.parts
      ?.map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new GeminiError(
        "Empty response text from Gemini.",
        0,
        JSON.stringify(data).slice(0, 800),
      );
    }
    return text;
  }

  if (lastErr instanceof Error) throw lastErr;
  throw new GeminiError("Exhausted retries calling Gemini.", 0);
}

// ---- internals -----------------------------------------------------

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    safetyRatings?: unknown[];
  }>;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader failed"));
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // strip the "data:<mime>;base64," prefix
      const idx = dataUrl.indexOf(",");
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    reader.readAsDataURL(blob);
  });
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 800);
  } catch {
    return "";
  }
}

/** Last 4 chars are usually enough to identify a key in the UI. */
export function maskKey(key: string): string {
  if (key.length < 8) return "key";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
