// Preload script — runs in an isolated context BEFORE the renderer
// loads the React bundle. Use ``contextBridge.exposeInMainWorld`` here
// to safely expose narrow APIs to the renderer if/when we need OS
// integration (e.g. file picker, native notifications, app version).
//
// Right now the renderer is fully self-contained (PDF.js in-browser,
// Gemini over fetch, JSZip for archives, localStorage for state), so
// we expose only a stub for future use.

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("manhwaApp", {
  /** True when running inside the Electron desktop wrapper. */
  isDesktop: true,
  /** Platform string from process.platform — "win32" / "darwin" / "linux". */
  platform: process.platform,
  /** App version pulled from package.json at packaging time. */
  version: process.env.npm_package_version || "0.0.0",
});
