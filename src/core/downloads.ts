// Browser-side ZIP downloads for the manhwa pipeline.
//
// Two flavours:
//   • downloadKeptImagesZip — just the cleaned/cropped panels, named
//     sequentially (0001.jpg, 0002.jpg, …) so the CapCut auto-sync
//     tool sees them in the same order as the narration lines and
//     SRT blocks downstream.
//   • downloadFullOutputs — everything the user needs to feed into
//     the rest of the workflow: images, script.txt, bible.json,
//     manifest.json, plus a README explaining the next steps.
//
// JSZip handles the archive creation client-side; nothing is uploaded.

import JSZip from "jszip";

import type {
  FilteredPage,
  FilterStats,
  ScriptResult,
} from "../types/manhwa";

/** Browser-friendly chapter slug for filenames. */
function basename(filename: string | null | undefined): string {
  if (!filename) return "chapter";
  return filename.replace(/\.pdf$/i, "").trim() || "chapter";
}

/** Trigger a normal browser download for an in-memory Blob. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The URL must outlive the click handler chain; revoke shortly after.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Download every kept panel as a single ZIP.
 *
 * Files inside are named ``0001.jpg``, ``0002.jpg`` … in the same
 * order they would appear in the narration script. This is the
 * format CapCut-style auto-sync tools expect when matching N images
 * to N SRT blocks.
 *
 * Optional progress callback fires as each panel is added so the UI
 * can show a "{n} of {total}" message during large archives.
 */
export interface DownloadCallbacks {
  /** Per-file progress within the ZIP build. */
  onProgress?: (current: number, total: number) => void;
  /**
   * Fired with the finished blob + filename. When this is provided the
   * function does NOT trigger a browser auto-download — the caller
   * is expected to expose a manual "Download" button using the blob.
   */
  onArchiveReady?: (blob: Blob, filename: string) => void;
}

export async function downloadKeptImagesZip(
  pages: FilteredPage[],
  filename: string | null,
  onProgressOrCallbacks?:
    | ((current: number, total: number) => void)
    | DownloadCallbacks,
): Promise<void> {
  const callbacks: DownloadCallbacks =
    typeof onProgressOrCallbacks === "function"
      ? { onProgress: onProgressOrCallbacks }
      : (onProgressOrCallbacks ?? {});
  const kept = pages.filter((p) => p.kept);
  if (kept.length === 0) {
    throw new Error("No kept pages to download. Adjust filter settings first.");
  }

  const zip = new JSZip();
  for (let i = 0; i < kept.length; i++) {
    const seq = String(i + 1).padStart(4, "0");
    zip.file(`${seq}.jpg`, kept[i].blob);
    callbacks.onProgress?.(i + 1, kept.length);
  }

  // ZIP_STORED is fastest and JPEGs barely compress anyway. We use
  // the default (DEFLATE level 6) here just in case future outputs
  // include text/JSON that would compress meaningfully.
  const archive = await zip.generateAsync({ type: "blob" });
  const archiveFilename = `${basename(filename)}_images.zip`;
  if (callbacks.onArchiveReady) {
    // Caller-driven manual download flow.
    callbacks.onArchiveReady(archive, archiveFilename);
  } else {
    saveBlob(archive, archiveFilename);
  }
}

/**
 * Download a full "ready for the rest of the workflow" bundle:
 * cleaned images, the narration script, the character bible, a
 * machine-readable manifest, and a README walking the user through
 * the next step (MegaShoeb TTS → CapCut → upload).
 */
