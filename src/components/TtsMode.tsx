// TTS tab — turns the pipeline's script.txt into a stitched MP3/WAV
// + per-line SRT via ai33.pro (ElevenLabs-compatible aggregator).
//
// Workflow mirrors OmniVoice's "Bulk Script" tab:
//   1. User sets API key + base URL (one-time, persisted)
//   2. Picks a voice from the /v2/voices dropdown
//   3. Pastes a multi-line script (one beat per line)
//   4. Hits Generate
//   5. For each line, kicks off a TTS task and polls until done
//   6. Fetches each line's MP3, decodes via Web Audio API
//   7. Concatenates with configurable silence gap
//   8. Encodes as a single WAV blob the user downloads
//   9. Builds a per-line SRT whose timestamps align with the audio

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Download,
  KeyRound,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Star,
  Trash2,
} from "lucide-react";
import clsx from "clsx";

import {
  generateSpeech,
  getTask,
  getVoice,
  listVoices,
  type Voice,
  type VoiceApiConfig,
} from "../core/voiceApi";
import {
  fetchDecodeStitch,
  type StitchResult,
} from "../core/voiceAudioStitcher";
import { buildSrt } from "../core/voiceSrtBuilder";
import { readJson, writeJson } from "../core/storage";
import { acquireKeepAwake } from "../core/keepAwake";

const STORAGE_KEY_API = "manhwa.tts.apiKey";
const STORAGE_KEY_FORM = "manhwa.tts.lastForm";
const STORAGE_KEY_FAVS = "manhwa.tts.favourites";
// Per-line task cache — keyed by (voice + model + text fingerprint).
// Lets us (a) skip API calls on re-runs of the same script,
// (b) recover task_ids after a crash without burning fresh credits.
const STORAGE_KEY_CACHE = "manhwa.tts.lineCache";

// Turbo v2.5 = 5-10s per line vs multilingual_v2's 1-3 min. Default to
// Turbo so timeout-during-poll is effectively impossible. Users who
// need maximum quality can still pick multilingual_v2 from the dropdown.
const DEFAULT_MODEL = "eleven_turbo_v2_5";

// Retry config for transient failures. ai33.pro aggregator does
// occasionally hang specific workers — a fresh task usually clears it.
// Backoffs are aggressive (2s/4s/8s) because at concurrency >= 5 we
// often have other lines completing in the same window — a long retry
// pause leaves a worker idle while siblings finish.
const MAX_LINE_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;

// Parallel worker count for the TTS batch loop. Default 5 = 5 lines
// in flight at once via ai33.pro's async task endpoint. ai33 is a
// thin ElevenLabs aggregator with no published RPM cap; 5 is a safe
// "fast but polite" default. Users can crank to 10 via the slider
// when they want a 600-line script done in ~5 min instead of ~10.
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 10;

interface ModelInfo {
  id: string;
  label: string;
  tag: "high-quality" | "newest" | "turbo";
  description: string;
}

/**
 * All ElevenLabs models exposed via ai33.pro. ``label`` shown in the
 * dropdown. Tags + descriptions help the user pick without needing
 * to read external docs.
 */
const COMMON_MODELS: ModelInfo[] = [
  {
    id: "eleven_multilingual_v2",
    label: "Eleven Multilingual v2",
    tag: "high-quality",
    description: "Most life-like, emotionally rich. 29 languages. Best for voice-overs + audiobooks.",
  },
  {
    id: "eleven_v3",
    label: "Eleven v3 (alpha)",
    tag: "newest",
    description: "Most expressive. 70+ languages. Needs more prompt engineering — quality varies.",
  },
  {
    id: "eleven_flash_v2_5",
    label: "Eleven Flash v2.5",
    tag: "turbo",
    description: "Ultra low latency. 32 languages. Best for conversational use cases.",
  },
  {
    id: "eleven_turbo_v2_5",
    label: "Eleven Turbo v2.5",
    tag: "turbo",
    description: "High quality + low latency. 32 languages. Best speed-quality balance.",
  },
  {
    id: "eleven_turbo_v2",
    label: "Eleven Turbo v2",
    tag: "turbo",
    description: "English-only, low latency. Same speed as Turbo v2.5 but English only.",
  },
  {
    id: "eleven_flash_v2",
    label: "Eleven Flash v2",
    tag: "turbo",
    description: "Older flash model. Use Flash v2.5 instead unless you specifically need v2.",
  },
];

/** One saved voice in the favourites list. */
interface VoiceFavorite {
  voice_id: string;
  name: string;
  /** Optional category (e.g. "premade", "generated", "professional"). */
  category?: string;
  /** Timestamp added — used for sorting newest-first. */
  addedAt: number;
}

/**
 * One entry in the per-line task cache. Keyed by ``fingerprint`` (a
 * hash of voice + model + text) — same script line + same voice +
 * same model = guaranteed-identical TTS output, so we can reuse the
 * audio_url without paying a second time.
 *
 * Persisted to localStorage so a page reload or crash doesn't burn
 * credits — pending tasks get checked via ``getTask`` on the next
 * Generate pass, recovering audio for tasks that completed
 * server-side while we were away.
 */
interface CachedLine {
  fingerprint: string;
  text: string;
  voiceId: string;
  modelId: string;
  taskId: string;
  status: "pending" | "done" | "failed";
  audioUrl?: string;
  createdAt: number;
  lastCheckedAt: number;
}

/** Stable per-line key used for cache lookup. */
function fingerprintLine(
  text: string,
  voiceId: string,
  modelId: string,
): string {
  const trimmed = text.trim();
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) {
    h = ((h << 5) - h + trimmed.charCodeAt(i)) | 0;
  }
  return `${voiceId.slice(0, 12)}::${modelId}::${(h >>> 0).toString(36)}::${trimmed.length}`;
}

interface LastForm {
  voiceId: string;
  modelId: string;
  scriptText: string;
  silenceMs: number;
  baseUrl: string;
  /** How many lines to process in parallel. 1 = sequential, 10 = max. */
  concurrency: number;
}

