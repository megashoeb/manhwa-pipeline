// Preload script — runs in an isolated context BEFORE the renderer
// loads the React bundle. Bridges narrow OS-level APIs to the renderer
// via ``contextBridge.exposeInMainWorld``.
//
// What's exposed:
//   • ``isDesktop`` / ``platform`` / ``version`` — env flags so the
//     renderer can branch UI when running as a packaged app.
//   • ``diskCheckpoint`` — disk-level persistence for power-cut
//     recovery. The renderer keeps IndexedDB as its primary store and
//     mirrors every checkpoint to disk in parallel. On a fresh
//     browser cache (or IDB eviction) the renderer falls back to disk
//     to recover sessions.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("manhwaApp", {
  /** True when running inside the Electron desktop wrapper. */
  isDesktop: true,
  /** Platform string from process.platform — "win32" / "darwin" / "linux". */
  platform: process.platform,
  /** App version pulled from package.json at packaging time. */
  version: process.env.npm_package_version || "0.0.0",

  /**
   * Disk-level checkpoint storage. Each call routes through the main
   * process via IPC — file I/O can't run in the sandboxed renderer.
   */
  diskCheckpoint: {
    /** Write/overwrite the session metadata JSON. */
    saveMeta: (sessionId, meta) =>
      ipcRenderer.invoke("checkpoint:save-meta", sessionId, meta),
    /**
     * Persist one chapter's data. ``entry`` is the
     * CombinedChapterEntry minus its Blob array; ``blobBuffers`` is
     * an array of ArrayBuffers (one per blob) — they get written out
     * as real JPEGs on disk, browsable in Explorer/Finder.
     */
    writeChapter: (sessionId, chapterIndex, entry, blobBuffers) =>
      ipcRenderer.invoke(
        "checkpoint:write-chapter",
        sessionId,
        chapterIndex,
        entry,
        blobBuffers,
      ),
    /** Read everything for one session — meta + array of {entry, blobBuffers}. */
    readSession: (sessionId) =>
      ipcRenderer.invoke("checkpoint:read-session", sessionId),
    /** List every session on disk (any with a meta.json file). */
    listSessions: () => ipcRenderer.invoke("checkpoint:list-sessions"),
    /** Delete the session folder + all chapter subfolders. */
    deleteSession: (sessionId) =>
      ipcRenderer.invoke("checkpoint:delete-session", sessionId),
    /** Absolute path to the base checkpoint dir (for showing in UI). */
    baseDir: () => ipcRenderer.invoke("checkpoint:base-dir"),
    /** Open the checkpoint folder in Explorer/Finder. */
    openFolder: (sessionId) =>
      ipcRenderer.invoke("checkpoint:open-folder", sessionId),
  },
});