export async function downloadFullOutputs(
  pages: FilteredPage[],
  script: ScriptResult,
  stats: FilterStats,
  filename: string | null,
  onProgressOrCallbacks?:
    | ((current: number, total: number) => void)
    | DownloadCallbacks,
): Promise<void> {
  const callbacks: DownloadCallbacks =
    typeof onProgressOrCallbacks === "function"
      ? { onProgress: onProgressOrCallbacks }
      : (onProgressOrCallbacks ?? {});
  const baseName = basename(filename);
  const kept = pages.filter((p) => p.kept);

  const zip = new JSZip();
  const imagesFolder = zip.folder("final_images");
  if (!imagesFolder)
    throw new Error("Failed to create final_images folder in ZIP");

  // 1) Kept images, sequentially renamed.
  for (let i = 0; i < kept.length; i++) {
    const seq = String(i + 1).padStart(4, "0");
    imagesFolder.file(`${seq}.jpg`, kept[i].blob);
    callbacks.onProgress?.(i + 1, kept.length + 4); // +4 for script/bible/manifest/readme
  }

  // 2) Narration script — the file the user pastes into MegaShoeb TTS.
  zip.file(`${baseName}_script.txt`, script.scriptText);
  callbacks.onProgress?.(kept.length + 1, kept.length + 4);

  // 3) Character bible — useful both for the next chapter's continuity
  //    and for the user to manually patch character names if needed.
  zip.file(
    `${baseName}_bible.json`,
    JSON.stringify(script.bible, null, 2),
  );
  callbacks.onProgress?.(kept.length + 2, kept.length + 4);

  // 4) Manifest — full record of every panel decision + every scene.
  //    Lets the user debug "why was page 14 dropped?" months later.
  const manifest = {
    chapter: baseName,
    generated_at: new Date().toISOString(),
    pipeline_version: "0.4.0",
    stats: {
      total: stats.total,
      kept: stats.kept,
      dropped_blank: stats.droppedBlank,
      dropped_duplicate: stats.droppedDuplicate,
    },
    pages: pages.map((p) => ({
      original_page_index: p.index,
      kept: p.kept,
      reason: p.reason,
      phash: p.phash || null,
      width: p.width,
      height: p.height,
    })),
    scenes: script.scenes.map((s) => ({
      scene_index: s.sceneIndex,
      panel_indices: s.panelIndices,
      lines: s.lines,
    })),
    bible: script.bible,
  };
  zip.file(`${baseName}_manifest.json`, JSON.stringify(manifest, null, 2));
  callbacks.onProgress?.(kept.length + 3, kept.length + 4);

  // 5) README — quick reference for the rest of the workflow.
  zip.file(`README.txt`, buildReadme(baseName, stats, kept.length));
  callbacks.onProgress?.(kept.length + 4, kept.length + 4);

  const archive = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const archiveFilename = `${baseName}_outputs.zip`;
  if (callbacks.onArchiveReady) {
    callbacks.onArchiveReady(archive, archiveFilename);
  } else {
    saveBlob(archive, archiveFilename);
  }
}

function buildReadme(
  baseName: string,
  stats: FilterStats,
  keptCount: number,
): string {
  const fillerPct =
    stats.total > 0
      ? (((stats.droppedBlank + stats.droppedDuplicate) / stats.total) * 100).toFixed(1)
      : "0.0";
  return `# ${baseName} — manhwa pipeline outputs

Generated:  ${new Date().toLocaleString()}
Source:     ${baseName}.pdf

Stats
-----
  Total panels:    ${stats.total}
  Kept:            ${stats.kept}
  Dropped blank:   ${stats.droppedBlank}
  Dropped duplicate: ${stats.droppedDuplicate}
  Filler ratio:    ${fillerPct}%

Files in this archive
---------------------
  final_images/0001.jpg … ${String(keptCount).padStart(4, "0")}.jpg
      Cropped + filtered panels in narration order.
      Drop the entire folder into CapCut for the auto-sync step.

  ${baseName}_script.txt
      The narration script — one sentence per image, ${keptCount} lines.
      Paste into the MegaShoeb TTS server's "Bulk Script → SRT" tab.

  ${baseName}_bible.json
      Character bible used by the narration. Keep this around — it
      can be passed to the next chapter for character continuity.

  ${baseName}_manifest.json
      Full record of every panel (kept/dropped + reason), every scene
      grouping, and the bible. Useful for debugging months later.

Next steps
----------
  1. Unzip this archive somewhere convenient.
  2. Open the MegaShoeb TTS server (e.g. https://omnivoice.bonusalert.org).
  3. Go to the "Bulk Script → SRT" tab.
  4. Paste the contents of ${baseName}_script.txt into the script box.
  5. Pick a voice mode (Voice Clone / Voice Design / Auto).
  6. Click "Generate all". After 5–10 minutes you'll get a single MP3
     plus an SRT file whose block count exactly matches your image count.
  7. In CapCut, import:
       • the final_images/ folder
       • the MP3 from step 6
       • the SRT from step 6
  8. Run your CapCut auto-sync tool. Each subtitle block will map to
     one image — that's the 1:1 invariant this pipeline preserves.
  9. Add SFX, intro/outro, thumbnail, and export.
 10. Upload to YouTube. Don't forget the mandatory description
     disclaimer and the pinned comment with the original manhwa's name.
`;
}