interface LineState {
  index: number;
  text: string;
  status: "pending" | "creating" | "polling" | "done" | "failed";
  taskId?: string;
  audioUrl?: string;
  durationMs?: number;
  error?: string;
}

export function TtsMode() {
  // ---- persistent config -------------------------------------------
  const [apiKey, setApiKey] = useState<string>(() =>
    readJson<string>(STORAGE_KEY_API, ""),
  );
  const [lastForm, setLastForm] = useState<LastForm>(() => {
    const stored = readJson<LastForm>(STORAGE_KEY_FORM, {
      voiceId: "",
      modelId: DEFAULT_MODEL,
      scriptText: "",
      silenceMs: 150,
      baseUrl: "https://api.ai33.pro",
      concurrency: DEFAULT_CONCURRENCY,
    });
    // Back-compat: old persisted forms didn't have concurrency.
    return {
      ...stored,
      concurrency:
        typeof stored.concurrency === "number" && stored.concurrency > 0
          ? Math.min(MAX_CONCURRENCY, stored.concurrency)
          : DEFAULT_CONCURRENCY,
    };
  });

  // Persist on changes.
  useEffect(() => {
    writeJson(STORAGE_KEY_API, apiKey);
  }, [apiKey]);
  useEffect(() => {
    writeJson(STORAGE_KEY_FORM, lastForm);
  }, [lastForm]);

  const updateForm = useCallback((patch: Partial<LastForm>) => {
    setLastForm((prev) => ({ ...prev, ...patch }));
  }, []);

  // ---- voice catalog ------------------------------------------------
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [voicesError, setVoicesError] = useState<string | null>(null);

  // ---- favourites + custom voice ID lookup -------------------------
  // Persistent list of voice IDs the user has explicitly saved. Lets
  // them paste an ID once (e.g. from ElevenLabs Voice Library), save
  // it, and click a chip next time instead of re-typing.
  const [favourites, setFavourites] = useState<VoiceFavorite[]>(() =>
    readJson<VoiceFavorite[]>(STORAGE_KEY_FAVS, []),
  );
  useEffect(() => {
    writeJson(STORAGE_KEY_FAVS, favourites);
  }, [favourites]);

  // ---- per-line task cache -----------------------------------------
  // Hydrated from localStorage. We never delete entries automatically —
  // user clicks "Clear cache" when they want to start fresh. Cap at 500
  // entries (LRU-style) to avoid unbounded growth.
  const [lineCache, setLineCache] = useState<CachedLine[]>(() =>
    readJson<CachedLine[]>(STORAGE_KEY_CACHE, []),
  );
  useEffect(() => {
    writeJson(STORAGE_KEY_CACHE, lineCache);
  }, [lineCache]);

  const recordCachedTask = useCallback((entry: CachedLine) => {
    setLineCache((prev) => {
      const filtered = prev.filter((e) => e.fingerprint !== entry.fingerprint);
      return [entry, ...filtered].slice(0, 500);
    });
  }, []);

  const updateCachedTask = useCallback(
    (fingerprint: string, patch: Partial<CachedLine>) => {
      setLineCache((prev) =>
        prev.map((e) =>
          e.fingerprint === fingerprint ? { ...e, ...patch } : e,
        ),
      );
    },
    [],
  );

  const clearCache = useCallback(() => {
    setLineCache([]);
  }, []);

  const [customVoiceId, setCustomVoiceId] = useState<string>("");
  /**
   * Free-text label the user types for the custom voice ID. We never
   * gate saving on the API lookup succeeding — many shared / community
   * voices return 404 from GET /v1/voices but still work fine with the
   * TTS endpoint. So the name + ID + save button are always visible.
   */
  const [customVoiceName, setCustomVoiceName] = useState<string>("");
  const [lookupResult, setLookupResult] = useState<Voice | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  // Favourites operations declared BEFORE lookup/manual-save so the
  // closures over them satisfy temporal-dead-zone strictness.
  const saveFavourite = useCallback(
    (voice: Voice) => {
      setFavourites((prev) => {
        // Dedupe by voice_id — re-save just updates the timestamp.
        const filtered = prev.filter((f) => f.voice_id !== voice.voice_id);
        const next: VoiceFavorite = {
          voice_id: voice.voice_id,
          name: voice.name,
          category: voice.category,
          addedAt: Date.now(),
        };
        return [next, ...filtered].slice(0, 30); // cap at 30
      });
    },
    [],
  );

  const removeFavourite = useCallback((voiceId: string) => {
    setFavourites((prev) => prev.filter((f) => f.voice_id !== voiceId));
  }, []);

  const lookupVoice = useCallback(async () => {
    const trimmed = customVoiceId.trim();
    if (!trimmed) {
      setLookupError("Paste a voice ID first.");
      return;
    }
    if (!apiKey.trim()) {
      setLookupError("Add your API key first.");
      return;
    }
    setLookupBusy(true);
    setLookupError(null);
    setLookupResult(null);

    // Fast path — check if the voice is already in the loaded /v2/voices
    // list (user's own library). Saves an API call + works offline.
    const local = voices.find((v) => v.voice_id === trimmed);
    if (local) {
      setLookupResult(local);
      updateForm({ voiceId: local.voice_id });
      if (!customVoiceName.trim()) setCustomVoiceName(local.name);
      setLookupBusy(false);
      return;
    }

    try {
      const voice = await getVoice(
        { apiKey: apiKey.trim(), baseUrl: lastForm.baseUrl },
        trimmed,
      );
      setLookupResult(voice);
      updateForm({ voiceId: voice.voice_id });
      // Auto-fill the name field if the user hasn't already typed one.
      if (!customVoiceName.trim()) setCustomVoiceName(voice.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLookupError(msg);
      // 404 / community voice — the save button below still works,
      // user just needs to type their own label.
    } finally {
      setLookupBusy(false);
    }
  }, [customVoiceId, customVoiceName, apiKey, lastForm.baseUrl, updateForm, voices]);

  /**
   * Save the typed (name, ID) pair to favourites. Always available —
   * no API call required. Trusts the user on the ID, since many shared
   * voices don't show up in GET /v1/voices but still work with the
   * TTS endpoint.
   */
  const saveCustom = useCallback(() => {
    const id = customVoiceId.trim();
    const name = customVoiceName.trim();
    if (!id || !name) return;
    const synthetic: Voice = {
      voice_id: id,
      name,
      category: lookupResult?.category ?? "custom",
    };
    saveFavourite(synthetic);
    updateForm({ voiceId: id });
    setLookupError(null);
    setLookupResult(synthetic);
  }, [customVoiceId, customVoiceName, lookupResult, saveFavourite, updateForm]);

  const clearAllFavourites = useCallback(() => {
    setFavourites([]);
  }, []);

  const selectFavourite = useCallback(
    (fav: VoiceFavorite) => {
      updateForm({ voiceId: fav.voice_id });
      setCustomVoiceId("");
      setLookupResult(null);
    },
    [updateForm],
  );

  const reloadVoices = useCallback(async () => {
    if (!apiKey.trim()) {
      setVoicesError("Add your ai33 / ElevenLabs API key first.");
      setVoices([]);
      return;
    }
    setVoicesLoading(true);
    setVoicesError(null);
    try {
      const list = await listVoices({
        apiKey: apiKey.trim(),
        baseUrl: lastForm.baseUrl,
      });
      setVoices(list);
      // Auto-select the first voice if user hasn't picked one yet.
      if (!lastForm.voiceId && list.length > 0) {
        updateForm({ voiceId: list[0].voice_id });
      }
    } catch (err) {
      setVoicesError(err instanceof Error ? err.message : String(err));
      setVoices([]);
    } finally {
      setVoicesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, lastForm.baseUrl]);

  // Auto-load voices on mount + whenever the key changes (debounced).
  useEffect(() => {
    if (!apiKey.trim()) return;
    const t = setTimeout(() => {
      reloadVoices();
    }, 400);
    return () => clearTimeout(t);
  }, [apiKey, reloadVoices]);

  // ---- generation state --------------------------------------------
  const [busy, setBusy] = useState(false);
  const [lineStates, setLineStates] = useState<LineState[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [stitchResult, setStitchResult] = useState<{
    blob: Blob;
    filename: string;
    srt: string;
    srtFilename: string;
    totalMs: number;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Ref mirror of lineStates so async callbacks can read the latest
  // values without stale-closure bugs.
  const lineStatesRef = useRef<LineState[]>([]);
  useEffect(() => {
    lineStatesRef.current = lineStates;
  }, [lineStates]);

  const appendLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setLog((prev) => [...prev, `[${ts}] ${msg}`].slice(-200));
  }, []);

  const lines = useMemo(
    () =>
      lastForm.scriptText
        .split(/\r?\n+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    [lastForm.scriptText],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    appendLog("Cancel requested — finishing in-flight tasks before stopping…");
  }, [appendLog]);

  /**
   * Process a single line: cache-check → task-recover → submit with
   * retries. Returns the audio URL on success, throws after exhausting
   * retries. Updates both ``lineStates`` (UI) and ``lineCache``
   * (persistent) as it goes. Never kills the wider batch — callers
   * decide what to do with failures.
   */
  const processLine = useCallback(
    async (
      config: VoiceApiConfig,
      lineIndex: number,
      text: string,
      voiceId: string,
      modelId: string,
      signal: AbortSignal,
    ): Promise<string> => {
      const fp = fingerprintLine(text, voiceId, modelId);
      // Read freshest cache via functional setState pattern.
      let cached: CachedLine | undefined;
      setLineCache((prev) => {
        cached = prev.find((e) => e.fingerprint === fp);
        return prev;
      });

      // ── Cache hit (done) — total credit save, no API call needed ──
      // BUT first verify the cached audio_url is still live. ai33.pro
      // (like most TTS providers) returns time-limited signed URLs
      // that expire after a few hours. The task_id, by contrast, stays
      // valid for ~7 days — so if the URL is dead we transparently
      // refresh it via getTask(task_id), still without spending a new
      // credit. Means: cancel a run, come back tomorrow, hit Generate
      // → guaranteed recovery regardless of how stale the URL got.
      if (cached?.status === "done" && cached.audioUrl) {
        let workingUrl = cached.audioUrl;
        // Cheap HEAD probe to see if the cached URL is still alive.
        let urlAlive = false;
        try {
          const head = await fetch(cached.audioUrl, { method: "HEAD" });
          urlAlive = head.ok;
        } catch {
          urlAlive = false;
        }
        if (!urlAlive && cached.taskId) {
          appendLog(
            `Line ${lineIndex + 1}: cached URL expired — refreshing via task ${cached.taskId.slice(0, 8)}… (no credit cost)`,
          );
          try {
            const refreshed = await getTask(config, cached.taskId);
            if (refreshed.status === "done" && refreshed.metadata?.audio_url) {
              workingUrl = refreshed.metadata.audio_url;
              updateCachedTask(fp, {
                audioUrl: workingUrl,
                lastCheckedAt: Date.now(),
              });
              urlAlive = true;
            }
          } catch (err) {
            appendLog(
              `Line ${lineIndex + 1}: URL refresh failed (${err instanceof Error ? err.message.slice(0, 80) : "unknown"}) — will submit fresh.`,
            );
          }
        }
        if (urlAlive) {
          appendLog(
            `Line ${lineIndex + 1}/${lines.length}: ⚡ cache hit — reusing audio (no credit used).`,
          );
          setLineStates((prev) =>
            prev.map((s, idx) =>
              idx === lineIndex
                ? {
                    ...s,
                    status: "done",
                    taskId: cached!.taskId,
                    audioUrl: workingUrl,
                  }
                : s,
            ),
          );
          return workingUrl;
        }
        // If we reach here, both the cached URL is dead AND the task
        // couldn't refresh it. Fall through to fresh submission —
        // costs one credit, but recovers a chapter that would
        // otherwise be permanently broken.
      }

      // ── Cache hit (pending) — try to recover the old task first ──
      // Likely a previous run that timed out / crashed mid-poll. If
      // server-side the task did eventually complete, the audio is
      // ready and the credit was already burned — recovering it costs
      // nothing extra.
      if (cached?.status === "pending" && cached.taskId) {
        try {
          appendLog(
            `Line ${lineIndex + 1}: checking saved task ${cached.taskId.slice(0, 8)}… (credit recovery)`,
          );
          setLineStates((prev) =>
            prev.map((s, idx) =>
              idx === lineIndex
                ? { ...s, status: "polling", taskId: cached!.taskId }
                : s,
            ),
          );
          const existing = await getTask(config, cached.taskId);
          if (existing.status === "done" && existing.metadata?.audio_url) {
            const url = existing.metadata.audio_url;
            updateCachedTask(fp, {
              status: "done",
              audioUrl: url,
              lastCheckedAt: Date.now(),
            });
            setLineStates((prev) =>
              prev.map((s, idx) =>
                idx === lineIndex
                  ? { ...s, status: "done", audioUrl: url }
                  : s,
              ),
            );
            appendLog(
              `Line ${lineIndex + 1}: ✓ recovered audio from previous task — credit saved!`,
            );
            return url;
          }
          if (existing.status === "failed") {
            appendLog(
              `Line ${lineIndex + 1}: previous task failed server-side — submitting fresh.`,
            );
            updateCachedTask(fp, {
              status: "failed",
              lastCheckedAt: Date.now(),
            });
          }
          // Still pending → fall through to fresh submission
        } catch (err) {
          appendLog(
            `Line ${lineIndex + 1}: recovery check failed (${err instanceof Error ? err.message.slice(0, 80) : "unknown"}) — submitting fresh.`,
          );
        }
      }

      // ── Fresh submission with up to MAX_LINE_ATTEMPTS retries ──
      let lastErr: unknown;
      for (let attempt = 1; attempt <= MAX_LINE_ATTEMPTS; attempt++) {
        if (signal.aborted) throw new Error("Aborted by user");
        setLineStates((prev) =>
          prev.map((s, idx) =>
            idx === lineIndex ? { ...s, status: "creating" } : s,
          ),
        );
        if (attempt === 1) {
          appendLog(
            `Line ${lineIndex + 1}/${lines.length}: creating TTS task…`,
          );
        } else {
          appendLog(
            `Line ${lineIndex + 1}: retry ${attempt}/${MAX_LINE_ATTEMPTS} after backoff…`,
          );
        }
        try {
          const task = await generateSpeech(config, {
            voiceId,
            text,
            modelId,
            signal,
            // Persist task_id IMMEDIATELY so even if the app crashes
            // mid-poll we can recover the audio on next run.
            onTaskCreated: (taskId) => {
              recordCachedTask({
                fingerprint: fp,
                text,
                voiceId,
                modelId,
                taskId,
                status: "pending",
                createdAt: Date.now(),
                lastCheckedAt: Date.now(),
              });
              setLineStates((prev) =>
                prev.map((s, idx) =>
                  idx === lineIndex ? { ...s, taskId, status: "polling" } : s,
                ),
              );
            },
            onPoll: (t) => {
              if (t.status === "processing" || t.status === "pending") {
                setLineStates((prev) =>
                  prev.map((s, idx) =>
                    idx === lineIndex
                      ? { ...s, status: "polling", taskId: t.id }
                      : s,
                  ),
                );
              }
            },
          });
          const url = task.metadata?.audio_url;
          if (!url) {
            throw new Error("Task completed without an audio_url");
          }
          updateCachedTask(fp, {
            status: "done",
            audioUrl: url,
            taskId: task.id,
            lastCheckedAt: Date.now(),
          });
          setLineStates((prev) =>
            prev.map((s, idx) =>
              idx === lineIndex
                ? { ...s, status: "done", taskId: task.id, audioUrl: url }
                : s,
            ),
          );
          appendLog(`Line ${lineIndex + 1}/${lines.length}: ✓ ready`);
          return url;
        } catch (err) {
          lastErr = err;
          if (signal.aborted) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          appendLog(
            `Line ${lineIndex + 1}: attempt ${attempt} failed — ${msg.slice(0, 120)}`,
          );
          if (attempt < MAX_LINE_ATTEMPTS) {
            // Exponential-ish backoff: 5s, 10s, 15s.
            await new Promise((r) =>
              setTimeout(r, RETRY_BACKOFF_MS * attempt),
            );
          }
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(String(lastErr ?? "unknown error"));
    },
    [appendLog, lines.length, recordCachedTask, updateCachedTask],
  );

  /**
   * Decode + concatenate the per-line audio URLs into a single WAV,
   * build the matching SRT, and surface both as a ``stitchResult`` for
   * the Output card. Pulled out so it can be reused after a retry pass
   * completes successfully.
   */
  const stitchAndBuild = useCallback(
    async (audioUrls: string[]) => {
      appendLog(
        `Stitching ${audioUrls.length} clips with ${lastForm.silenceMs}ms silence…`,
      );
      const stitch: StitchResult = await fetchDecodeStitch({
        urls: audioUrls,
        silenceMs: lastForm.silenceMs,
        onLineDecoded: (current, total, durationMs) => {
          appendLog(
            `  Decoded ${current}/${total} (${(durationMs / 1000).toFixed(1)}s)`,
          );
          setLineStates((prev) =>
            prev.map((s, idx) =>
              idx === current - 1 ? { ...s, durationMs } : s,
            ),
          );
        },
      });

      const srt = buildSrt({
        lines,
        durationsMs: stitch.durationsMs,
        silenceGapMs: lastForm.silenceMs,
      });

      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      setStitchResult({
        blob: stitch.wavBlob,
        filename: `tts_${ts}.wav`,
        srt,
        srtFilename: `tts_${ts}.srt`,
        totalMs: stitch.totalDurationMs,
      });

      appendLog(
        `✓ All done. Final audio ${(stitch.totalDurationMs / 1000).toFixed(1)}s, ` +
          `${(stitch.wavBlob.size / 1024 / 1024).toFixed(1)} MB. Click Download.`,
      );
    },
    [appendLog, lastForm.silenceMs, lines],
  );

  /**
   * Run ``processLine`` for the given set of line indices using a
   * shared worker pool of size ``concurrency``. Workers claim the
   * next-pending index atomically; per-line failures are recorded but
   * don't kill the pool. Returns the indices that ultimately failed.
   *
   * Order safety: results are written by index, never by completion
   * order, so the audioUrls array stays line-aligned for stitching.
   */
  const runWorkerPool = useCallback(
    async (
      config: VoiceApiConfig,
      indicesToProcess: number[],
      voiceId: string,
      modelId: string,
      concurrency: number,
      signal: AbortSignal,
      audioUrls: (string | null)[],
    ): Promise<number[]> => {
      const failedIndices: number[] = [];
      let claimPos = 0;
      const claimNext = (): number | null => {
        if (signal.aborted) return null;
        if (claimPos >= indicesToProcess.length) return null;
        return indicesToProcess[claimPos++];
      };

      const workerCount = Math.max(
        1,
        Math.min(concurrency, indicesToProcess.length),
      );

      const worker = async (workerId: number): Promise<void> => {
        // Tiny stagger between worker starts so the initial burst
        // doesn't slam ai33's submission endpoint with N requests in
        // the same millisecond — spreads to ~50ms gaps for the first
        // wave. After that, completion timing naturally spreads them.
        await new Promise((r) => setTimeout(r, workerId * 50));
        while (true) {
          if (signal.aborted) return;
          const i = claimNext();
          if (i === null) return;
          try {
            const url = await processLine(
              config,
              i,
              lines[i],
              voiceId,
              modelId,
              signal,
            );
            audioUrls[i] = url;
          } catch (err) {
            if (signal.aborted) return;
            const msg = err instanceof Error ? err.message : String(err);
            setLineStates((prev) =>
              prev.map((s, idx) =>
                idx === i ? { ...s, status: "failed", error: msg } : s,
              ),
            );
            appendLog(
              `Line ${i + 1}: ✗ all ${MAX_LINE_ATTEMPTS} attempts failed — pool will continue with next line.`,
            );
            failedIndices.push(i);
          }
        }
      };

      await Promise.all(
        Array.from({ length: workerCount }, (_, id) => worker(id)),
      );
      return failedIndices;
    },
    [appendLog, lines, processLine],
  );

  const generate = useCallback(async () => {
    if (busy) return;
    if (!apiKey.trim()) {
      appendLog("ERROR: API key is missing.");
      return;
    }
    if (!lastForm.voiceId) {
      appendLog("ERROR: select a voice first.");
      return;
    }
    if (lines.length === 0) {
      appendLog("ERROR: script is empty.");
      return;
    }

    setBusy(true);
    setStitchResult(null);
    setLineStates(
      lines.map((text, i) => ({
        index: i,
        text,
        status: "pending",
      })),
    );
    setLog([]);
    const concurrency = Math.max(
      1,
      Math.min(MAX_CONCURRENCY, lastForm.concurrency || DEFAULT_CONCURRENCY),
    );
    appendLog(
      `Starting TTS for ${lines.length} line(s) with voice ${lastForm.voiceId} — ${concurrency}× parallel workers.`,
    );
    const t0 = Date.now();

    abortRef.current = new AbortController();
    const config: VoiceApiConfig = {
      apiKey: apiKey.trim(),
      baseUrl: lastForm.baseUrl,
    };

    const audioUrls: (string | null)[] = new Array(lines.length).fill(null);
    const allIndices = Array.from({ length: lines.length }, (_, i) => i);

    // Wake lock + silent audio keepalive — keeps the browser tab at
    // near-foreground priority even when the user switches tabs.
    // Without this, a 600-line script that takes 8 min foreground
    // can balloon to 40+ min if the user tabs away mid-run.
    const keepAwake = await acquireKeepAwake();
    appendLog(
      `Keep-awake activated (wake-lock: ${keepAwake.wakeLockAcquired}, silent-audio: ${keepAwake.silentAudioActive}) — tab will stay fast in background.`,
    );

    try {
      const failedIndices = await runWorkerPool(
        config,
        allIndices,
        lastForm.voiceId,
        lastForm.modelId,
        concurrency,
        abortRef.current.signal,
        audioUrls,
      );

      if (abortRef.current.signal.aborted) {
        appendLog("Aborted by user.");
        return;
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (failedIndices.length > 0) {
        appendLog(
          `⚠ Pool finished in ${elapsed}s with ${failedIndices.length} failed line(s). Click "Retry failed" to re-run just those.`,
        );
        return;
      }

      appendLog(
        `✓ All ${lines.length} lines generated in ${elapsed}s. Stitching now…`,
      );
      await stitchAndBuild(audioUrls as string[]);
    } catch (err) {
      appendLog(
        `FATAL: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await keepAwake.release();
      setBusy(false);
      abortRef.current = null;
    }
  }, [
    apiKey,
    lastForm,
    lines,
    busy,
    appendLog,
    runWorkerPool,
    stitchAndBuild,
  ]);

  /**
   * Re-run only the lines currently marked "failed". Cache lookups
   * inside ``processLine`` will skip any line whose audio is already
   * cached, so this also handles the "page reloaded mid-batch" case.
   * If all lines end up done after the retry, auto-stitch.
   */
  const retryFailed = useCallback(async () => {
    if (busy) return;
    if (!apiKey.trim() || !lastForm.voiceId) return;

    const failedIndices = lineStatesRef.current
      .map((s, idx) => (s.status === "failed" ? idx : -1))
      .filter((i) => i >= 0);
    if (failedIndices.length === 0) return;

    setBusy(true);
    setStitchResult(null);
    abortRef.current = new AbortController();
    const config: VoiceApiConfig = {
      apiKey: apiKey.trim(),
      baseUrl: lastForm.baseUrl,
    };

    const concurrency = Math.max(
      1,
      Math.min(MAX_CONCURRENCY, lastForm.concurrency || DEFAULT_CONCURRENCY),
    );
    appendLog(
      `Retrying ${failedIndices.length} failed line(s) with ${Math.min(concurrency, failedIndices.length)}× parallel workers…`,
    );
    const t0 = Date.now();

    // Reset state for the lines we're retrying so the UI shows them
    // as in-flight again.
    setLineStates((prev) =>
      prev.map((s, idx) =>
        failedIndices.includes(idx)
          ? { ...s, status: "pending", error: undefined }
          : s,
      ),
    );

    // Sparse array indexed by line index — workers fill in the URLs
    // they generate; we read the final URL list off lineStatesRef
    // (which gets updated inside processLine) after the pool drains.
    const audioUrls: (string | null)[] = new Array(lines.length).fill(null);

    try {
      await runWorkerPool(
        config,
        failedIndices,
        lastForm.voiceId,
        lastForm.modelId,
        concurrency,
        abortRef.current.signal,
        audioUrls,
      );

      if (abortRef.current.signal.aborted) return;

      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      // Check if everything's green now — if yes, auto-stitch.
      const latest = lineStatesRef.current;
      const allDone = latest.every((s) => s.status === "done");
      if (allDone) {
        const urls = latest.map((s) => s.audioUrl!).filter(Boolean);
        if (urls.length === latest.length) {
          appendLog(`✓ Retry finished in ${elapsed}s — all green. Stitching…`);
          await stitchAndBuild(urls);
        }
      } else {
        const stillFailed = latest.filter((s) => s.status === "failed").length;
        appendLog(
          `⚠ Retry finished in ${elapsed}s — ${stillFailed} line(s) still failing. Try once more, or remove them from the script.`,
        );
      }
    } catch (err) {
      appendLog(
        `FATAL: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, apiKey, lastForm, lines, appendLog, runWorkerPool, stitchAndBuild]);

  // Trigger a blob download with the given filename.
  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  // Object URL for the in-line audio player — recomputed when blob changes.
  const playerUrl = useMemo(() => {
    if (!stitchResult) return null;
    return URL.createObjectURL(stitchResult.blob);
  }, [stitchResult]);
  useEffect(() => {
    if (!playerUrl) return;
    return () => URL.revokeObjectURL(playerUrl);
  }, [playerUrl]);

  // ---- render ------------------------------------------------------

  return (
    <div className="space-y-8">
      <Section title="Step 1 — API key (ai33.pro)">
        <div className="space-y-2">
          <label className="block text-xs font-medium text-zinc-400">
            <KeyRound className="mr-1 inline h-3 w-3" />
            xi-api-key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your ai33 / ElevenLabs API key"
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex items-center gap-3 text-[11px] text-zinc-500">
            <span>Stored locally in your browser.</span>
            <a
              href="https://ai33.pro"
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:text-blue-300"
            >
              Get a key →
            </a>
          </div>
          <details className="text-[11px] text-zinc-500">
            <summary className="cursor-pointer">Advanced — base URL</summary>
            <input
              type="text"
              value={lastForm.baseUrl}
              onChange={(e) => updateForm({ baseUrl: e.target.value })}
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-300"
            />
          </details>
        </div>
      </Section>

      <Section title="Step 2 — Voice + model">
        <div className="space-y-4">
          {/* Voice dropdown loaded from /v2/voices */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                <Mic className="mr-1 inline h-3 w-3" />
                Voice (from your library)
              </label>
              <select
                value={lastForm.voiceId}
                onChange={(e) => updateForm({ voiceId: e.target.value })}
                disabled={voicesLoading || voices.length === 0}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              >
                {voices.length === 0 ? (
                  <option value="">
                    {voicesLoading ? "Loading…" : "Add API key to load voices"}
                  </option>
                ) : (
                  voices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name}
                      {v.category ? ` — ${v.category}` : ""}
                    </option>
                  ))
                )}
              </select>
            </div>
            <button
              type="button"
              onClick={reloadVoices}
              disabled={voicesLoading || !apiKey.trim()}
              className="flex h-9 items-center gap-1 rounded border border-zinc-700 px-2 text-xs text-zinc-300 hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
              title="Reload voice list"
            >
              {voicesLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Reload
            </button>
          </div>
          {voicesError && (
            <div className="rounded bg-red-950/40 px-2 py-1 text-[11px] text-red-300">
              {voicesError}
            </div>
          )}

          {/* Custom voice — paste any voice_id (from ElevenLabs voice
              library, community voices, etc.) + a label of your
              choosing. Lookup is optional — many shared voices return
              404 on metadata lookup but still work with the TTS
              endpoint, so saving is always available. */}
          <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3">
            <label className="mb-2 block text-xs font-medium text-zinc-400">
              <Search className="mr-1 inline h-3 w-3" />
              Add custom voice (paste ID, give it a name, save)
            </label>

            <div className="space-y-2">
              {/* Voice name — always visible. */}
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Voice name (label of your choice)
                </label>
                <input
                  type="text"
                  value={customVoiceName}
                  onChange={(e) => setCustomVoiceName(e.target.value)}
                  placeholder="e.g. Brahma deep narrator"
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {/* Voice ID — always visible. */}
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-zinc-500">
                  Voice ID
                </label>
                <input
                  type="text"
                  value={customVoiceId}
                  onChange={(e) => {
                    setCustomVoiceId(e.target.value);
                    setLookupResult(null);
                    setLookupError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveCustom();
                    }
                  }}
                  placeholder="Paste voice_id, e.g. 21m00Tcm4TlvDq8ikWAM"
                  className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
                />
              </div>

              {/* Save + (optional) Lookup — Save is the primary action. */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={saveCustom}
                  disabled={!customVoiceId.trim() || !customVoiceName.trim()}
                  className="flex h-8 items-center gap-1 rounded bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                  title="Save to favourites and use as current voice"
                >
                  <Star className="h-3 w-3" />
                  Save to favourites
                </button>
                <button
                  type="button"
                  onClick={lookupVoice}
                  disabled={lookupBusy || !customVoiceId.trim() || !apiKey.trim()}
                  className="flex h-8 items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Optional — verify the voice exists and auto-fill the name"
                >
                  {lookupBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Search className="h-3 w-3" />
                  )}
                  Verify (optional)
                </button>
                <span className="text-[10px] text-zinc-500">
                  Tip: shared voices often 404 on Verify but still play
                  via Save.
                </span>
              </div>

              {/* Status — non-blocking. Save remains usable regardless. */}
              {lookupError && (
                <div className="rounded bg-red-950/40 px-2 py-1 text-[11px] text-red-300">
                  Verify failed: {lookupError}
                  <div className="mt-0.5 text-amber-300/90">
                    No problem — type a name above and click Save to favourites.
                  </div>
                </div>
              )}
              {lookupResult && !lookupError && (
                <div className="rounded border border-emerald-700/40 bg-emerald-950/30 px-2 py-1.5 text-[11px] text-emerald-200">
                  ✓ Verified: <span className="font-semibold">{lookupResult.name}</span>
                  {lookupResult.category && (
                    <span className="ml-1 text-[10px] text-emerald-300/70">
                      ({lookupResult.category})
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Favourites — always-visible prominent card. Shows every
              custom voice the user has saved (via Save to favourites
              above) so they can click one to instantly switch voices.
              When empty, displays a hint pointing back at the save UI. */}
          <div className="rounded-lg border border-amber-700/30 bg-amber-950/10 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-200">
                <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                Favourites
                <span className="text-[11px] font-normal text-amber-300/70">
                  ({favourites.length})
                </span>
              </div>
              {favourites.length > 0 && (
                <button
                  type="button"
                  onClick={clearAllFavourites}
                  className="text-[10px] text-zinc-500 underline hover:text-red-400"
                  title="Remove all saved favourites"
                >
                  Clear all
                </button>
              )}
            </div>

            {favourites.length === 0 ? (
              <div className="rounded border border-dashed border-zinc-700 bg-zinc-950/40 px-3 py-4 text-center text-[11px] text-zinc-500">
                No favourites yet. Paste a voice ID above, give it a
                name, and click{" "}
                <span className="font-semibold text-amber-300">
                  Save to favourites
                </span>{" "}
                — it will appear here for one-click re-use.
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {favourites.map((fav) => {
                  const isActive = lastForm.voiceId === fav.voice_id;
                  return (
                    <div
                      key={fav.voice_id}
                      className={clsx(
                        "group flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition",
                        isActive
                          ? "border-amber-500/60 bg-amber-950/40 text-amber-200"
                          : "border-zinc-700 bg-zinc-900/60 text-zinc-300 hover:border-zinc-500",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => selectFavourite(fav)}
                        className="font-medium"
                        title={`Voice ID: ${fav.voice_id}`}
                      >
                        {isActive && (
                          <Star className="mr-1 inline h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                        )}
                        {fav.name}
                        {fav.category && (
                          <span className="ml-1 text-[9px] opacity-60">
                            {fav.category}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeFavourite(fav.voice_id)}
                        className="opacity-60 transition hover:opacity-100 group-hover:opacity-100"
                        title="Remove from favourites"
                      >
                        <Trash2 className="h-2.5 w-2.5 text-zinc-500 hover:text-red-400" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Model picker — all 6 ElevenLabs models with descriptions */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Model
            </label>
            <select
              value={lastForm.modelId}
              onChange={(e) => updateForm({ modelId: e.target.value })}
              className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
            >
              {COMMON_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.description}
                </option>
              ))}
            </select>
            {/* Inline description card for the currently-selected model */}
            {(() => {
              const selected = COMMON_MODELS.find(
                (m) => m.id === lastForm.modelId,
              );
              if (!selected) return null;
              const tagStyles: Record<ModelInfo["tag"], string> = {
                "high-quality": "bg-emerald-950 text-emerald-300",
                newest: "bg-purple-950 text-purple-300",
                turbo: "bg-amber-950 text-amber-300",
              };
              return (
                <div className="mt-1.5 flex items-start gap-2 rounded bg-zinc-950/60 px-2 py-1.5 text-[11px] text-zinc-400">
                  <span
                    className={clsx(
                      "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                      tagStyles[selected.tag],
                    )}
                  >
                    {selected.tag}
                  </span>
                  <span className="leading-relaxed">{selected.description}</span>
                </div>
              );
            })()}
          </div>
        </div>
      </Section>

      <Section title="Step 3 — Script (one beat per line)">
        <textarea
          value={lastForm.scriptText}
          onChange={(e) => updateForm({ scriptText: e.target.value })}
          placeholder={
            "Paste your script.txt here — one beat per line.\n\n" +
            "What if the strongest warrior was just a hungry barbarian?\n" +
            "Ketal stepped into the frozen wasteland alone.\n" +
            "Every step left a trail of monster blood behind him."
          }
          rows={10}
          className="w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-blue-500 focus:outline-none"
        />
        <div className="mt-1 text-[11px] text-zinc-500">
          <span className="font-semibold text-zinc-300">{lines.length}</span>{" "}
          line{lines.length === 1 ? "" : "s"} detected (blank lines ignored)
        </div>
      </Section>

      <Section title="Step 4 — Generation options">
        <div className="space-y-5">
          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-400">
              Silence between lines:{" "}
              <span className="font-mono text-zinc-200">
                {lastForm.silenceMs} ms
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={1000}
              step={25}
              value={lastForm.silenceMs}
              onChange={(e) =>
                updateForm({ silenceMs: parseInt(e.target.value, 10) })
              }
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600">
              <span>0 ms (no gap)</span>
              <span>500 ms (natural pause)</span>
              <span>1000 ms (long pause)</span>
            </div>
          </div>

          {/* Parallel workers — biggest speed lever. Cost stays the
              same (per-character billing); only wall-clock time
              changes. 5 is the safe default, 10 is "I want it now". */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-zinc-400">
              Parallel workers:{" "}
              <span className="font-mono text-amber-300">
                {lastForm.concurrency}×
              </span>
              <span className="ml-2 text-[10px] font-normal text-zinc-500">
                (more workers = faster, same credit cost)
              </span>
            </label>
            <input
              type="range"
              min={1}
              max={MAX_CONCURRENCY}
              step={1}
              value={lastForm.concurrency}
              onChange={(e) =>
                updateForm({ concurrency: parseInt(e.target.value, 10) })
              }
              className="w-full accent-amber-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600">
              <span>1× (safe)</span>
              <span>5× (recommended)</span>
              <span>{MAX_CONCURRENCY}× (max speed)</span>
            </div>
            {lines.length > 0 && (
              <div className="rounded bg-zinc-950/40 px-2 py-1.5 text-[11px] text-zinc-400">
                Estimated time for {lines.length} line
                {lines.length === 1 ? "" : "s"}:{" "}
                <span className="font-mono text-emerald-300">
                  {(() => {
                    // Rough estimate: each line ≈ 3-5 sec wall-clock
                    // (submit + poll + download) at Turbo. Pool spreads
                    // evenly across workers.
                    const perLineSec = 4;
                    const totalSec =
                      (lines.length * perLineSec) /
                      Math.max(1, lastForm.concurrency);
                    if (totalSec < 60) return `~${Math.round(totalSec)} sec`;
                    return `~${Math.round(totalSec / 60)} min`;
                  })()}
                </span>
                {lastForm.concurrency >= 8 && (
                  <span className="ml-2 text-amber-400">
                    ⚠ aggressive — bump down if you see 429s
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </Section>

      <Section title="Step 5 — Generate">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            {!busy ? (
              <button
                type="button"
                onClick={generate}
                disabled={
                  !apiKey.trim() || !lastForm.voiceId || lines.length === 0
                }
                className="flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
              >
                <Play className="h-4 w-4" />
                Generate voice{" "}
                {lines.length > 0 ? `(${lines.length} lines)` : ""}
              </button>
            ) : (
              <button
                type="button"
                onClick={cancel}
                className="flex items-center gap-2 rounded bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500"
              >
                <Square className="h-4 w-4" />
                Cancel
              </button>
            )}

            {/* Retry-failed — only shows when batch finished with some
                failures. Re-runs just the failed ones (cached lines
                are skipped automatically by processLine). */}
            {!busy &&
              lineStates.some((l) => l.status === "failed") && (
                <button
                  type="button"
                  onClick={retryFailed}
                  className="flex items-center gap-2 rounded bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500"
                  title="Retry only the lines that failed; cached lines are skipped"
                >
                  <RotateCcw className="h-4 w-4" />
                  Retry {lineStates.filter((l) => l.status === "failed").length}{" "}
                  failed
                </button>
              )}

            {busy && (
              <span className="text-xs text-zinc-400">
                {lineStates.filter((l) => l.status === "done").length} /{" "}
                {lineStates.length} done
                {lineStates.filter((l) => l.status === "failed").length > 0 && (
                  <span className="ml-2 text-red-400">
                    ({lineStates.filter((l) => l.status === "failed").length}{" "}
                    failed)
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500">
            One failed line no longer kills the batch — processing continues,
            and each line auto-retries up to {MAX_LINE_ATTEMPTS}× before being
            marked failed. Task IDs are persisted so credits are recoverable
            even after a crash.
          </div>
          {lineCache.length > 0 && (
            <div className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[11px] text-zinc-500">
              <span>
                <span className="font-mono text-zinc-300">
                  {lineCache.filter((c) => c.status === "done").length}
                </span>{" "}
                cached audio clips
                {lineCache.filter((c) => c.status === "pending").length > 0 && (
                  <span className="ml-2 text-amber-400">
                    + {lineCache.filter((c) => c.status === "pending").length}{" "}
                    pending (recoverable)
                  </span>
                )}{" "}
                — re-runs skip the API call for unchanged lines.
              </span>
              <button
                type="button"
                onClick={clearCache}
                className="underline hover:text-red-400"
                title="Clear all cached audio URLs and task IDs"
              >
                Clear cache
              </button>
            </div>
          )}
        </div>
      </Section>

      {/* Output card */}
      {stitchResult && (
        <Section title="Output">
          <div className="rounded border border-emerald-700/50 bg-emerald-950/30 px-4 py-3">
            <div className="mb-2 text-sm font-medium text-emerald-200">
              ✓ Audio ready — {(stitchResult.totalMs / 1000).toFixed(1)}s,{" "}
              {(stitchResult.blob.size / 1024 / 1024).toFixed(1)} MB
            </div>
            {playerUrl && (
              <audio
                controls
                src={playerUrl}
                className="mb-3 w-full"
              />
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  triggerDownload(stitchResult.blob, stitchResult.filename)
                }
                className="flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                <Download className="h-3 w-3" />
                Download audio (.wav)
              </button>
              <button
                type="button"
                onClick={() =>
                  triggerDownload(
                    new Blob([stitchResult.srt], { type: "text/plain" }),
                    stitchResult.srtFilename,
                  )
                }
                className="flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
              >
                <Download className="h-3 w-3" />
                Download SRT
              </button>
            </div>
          </div>
        </Section>
      )}

      {/* Per-line status */}
      {lineStates.length > 0 && (
        <Section title="Line status">
          <div className="max-h-72 overflow-y-auto rounded border border-zinc-800 bg-zinc-900/40">
            <table className="w-full text-xs">
              <thead className="bg-zinc-900/80 text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5 text-left">Line</th>
                  <th className="px-2 py-1.5 text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {lineStates.map((s) => (
                  <tr key={s.index} className="border-t border-zinc-800/60">
                    <td className="px-2 py-1 text-zinc-500">{s.index + 1}</td>
                    <td className="px-2 py-1">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-2 py-1 text-zinc-300">
                      <span className="line-clamp-2 block max-w-md">
                        {s.text}
                      </span>
                      {s.error && (
                        <span className="text-[10px] text-red-400">
                          {s.error}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right text-zinc-500">
                      {s.durationMs != null
                        ? `${(s.durationMs / 1000).toFixed(1)}s`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Activity log */}
      {log.length > 0 && (
        <Section title="Activity log">
          <pre className="max-h-60 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-400">
            {log.join("\n")}
          </pre>
        </Section>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: LineState["status"] }) {
  const styles: Record<LineState["status"], string> = {
    pending: "bg-zinc-800 text-zinc-400",
    creating: "bg-blue-950 text-blue-300",
    polling: "bg-amber-950 text-amber-300",
    done: "bg-emerald-950 text-emerald-300",
    failed: "bg-red-950 text-red-300",
  };
  return (
    <span
      className={clsx(
        "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  );
}
