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

const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

const isDev = process.env.NODE_ENV === "development";

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
