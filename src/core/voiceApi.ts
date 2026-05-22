// ai33.pro voice API client.
//
// ai33.pro is an ElevenLabs-compatible aggregator that exposes the
// same TTS / voice endpoints behind a single ``xi-api-key`` auth
// header. We use it from the TTS tab to turn the manhwa pipeline's
// script.txt into a stitched MP3 + SRT, the same workflow OmniVoice's
// "Bulk Script" tab does.
//
// Endpoint pattern:
//   POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128
//     - body: {text, model_id}
//     - returns: {success, task_id, ec_remain_credits}
//
//   GET /v1/task/{task_id}
//     - returns: {id, status, error_message, metadata, type}
//     - metadata.audio_url available once status === "done"
//
//   GET /v2/voices
//     - returns: {voices: [...]} — list of available voices
//
// Polling: TTS is async — we poll the task endpoint every 2s until
// status flips to "done" (or "failed"). Hard timeout 5 min per line.

const DEFAULT_BASE_URL = "https://api.ai33.pro";

export interface VoiceApiConfig {
  apiKey: string;
  /** Override only if you're proxying through a custom domain. */
  baseUrl?: string;
}

export interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  labels?: Record<string, string>;
  preview_url?: string;
  /** Some voice catalog responses include a sample. */
  samples?: unknown[];
}

export interface TtsCreateOptions {
  voiceId: string;
  text: string;
  modelId?: string;
  /** "mp3_44100_128" is the standard high-quality MP3. */
  outputFormat?: string;
}

export interface TaskMetadata {
  audio_url?: string;
  srt_url?: string;
  json_url?: string;
  /** Some tasks return additional fields — keep open shape. */
  [key: string]: unknown;
}

export interface TaskResponse {
  id: string;
  status: "pending" | "processing" | "done" | "failed" | string;
  progress?: number;
  error_message?: string | null;
  credit_cost?: number;
  metadata?: TaskMetadata;
  type?: string;
  created_at?: string;
}

function authHeaders(config: VoiceApiConfig): HeadersInit {
  return {
    "xi-api-key": config.apiKey,
    Accept: "application/json",
  };
}

function baseUrl(config: VoiceApiConfig): string {
  return (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * Look up a single voice by ID. Powers the "Custom voice ID" field
 * in the TtsMode UI — user pastes a voice_id from elsewhere (e.g.
 * ElevenLabs voice library), we validate it exists + fetch the
 * voice's name + category for display before saving to favourites.
 */
export async function getVoice(
  config: VoiceApiConfig,
  voiceId: string,
): Promise<Voice> {
  const res = await fetch(
    `${baseUrl(config)}/v1/voices/${encodeURIComponent(voiceId)}`,
    { headers: authHeaders(config) },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Voice lookup failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await res.json()) as Voice;
  if (!data.voice_id) {
    throw new Error("Voice lookup returned no voice_id");
  }
  return data;
}

/**
 * Fetch the list of voices the user can pick from. Mirrors the
 * ElevenLabs ``/v2/voices`` response shape; returns the flat array.
 */
export async function listVoices(config: VoiceApiConfig): Promise<Voice[]> {
  const res = await fetch(`${baseUrl(config)}/v2/voices`, {
    headers: authHeaders(config),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to list voices (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await res.json()) as unknown;
  // ElevenLabs-compatible: { voices: [...] }
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { voices?: unknown[] }).voices)
  ) {
    return (data as { voices: Voice[] }).voices;
  }
  // Some endpoints return a raw array.
  if (Array.isArray(data)) return data as Voice[];
  return [];
}

/**
 * Kick off a text-to-speech job. Returns immediately with a task_id
 * — the actual MP3 generation happens server-side and is polled via
 * ``getTask`` / ``pollTaskUntilDone``.
 */
export async function createSpeechTask(
  config: VoiceApiConfig,
  opts: TtsCreateOptions,
): Promise<string> {
  const format = opts.outputFormat ?? "mp3_44100_128";
  const url = `${baseUrl(config)}/v1/text-to-speech/${encodeURIComponent(
    opts.voiceId,
  )}?output_format=${encodeURIComponent(format)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(config),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: opts.modelId ?? "eleven_multilingual_v2",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `TTS task creation failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await res.json()) as { task_id?: string; success?: boolean };
  if (!data.task_id) {
    throw new Error("TTS task creation returned no task_id");
  }
  return data.task_id;
}

