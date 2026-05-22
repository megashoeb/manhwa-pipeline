// Build an SRT file from per-line MP3 durations + the configurable
// silence gap. Mirrors the OmniVoice "per-line exact" SRT mode: each
// line gets its own subtitle block whose timestamps line up
// exactly with the playhead of the stitched audio.

export interface SrtOptions {
  lines: string[];
  durationsMs: number[];
  /** Silence inserted BETWEEN lines in the stitched audio. */
  silenceGapMs: number;
  /**
   * When true, the subtitle for line i extends into the silence gap
   * that follows it. Mirrors OmniVoice's ``extend_through_silence``.
   * Keeps captions visible during the pause so the viewer never sees
   * a blank screen between lines. Default true.
   */
  extendThroughSilence?: boolean;
}

export function buildSrt(opts: SrtOptions): string {
  const extend = opts.extendThroughSilence ?? true;
  const { lines, durationsMs, silenceGapMs } = opts;

  if (lines.length === 0) return "";

  const blocks: string[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const dur = Math.max(500, durationsMs[i] ?? 1000); // floor at 0.5s
    const start = cursor;
    let end = cursor + dur;
    if (extend && i < lines.length - 1) {
      // Stretch the block through the silence so the viewer's caption
      // stays on screen during the gap.
      end += silenceGapMs;
    }
    blocks.push(
      `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${lines[i]}\n`,
    );
    cursor += dur + silenceGapMs;
  }
  return blocks.join("\n");
}

/**
 * Convert milliseconds to ``HH:MM:SS,mmm`` (the SRT spec). Pads each
 * component to its expected width.
 */
function formatSrtTime(totalMs: number): string {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const remMs = ms % 1000;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(remMs)}`;
}
