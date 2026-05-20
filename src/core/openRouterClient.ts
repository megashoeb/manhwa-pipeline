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
  /** Optional max tokens hint. */
  max_tokens?: number;
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

const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 180_000;

function backoffMs(attempt: number): number {
  // 1.5s, 3s, 6s, 12s — capped at 20s. Mirrors geminiClient's gentle
  // retry profile (tuned for speed after the user's "10 min/chapter"
  // complaint).
  return Math.min(20_000, 1_500 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Build the messages array from a Gemini-style prompt + image blobs.
 * Single user message with mixed content parts when images exist,
 * plain text content otherwise.
 */
async function buildMessages(
  prompt: string,
  images?: Blob[],
): Promise<Message[]> {
  if (!images || images.length === 0) {
    return [{ role: "user", content: prompt }];
  }
  const parts: ContentPart[] = [{ type: "text", text: prompt }];
  for (const blob of images) {
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
  const messages = await buildMessages(opts.prompt, opts.images);
  const body: OpenRouterRequest = {
    model: opts.model,
    messages,
  };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.topP != null) body.top_p = opts.topP;
  if (opts.responseMimeType === "application/json") {
    body.response_format = { type: "json_object" };
  }

  opts.onKeyUsed?.(maskKey(apiKey));

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
      lastErr = new OpenRouterError(
        `OpenRouter HTTP ${response.status} (server temporarily unavailable)`,
        response.status,
      );
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = backoffMs(attempt);
        console.warn(
          `OpenRouter ${response.status} server error (attempt ` +
            `${attempt + 1}/${MAX_ATTEMPTS}) — retrying in ${delay / 1000}s…`,
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
    return text;
  }

  if (lastErr instanceof Error) throw lastErr;
  throw new OpenRouterError("Exhausted retries calling OpenRouter", 0);
}