/** Single-shot fetch of a task's current state. */
export async function getTask(
  config: VoiceApiConfig,
  taskId: string,
): Promise<TaskResponse> {
  const res = await fetch(
    `${baseUrl(config)}/v1/task/${encodeURIComponent(taskId)}`,
    { headers: authHeaders(config) },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `getTask failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  return (await res.json()) as TaskResponse;
}

export interface PollOptions {
  /** Poll interval in ms. Default 2000. */
  intervalMs?: number;
  /** Total time we're willing to wait. Default 5 min. */
  timeoutMs?: number;
  /** Fires on every poll with the latest task state. */
  onPoll?: (task: TaskResponse) => void;
  /** Abort polling early. */
  signal?: AbortSignal;
}

/**
 * Poll the task endpoint until status === "done" (resolves with the
 * final TaskResponse) or "failed" (rejects). Aborts on signal +
 * times out after ``timeoutMs``.
 */
export async function pollTaskUntilDone(
  config: VoiceApiConfig,
  taskId: string,
  opts: PollOptions = {},
): Promise<TaskResponse> {
  // 1 sec default — Turbo v2.5 finishes a typical line in 1-2 sec
  // server-side. 2-sec polling was the main reason a 1-sec generation
  // looked like 3 sec to the user. 1-sec interval picks it up fast
  // without hammering the API.
  const interval = opts.intervalMs ?? 1000;
  // 15 min default — ai33.pro aggregator can be slow at peak times,
  // especially with eleven_multilingual_v2. 5 min was too tight; we
  // were aborting polls on tasks that completed seconds later, wasting
  // credits.
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
  const started = Date.now();

  while (Date.now() - started < timeout) {
    if (opts.signal?.aborted) {
      throw new Error("Polling aborted");
    }
    const task = await getTask(config, taskId);
    opts.onPoll?.(task);
    if (task.status === "done") return task;
    if (task.status === "failed") {
      throw new Error(
        task.error_message ?? `Task ${taskId} failed with no error message`,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  // Final check before giving up — the task may have completed in the
  // last poll interval. Without this, we'd burn the credit even though
  // the audio is sitting ready server-side.
  try {
    const final = await getTask(config, taskId);
    opts.onPoll?.(final);
    if (final.status === "done") return final;
    if (final.status === "failed") {
      throw new Error(
        final.error_message ?? `Task ${taskId} failed with no error message`,
      );
    }
  } catch (err) {
    // If the task definitively failed, surface that. Otherwise fall
    // through to the timeout error below.
    if (err instanceof Error && /failed/i.test(err.message)) throw err;
  }

  throw new Error(
    `Task ${taskId} did not complete within ${Math.round(timeout / 1000)}s — aborting poll`,
  );
}

/**
 * Convenience: do POST + poll in one call. Exposes ``onTaskCreated``
 * so callers can persist the task_id BEFORE polling begins — that way
 * if the user closes the tab mid-poll, we can recover the audio later
 * via ``getTask`` instead of burning a fresh credit.
 */
export async function generateSpeech(
  config: VoiceApiConfig,
  opts: TtsCreateOptions & {
    onTaskCreated?: (taskId: string) => void;
    onPoll?: (task: TaskResponse) => void;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<TaskResponse> {
  const taskId = await createSpeechTask(config, opts);
  opts.onTaskCreated?.(taskId);
  return pollTaskUntilDone(config, taskId, {
    onPoll: opts.onPoll,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
}
