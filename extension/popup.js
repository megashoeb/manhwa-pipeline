// Popup UI — collects input, fires off the background download job,
// and renders progress events streamed back from the service worker.

const form = document.getElementById("downloadForm");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const startUrlInput = document.getElementById("startUrl");
const chapterCountInput = document.getElementById("chapterCount");
const folderNameInput = document.getElementById("folderName");
const saveAsInput = document.getElementById("saveAs");
const padDigitsInput = document.getElementById("padDigits");
const qualityInput = document.getElementById("quality");

const progressSection = document.getElementById("progressSection");
const statusLabel = document.getElementById("statusLabel");
const statusCount = document.getElementById("statusCount");
const progressFill = document.getElementById("progressFill");
const logBox = document.getElementById("logBox");

// Restore last form values from chrome.storage so the user doesn't
// have to retype everything when popup re-opens.
chrome.storage.local.get(["lastForm"]).then(({ lastForm }) => {
  if (!lastForm) return;
  if (lastForm.startUrl) startUrlInput.value = lastForm.startUrl;
  if (lastForm.chapterCount) chapterCountInput.value = lastForm.chapterCount;
  if (lastForm.folderName) folderNameInput.value = lastForm.folderName;
  if (lastForm.quality) qualityInput.value = lastForm.quality;
  if (typeof lastForm.saveAs === "boolean") saveAsInput.checked = lastForm.saveAs;
  if (lastForm.padDigits != null) padDigitsInput.value = String(lastForm.padDigits);
});

// On open, re-attach to any running job.
chrome.runtime.sendMessage({ type: "GET_STATUS" }).then((status) => {
  if (status?.running) {
    showRunningState(status);
  }
}).catch(() => {});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    startUrl: startUrlInput.value.trim(),
    chapterCount: parseInt(chapterCountInput.value, 10),
    folderName: sanitizeFolder(folderNameInput.value.trim() || "manhwa"),
    saveAs: saveAsInput.checked,
    padDigits: parseInt(padDigitsInput.value, 10) || 0,
    quality: parseFloat(qualityInput.value),
  };

  if (!payload.startUrl) {
    appendLog("ERROR: enter a starting chapter URL.");
    return;
  }
  if (!Number.isFinite(payload.chapterCount) || payload.chapterCount < 1) {
    appendLog("ERROR: chapter count must be >= 1.");
    return;
  }

  await chrome.storage.local.set({ lastForm: payload });

  clearLog();
  showRunningState({ running: true, current: 0, total: payload.chapterCount });
  appendLog(`Starting: ${payload.chapterCount} chapter(s) from ${payload.startUrl}`);

  const result = await chrome.runtime.sendMessage({
    type: "START_DOWNLOAD",
    payload,
  });

  if (result?.error) {
    appendLog(`ERROR: ${result.error}`);
    showIdleState();
  }
});

stopBtn.addEventListener("click", async () => {
  appendLog("Stopping…");
  await chrome.runtime.sendMessage({ type: "STOP_DOWNLOAD" });
});

// Live progress / log events streamed from background.js
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PROGRESS") {
    updateProgress(msg.payload);
  } else if (msg?.type === "LOG") {
    appendLog(msg.text);
  } else if (msg?.type === "DONE") {
    appendLog(msg.text || "All done.");
    showIdleState();
  } else if (msg?.type === "ABORTED") {
    appendLog("Aborted by user.");
    showIdleState();
  }
});

function updateProgress(p) {
  progressSection.hidden = false;
  if (p.label) statusLabel.textContent = p.label;
  if (p.current != null && p.total != null) {
    statusCount.textContent = `${p.current}/${p.total}`;
    const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
  } else if (p.pct != null) {
    progressFill.style.width = `${Math.round(p.pct)}%`;
  }
}

function showRunningState(status) {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  progressSection.hidden = false;
  if (status.current != null && status.total != null) {
    statusCount.textContent = `${status.current}/${status.total}`;
  }
  statusLabel.textContent = status.label || "Running";
}

function showIdleState() {
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

function appendLog(text) {
  const ts = new Date().toLocaleTimeString();
  logBox.textContent += `[${ts}] ${text}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function clearLog() {
  logBox.textContent = "";
}

function sanitizeFolder(name) {
  // Allow letters, digits, dash, underscore, space, forward-slash
  // (so nested sub-paths like "Comics/Solo-Leveling" work). Strip any
  // leading "/" and collapse repeated separators so chrome.downloads
  // doesn't reject the path.
  return (
    name
      .replace(/\\/g, "/")
      .replace(/[^a-zA-Z0-9_\- /]+/g, "_")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .slice(0, 120) || "manhwa"
  );
}
