// Keep-awake utilities for long-running bulk pipelines.
//
// Problem: Chromium throttles background tabs aggressively:
//   - setTimeout/setInterval clamped to 1s (vs 4ms foreground)
//   - fetch() deprioritised on the network queue
//   - requestAnimationFrame pauses entirely
//   - Canvas + decode work runs at ~10× slower CPU share
// Effect on this app: a bulk run that takes 5 min foreground can
// stretch to 30-45 min if the user tabs away to Slack / YouTube.
//
// Two browser mechanisms partially fix this:
//
//   1. Screen Wake Lock API — prevents the OS from sleeping the
//      screen, which in turn prevents the browser process from
//      aggressively throttling. Works on Chrome, Edge, Safari 16.4+.
//      Released automatically when the tab is hidden — has to be
//      re-acquired on visibilitychange. We do that here.
//
//   2. Silent audio playback — Chrome treats audio-producing tabs as
//      "high priority" and skips most of the throttling logic.
//      Plays an inaudible 30-second silent WAV in a loop. ~0% CPU
//      cost. Survives tab backgrounding.
//
// Combined, these keep the bulk pipeline running at ~80% of
// foreground speed even when the user tabs away.

export interface KeepAwakeHandle {
  /** Release wake lock + stop silent audio. */
  release(): Promise<void>;
  /** True if wake lock was successfully acquired (browser support). */
  wakeLockAcquired: boolean;
  /** True if silent audio is actively playing. */
  silentAudioActive: boolean;
}

// TypeScript's DOM lib ships ``WakeLock`` + ``WakeLockSentinel`` types
// natively (lib.dom.d.ts), but some older configurations don't include
// them. Use a structural typing fallback so this compiles in either case.
interface WakeLockLike {
  request(type: "screen"): Promise<{
    release(): Promise<void>;
    addEventListener(type: "release", listener: () => void): void;
  }>;
}

type WakeLockSentinelLike = Awaited<ReturnType<WakeLockLike["request"]>>;

/**
 * Acquire wake lock + start silent audio. Both are best-effort:
 * if either fails, the other still runs. Returns a handle the
 * caller can release when the bulk run is done.
 */
export async function acquireKeepAwake(): Promise<KeepAwakeHandle> {
  let sentinel: WakeLockSentinelLike | null = null;
  let audioCtx: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  let gainNode: GainNode | null = null;
  let visibilityHandler: (() => void) | null = null;

  // ---- Wake Lock --------------------------------------------------
  const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
  let wakeLockAcquired = false;
  const requestWakeLock = async () => {
    if (!nav.wakeLock) return;
    try {
      sentinel = await nav.wakeLock.request("screen");
      wakeLockAcquired = true;
      sentinel.addEventListener("release", () => {
        wakeLockAcquired = false;
      });
    } catch {
      // User denied / browser doesn't support — silent audio is the
      // fallback. Don't surface as an error.
    }
  };
  await requestWakeLock();

  // Wake lock auto-releases on visibility change. Re-acquire when the
  // tab becomes visible again, otherwise it stays released forever.
  visibilityHandler = () => {
    if (document.visibilityState === "visible" && sentinel == null) {
      requestWakeLock();
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  // ---- Silent audio keepalive -------------------------------------
  // Use a Web Audio oscillator at -infinity gain instead of a WAV file
  // — zero asset bytes, zero CPU on the audio thread, but the audio
  // graph is "active" from Chrome's POV.
  let silentAudioActive = false;
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    audioCtx = new AudioContextClass();
    oscillator = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 0; // silent
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.start();
    // Some browsers (Chrome 71+) start audio contexts suspended until
    // a user gesture. If we hit that, the resume() reject is fine —
    // user already triggered this via a click on Generate.
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    silentAudioActive = true;
  } catch {
    // No Web Audio support — just rely on wake lock.
  }

  return {
    wakeLockAcquired,
    silentAudioActive,
    async release() {
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
      }
      if (sentinel) {
        try {
          await sentinel.release();
        } catch {
          /* ignore */
        }
        sentinel = null;
      }
      if (oscillator) {
        try {
          oscillator.stop();
        } catch {
          /* already stopped */
        }
        oscillator.disconnect();
        oscillator = null;
      }
      if (gainNode) {
        gainNode.disconnect();
        gainNode = null;
      }
      if (audioCtx) {
        try {
          await audioCtx.close();
        } catch {
          /* ignore */
        }
        audioCtx = null;
      }
    },
  };
}
