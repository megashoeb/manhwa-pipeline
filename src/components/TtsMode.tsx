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
  Square,
} from "lucide-react";
import clsx from "clsx";

import {
  generateSpeech,
  listVoices,
  type Voice,
} from "../core/voiceApi";
import {
  fetchDecodeStitch,
  type StitchResult,
} from "../core/voiceAudioStitcher";
import { buildSrt } from "../core/voiceSrtBuilder";
import { readJson, writeJson } from "../core/storage";

const STORAGE_KEY_API = "manhwa.tts.apiKey";
const STORAGE_KEY_FORM = "manhwa.tts.lastForm";

const DEFAULT_MODEL = "eleven_multilingual_v2";
const COMMON_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_turbo_v2",
  "eleven_flash_v2_5",
  "eleven_monolingual_v1",
];

interface LastForm {
  voiceId: string;
  modelId: string;
  scriptText: string;
  silenceMs: number;
  baseUrl: string;
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
  const [lastForm, setLastForm] = useState<LastForm>(() =>
    readJson<LastForm>(STORAGE_KEY_FORM, {
      voiceId: "",
      modelId: DEFAULT_MODEL,
      scriptText: "",
      silenceMs: 150,
      baseUrl: "https://api.ai33.pro",
    }),
  );

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
    appendLog(
      `Starting TTS for ${lines.length} line(s) with voice ${lastForm.voiceId}…`,
    );

    abortRef.current = new AbortController();
    const config = {
      apiKey: apiKey.trim(),
      baseUrl: lastForm.baseUrl,
    };

    try {
      // Generate each line sequentially. ai33.pro charges per call so
      // parallel doesn't save money — and the polling overhead is
      // small enough that sequential is fine for human-listened audio.
      const audioUrls: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (abortRef.current.signal.aborted) {
          appendLog("Aborted by user.");
          break;
        }
        setLineStates((prev) =>
          prev.map((s, idx) =>
            idx === i ? { ...s, status: "creating" } : s,
          ),
        );
        appendLog(`Line ${i + 1}/${lines.length}: creating TTS task…`);

        try {
          const task = await generateSpeech(config, {
            voiceId: lastForm.voiceId,
            text: lines[i],
            modelId: lastForm.modelId,
            signal: abortRef.current.signal,
            onPoll: (t) => {
              if (t.status === "processing" || t.status === "pending") {
                setLineStates((prev) =>
                  prev.map((s, idx) =>
                    idx === i ? { ...s, status: "polling", taskId: t.id } : s,
                  ),
                );
              }
            },
          });
          const url = task.metadata?.audio_url;
          if (!url) {
            throw new Error("Task completed without an audio_url");
          }
          audioUrls.push(url);
          setLineStates((prev) =>
            prev.map((s, idx) =>
              idx === i
                ? {
                    ...s,
                    status: "done",
                    taskId: task.id,
                    audioUrl: url,
                  }
                : s,
            ),
          );
          appendLog(`Line ${i + 1}/${lines.length}: ✓ ready (${url})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setLineStates((prev) =>
            prev.map((s, idx) =>
              idx === i ? { ...s, status: "failed", error: msg } : s,
            ),
          );
          appendLog(`Line ${i + 1}/${lines.length}: ✗ failed — ${msg}`);
          // Stop on first failure — partial stitched audio doesn't
          // make sense for scripted narration.
          throw err;
        }
      }

      if (abortRef.current.signal.aborted) {
        return;
      }

      // ---- Stitch audio + build SRT ------------------------------
      appendLog(`Stitching ${audioUrls.length} clips with ${lastForm.silenceMs}ms silence…`);
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
    } catch (err) {
      appendLog(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [apiKey, lastForm, lines, busy, appendLog]);

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
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                <Mic className="mr-1 inline h-3 w-3" />
                Voice
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
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
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
      </Section>

      <Section title="Step 5 — Generate">
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
              Generate voice {lines.length > 0 ? `(${lines.length} lines)` : ""}
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
          {busy && (
            <span className="text-xs text-zinc-400">
              {lineStates.filter((l) => l.status === "done").length} /{" "}
              {lineStates.length} done
            </span>
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
