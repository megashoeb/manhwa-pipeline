// Electron main process — creates the app window and loads either the
// Vite dev server (during ``npm run electron:dev``) or the built ``dist/``
// folder (in packaged builds).
//
// The renderer is the SAME React app that runs in the browser via
// Vercel — we don't fork the code. The only changes vs. browser:
//   • Vite is configured with ``base: "./"`` so asset URLs work over
//     the ``file://`` protocol Electron uses for packaged builds.
//   • The renderer talks to the OS via ``contextBridge`` only when it
//     actually needs to (currently it doesn't — the app is entirely
//     client-side). Bridge is in ``preload.cjs`` for future hooks.

const { app, BrowserWindow, shell, Menu, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const isDev = process.env.NODE_ENV === "development";

// ---------------------------------------------------------------------
// Disk-level checkpoint storage (Level 3 — power-cut redundancy)
//
// Layout under ``userData``:
//
//   manhwa-checkpoints/
//     <sessionId>/
//       meta.json
//       chapter-0001/
//         script.json        ← CombinedChapterEntry minus blobs
//         images/
//           0001.jpg
//           0002.jpg
//           …
//       chapter-0002/
//         …
//
// IndexedDB stays the primary store (fast, works in web build too).
// Disk is a redundant backup so a browser cache wipe / corruption /
// quota eviction doesn't kill the user's work. Renderer always writes
// to BOTH; reads prefer IDB and only fall back to disk when IDB is
// empty (e.g. on a fresh machine after copying the userData folder).
// ---------------------------------------------------------------------

function checkpointBaseDir() {
  return path.join(app.getPath("userData"), "manhwa-checkpoints");
}

function sessionDir(sessionId) {
  return path.join(checkpointBaseDir(), sanitizeId(sessionId));
}

function sanitizeId(id) {
  // IDs are timestamp-based but we still scrub any path-traversal chars.
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function chapterDir(sessionId, chapterIndex) {
  const padded = String(chapterIndex).padStart(4, "0");
  return path.join(sessionDir(sessionId), `chapter-${padded}`);
}

async function rmDir(dir) {
  // fs.rm with recursive available in Node 14.14+, always present in
  // bundled Electron Node. Force=true means missing dir is not an error.
  await fsp.rm(dir, { recursive: true, force: true });
}

ipcMain.handle("checkpoint:save-meta", async (_e, sessionId, meta) => {
  const dir = sessionDir(sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf-8",
  );
});

ipcMain.handle(
  "checkpoint:write-chapter",
  async (_e, sessionId, chapterIndex, entry, blobBuffers) => {
    const dir = chapterDir(sessionId, chapterIndex);
    const imagesDir = path.join(dir, "images");
    await fsp.mkdir(imagesDir, { recursive: true });
    // Write script.json (everything except blobs — those go on disk
    // as proper JPEG files so they're browsable in Explorer/Finder).
    await fsp.writeFile(
      path.join(dir, "script.json"),
      JSON.stringify(entry, null, 2),
      "utf-8",
    );
    // Write images as 0001.jpg, 0002.jpg, … so the user can spot-check
    // saved progress by just opening the folder.
    for (let i = 0; i < blobBuffers.length; i++) {
      const filename = `${String(i + 1).padStart(4, "0")}.jpg`;
      const buf = blobBuffers[i];
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      await fsp.writeFile(path.join(imagesDir, filename), bytes);
    }
  },
);

ipcMain.handle("checkpoint:read-session", async (_e, sessionId) => {
  const dir = sessionDir(sessionId);
  if (!fs.existsSync(dir)) return null;
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
  const subdirs = await fsp.readdir(dir, { withFileTypes: true });
  const chapters = [];
  for (const sub of subdirs) {
    if (!sub.isDirectory() || !sub.name.startsWith("chapter-")) continue;
    const chDir = path.join(dir, sub.name);
    const scriptPath = path.join(chDir, "script.json");
    if (!fs.existsSync(scriptPath)) continue;
    const entry = JSON.parse(await fsp.readFile(scriptPath, "utf-8"));
    // Reattach image bytes — sorted by filename so order is stable.
    const imagesDir = path.join(chDir, "images");
    const blobBuffers = [];
    if (fs.existsSync(imagesDir)) {
      const imgFiles = (await fsp.readdir(imagesDir))
        .filter((f) => /\.jpg$/i.test(f))
        .sort();
      for (const f of imgFiles) {
        const buf = await fsp.readFile(path.join(imagesDir, f));
        // ArrayBuffer transfers across IPC cleanly; renderer wraps in Blob.
        blobBuffers.push(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      }
    }
    chapters.push({ entry, blobBuffers });
  }
  return { meta, chapters };
});

ipcMain.handle("checkpoint:list-sessions", async () => {
  const base = checkpointBaseDir();
  if (!fs.existsSync(base)) return [];
  const subdirs = await fsp.readdir(base, { withFileTypes: true });
  const out = [];
  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue;
    const metaPath = path.join(base, sub.name, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
      // Count chapter-* subdirs for the checkpointCount summary.
      const inner = await fsp.readdir(path.join(base, sub.name), {
        withFileTypes: true,
      });
      const checkpointCount = inner.filter(
        (d) => d.isDirectory() && d.name.startsWith("chapter-"),
      ).length;
      out.push({ meta, checkpointCount });
    } catch {
      /* skip malformed session */
    }
  }
  return out;
});

ipcMain.handle("checkpoint:delete-session", async (_e, sessionId) => {
  await rmDir(sessionDir(sessionId));
});

ipcMain.handle("checkpoint:base-dir", () => checkpointBaseDir());

ipcMain.handle("checkpoint:open-folder", async (_e, sessionId) => {
  // Convenience for a future "Show in Explorer" button. Opens the
  // session folder (or the base folder if sessionId is null).
  const target = sessionId ? sessionDir(sessionId) : checkpointBaseDir();
  if (fs.existsSync(target)) {
    shell.openPath(target);
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0f172a",
    title: "Manhwa Recap Pipeline",
    show: false, // wait until ready-to-show to avoid white flash
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // External links (Gemini docs, GitHub) open in the user's browser
  // instead of inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // file://… path to the Vite production bundle inside the asar archive
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  return win;
}

// --- App lifecycle ----------------------------------------------------

// Single-instance lock — second launch focuses the existing window
// instead of opening a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const w = wins[0];
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(() => {
    // Default menu is fine — File/Edit/View/Window/Help on Mac, simple
    // bar on Windows. Suppress devtools entry in production via a
    // stripped-down menu later if we want.
    if (!isDev) {
      Menu.setApplicationMenu(buildAppMenu());
    }
    createWindow();

    app.on("activate", () => {
      // macOS — re-create window when dock icon clicked and no windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // Quit on all non-macOS platforms when last window closes.
  if (process.platform !== "darwin") app.quit();
});

function buildAppMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ]
          : [{ role: "close" }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "GitHub repo",
          click: () => shell.openExternal("https://github.com/megashoeb/manhwa-pipeline"),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
