// offscreen.js — runs inside an offscreen DOM document so we have
// reliable access to URL.createObjectURL() for large Blobs. The service
// worker sends bytes here, we hand back a blob: URL that chrome.downloads
// can consume without the 25+ MB data: URL flakiness that causes
// orphaned .tmp files.
//
// Lifecycle:
//   1. Background creates this offscreen doc on demand (DOM_PARSER reason).
//   2. For every PDF: background → MAKE_BLOB_URL → we return a URL.
//   3. After the chrome.downloads.download call resolves, background
//      sends REVOKE_BLOB_URL so the bytes don't pile up in memory.

const blobUrls = new Set();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  if (msg.type === "MAKE_BLOB_URL") {
    try {
      // bytes arrive as base64 (only JSON-safe transport for sendMessage).
      const binary = atob(msg.bytesBase64);
      const u8 = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
      const blob = new Blob([u8], { type: msg.mime || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      blobUrls.add(url);
      sendResponse({ ok: true, url });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false;
  }

  if (msg.type === "REVOKE_BLOB_URL") {
    try {
      URL.revokeObjectURL(msg.url);
      blobUrls.delete(msg.url);
    } catch {}
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
