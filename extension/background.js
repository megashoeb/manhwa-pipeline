// background.js — service worker for the Manhwa → PDF extension.
//
// Flow per chapter:
//   1. Compute chapter URL (increment the number in the starting URL)
//   2. Fetch the chapter HTML
//   3. Extract image URLs (look for the longest numeric-filename group:
//      /001.webp, /002.webp, …). Pick the first as the seed pattern.
//   4. Iterate sequential pages from the seed until we get 404 / non-image
//      content. (We also pick up any non-sequential image URLs already in
//      the HTML so lazy-loaded pages aren't missed.)
//   5. For each image: fetch → decode → re-encode JPEG via OffscreenCanvas.
//   6. Build a single PDF (one page per image, JPEG embedded with
//      DCTDecode filter — no external library needed).
//   7. Save via chrome.downloads.download() as "<folder>/chapter <N>.pdf".
//
// Stop flag is checked at every fetch + every image step so the user can
// abort cleanly.

let state = {
  running: false,
  aborted: false,
  current: 0,
  total: 0,
  label: "Idle",
};

// -----------------------------------------------------------------------
// Filename override — Chrome ignores the `filename` param from
// chrome.downloads.download() when the source is a blob: URL (it uses
// the blob UUID instead). The fix is to register an
// onDeterminingFilename listener at the TOP LEVEL of the service worker
// (so it's active even after the SW restarts) and override the name there.
//
// pendingFilenames maps the blob URL → intended filename. We populate it
// just before calling download() and clear it when the listener fires.
// -----------------------------------------------------------------------

const pendingFilenames = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const intended = pendingFilenames.get(item.url);
  if (!intended) return; // not one of ours — let Chrome handle normally
  pendingFilenames.delete(item.url);
  suggest({
    filename: intended.filename,
    conflictAction: intended.conflictAction || "overwrite",
  });
});

// Clean up the map entry if a download fails / is cancelled before the
// onDeterminingFilename listener fires. Prevents long-running memory leaks.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const newState = delta.state.current;
  if (newState === "interrupted" || newState === "complete") {
    // We don't have the URL in onChanged — best-effort: query the item.
    chrome.downloads.search({ id: delta.id }, (items) => {
      if (chrome.runtime.lastError || !items?.length) return;
      pendingFilenames.delete(items[0].url);
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "START_DOWNLOAD") {
    if (state.running) {
      sendResponse({ error: "Already running. Stop the current job first." });
      return false;
    }
    startJob(msg.payload).catch((err) => {
      broadcast({ type: "LOG", text: `Fatal: ${err?.message || err}` });
      broadcast({ type: "DONE", text: "Failed." });
      state.running = false;
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "STOP_DOWNLOAD") {
    state.aborted = true;
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "GET_STATUS") {
    sendResponse({ ...state });
    return false;
  }
  return false;
});

async function startJob(payload) {
  const {
    startUrl,
    chapterCount,
    folderName,
    quality,
    saveAs = false,
    padDigits = 0,
  } = payload;

  state.running = true;
  state.aborted = false;
  state.current = 0;
  state.total = chapterCount;
  state.label = "Starting";

  broadcast({ type: "PROGRESS", payload: { current: 0, total: chapterCount, label: "Starting" } });

  const startInfo = parseChapterUrl(startUrl);
  if (!startInfo) {
    broadcast({ type: "LOG", text: `Could not detect chapter number in URL. Make sure it looks like ".../chapter-1" or ".../chapter/1".` });
    broadcast({ type: "DONE", text: "Aborted — bad URL." });
    state.running = false;
    return;
  }

  for (let i = 0; i < chapterCount; i++) {
    if (state.aborted) {
      broadcast({ type: "ABORTED" });
      state.running = false;
      return;
    }
    const chapterNum = startInfo.chapterNum + i;
    const chapterIndex = i + 1;
    const chapterUrl = buildChapterUrl(startInfo, chapterNum);

    state.current = chapterIndex;
    state.label = `Chapter ${chapterNum}`;
    broadcast({
      type: "PROGRESS",
      payload: { current: chapterIndex, total: chapterCount, label: `Chapter ${chapterNum} — fetching` },
    });
    broadcast({ type: "LOG", text: `→ Chapter ${chapterNum}: ${chapterUrl}` });

    try {
      const imageUrls = await discoverChapterImages(chapterUrl);
      if (state.aborted) break;
      if (imageUrls.length === 0) {
        broadcast({ type: "LOG", text: `   No images found for chapter ${chapterNum} — skipping.` });
        continue;
      }
      broadcast({ type: "LOG", text: `   Found ${imageUrls.length} image(s).` });

      const jpegs = [];
      for (let p = 0; p < imageUrls.length; p++) {
        if (state.aborted) break;
        const url = imageUrls[p];
        broadcast({
          type: "PROGRESS",
          payload: {
            current: chapterIndex,
            total: chapterCount,
            label: `Chapter ${chapterNum} — page ${p + 1}/${imageUrls.length}`,
          },
        });
        try {
          // Pass the chapter URL as Referer — many CDNs (especially
          // ones behind Cloudflare) reject hotlinked image requests
          // whose referer doesn't match the host site.
          const jpeg = await fetchAndEncodeJpeg(url, quality, chapterUrl);
          if (jpeg) jpegs.push(jpeg);
        } catch (err) {
          broadcast({ type: "LOG", text: `   ! Failed page ${p + 1}: ${err?.message || err}` });
        }
      }

      if (state.aborted) break;
      if (jpegs.length === 0) {
        broadcast({ type: "LOG", text: `   No usable images for chapter ${chapterNum} — skipping.` });
        continue;
      }

      broadcast({
        type: "PROGRESS",
        payload: {
          current: chapterIndex,
          total: chapterCount,
          label: `Chapter ${chapterNum} — building PDF`,
        },
      });
      const pdfBytes = buildPdf(jpegs);
      const blobUrl = await createBlobUrl(pdfBytes, "application/pdf");
      const numStr = padDigits > 0
        ? String(chapterNum).padStart(padDigits, "0")
        : String(chapterNum);
      // When saveAs is on, the user picks the destination — prefixing
      // with the folder name would just clutter the suggested filename
      // in the Save As dialog. So skip it.
      const filename = saveAs
        ? `chapter ${numStr}.pdf`
        : `${folderName}/chapter ${numStr}.pdf`;
      try {
        await downloadFile(blobUrl, filename, saveAs);
      } finally {
        // Give Chrome a moment to start reading the blob, then free it.
        setTimeout(() => revokeBlobUrl(blobUrl), 5000);
      }
      broadcast({ type: "LOG", text: `   ✓ Saved chapter ${numStr}.pdf (${jpegs.length} pages, ${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB)` });
    } catch (err) {
      broadcast({ type: "LOG", text: `   ! Chapter ${chapterNum} failed: ${err?.message || err}` });
    }
  }

  if (state.aborted) {
    broadcast({ type: "ABORTED" });
  } else {
    broadcast({ type: "DONE", text: `Finished ${chapterCount} chapter(s).` });
  }
  state.running = false;
  state.aborted = false;
}

// -----------------------------------------------------------------------
// URL parsing / chapter number stepping
// -----------------------------------------------------------------------

/**
 * Detects the chapter number segment of a URL.
 * Supports `.../chapter-1`, `.../chapter/1`, `.../ch-1`, `.../ch/1`.
 * Returns { chapterNum, prefix, suffix, sep } so we can rebuild for N+1.
 */
function parseChapterUrl(url) {
  // Try several patterns from most specific to least.
  const patterns = [
    /^(.*?\/chapter[-_])(\d+)(.*)$/i,
    /^(.*?\/chapter\/)(\d+)(.*)$/i,
    /^(.*?\/ch[-_])(\d+)(.*)$/i,
    /^(.*?\/ch\/)(\d+)(.*)$/i,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) {
      return {
        prefix: m[1],
        chapterNum: parseInt(m[2], 10),
        suffix: m[3] || "",
      };
    }
  }
  return null;
}

function buildChapterUrl(info, n) {
  return `${info.prefix}${n}${info.suffix}`;
}

// -----------------------------------------------------------------------
// Image discovery
// -----------------------------------------------------------------------

/**
 * Fetch the chapter page and figure out which image URLs belong to the
 * chapter pages. Strategy:
 *
 *   1. Pull every `<img>` (and data-src, srcset) URL from the HTML.
 *   2. Keep only ones whose filename is a numeric sequence:
 *        /<digits>.webp, /<digits>.jpg, /<digits>.png  (case-insensitive)
 *   3. Group by base directory + extension + padding. The largest group
 *      is the chapter's image set.
 *   4. Use the smallest numeric filename in that group as the seed and
 *      walk forward fetching `<seed>+1`, `<seed>+2`… until we see a 404
 *      / non-image response. (Some sites lazy-load later pages, so we
 *      have to crawl.) We also keep any in-HTML URLs that were already
 *      past the discovered range.
 */
async function discoverChapterImages(chapterUrl) {
  const html = await fetchText(chapterUrl);

  // FIRST: try the Madara WP-theme path. ``class="wp-manga-chapter-img"``
  // is the canonical marker used by the Madara theme that powers a HUGE
  // chunk of manga/manhua aggregators — manhuaus.com, manhwafreak.com,
  // manytoon.com, isekaiscan.com, asurascans variants, etc. The theme
  // pre-marks the chapter image tags so we don't have to guess. The
  // real image URL lives in ``data-src`` (with a placeholder in ``src``
  // until the lazy-loader swaps it on scroll), so we prefer that.
  //
  // If we find Madara images, trust them — they're already in correct
  // page order and we skip the numeric-walk probe entirely (saves time
  // and avoids 404s on sites where the URL pattern isn't sequential).
  const madaraUrls = extractMadaraImages(html, chapterUrl);
  if (madaraUrls.length > 0) {
    broadcast({
      type: "LOG",
      text: `   (Madara theme detected — using ${madaraUrls.length} pre-marked image(s))`,
    });
    return madaraUrls;
  }

  const rawUrls = extractImageUrls(html, chapterUrl);
  const numericGroups = groupNumericImages(rawUrls);

  if (numericGroups.length === 0) {
    // Fallback: just return whatever <img> we found that looks like a
    // reasonable content image (skip icons / logos).
    return rawUrls.filter((u) => /\.(webp|jpg|jpeg|png)(\?|$)/i.test(u));
  }

  // Largest group wins.
  numericGroups.sort((a, b) => b.urls.length - a.urls.length);
  const group = numericGroups[0];

  // Sort numerically by detected page number.
  group.urls.sort((a, b) => a.num - b.num);
  const inHtmlMax = group.urls[group.urls.length - 1].num;

  // Walk forward from inHtmlMax+1 until 404 — handles lazy-loaded pages.
  const seen = new Set(group.urls.map((u) => u.url));
  const ordered = group.urls.map((u) => u.url);

  let probe = inHtmlMax + 1;
  let misses = 0;
  while (misses < 2 && probe < inHtmlMax + 200) {
    if (state.aborted) break;
    const candidate = buildSequentialUrl(group, probe);
    if (seen.has(candidate)) {
      probe++;
      continue;
    }
    const ok = await headOk(candidate, chapterUrl);
    if (ok) {
      ordered.push(candidate);
      seen.add(candidate);
      misses = 0;
    } else {
      misses++;
    }
    probe++;
  }

  return ordered;
}

function extractImageUrls(html, baseUrl) {
  const urls = new Set();

  // <img src=..., data-src=..., data-original=...>
  const attrRe = /<img\b[^>]*?\s(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const u = absolutize(m[1], baseUrl);
    if (u) urls.add(u);
  }

  // srcset values (take the first URL of each entry).
  const srcsetRe = /<img\b[^>]*?\ssrcset\s*=\s*["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(html)) !== null) {
    const entries = m[1].split(",");
    for (const e of entries) {
      const u = e.trim().split(/\s+/)[0];
      const abs = absolutize(u, baseUrl);
      if (abs) urls.add(abs);
    }
  }

  // Sometimes image lists are baked into inline JSON / scripts as
  // "url":"https://..." or just raw quoted strings. Scoop those too.
  const jsonRe = /["'](https?:[^"']+?\.(?:webp|jpg|jpeg|png))(?:\?[^"']*)?["']/gi;
  while ((m = jsonRe.exec(html)) !== null) {
    urls.add(m[1]);
  }

  return [...urls];
}

function absolutize(u, base) {
  if (!u) return null;
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}

/**
 * Madara WP-theme image extraction.
 *
 * Matches any ``<img>`` whose class list contains
 * ``wp-manga-chapter-img`` — the Madara theme's canonical marker for
 * chapter pages. Returns URLs in document order, preferring
 * ``data-src`` (the real lazy-loaded URL) over ``src`` (usually a
 * placeholder spinner). Falls back to ``data-lazy-src``,
 * ``data-original`` if those are the only attrs present.
 *
 * Sites this catches (sample): manhuaus.com, manhwafreak.com,
 * manytoon.com, isekaiscan.com, mangabuddy.com, several asurascans
 * mirrors, and dozens of smaller Madara-based aggregators.
 *
 * Returns ``[]`` if the page isn't Madara — caller falls back to the
 * numeric-filename heuristic.
 */
function extractMadaraImages(html, baseUrl) {
  const urls = [];
  const seen = new Set();
  // Capture full ``<img ...>`` tags carrying the marker class. The
  // class attribute may have additional classes around the marker
  // (e.g. ``class="wp-manga-chapter-img lazyloaded"``) so we don't
  // anchor on exact equality.
  const imgRe =
    /<img\b[^>]*?\bclass\s*=\s*["'][^"']*?\bwp-manga-chapter-img\b[^"']*?["'][^>]*>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    // Lazy-loaded sites stash the real URL in one of these attrs;
    // ``src`` is usually a 1×1 placeholder until JS swaps it in.
    const candidates = [
      /\bdata-src\s*=\s*["']([^"']+)["']/i,
      /\bdata-lazy-src\s*=\s*["']([^"']+)["']/i,
      /\bdata-original\s*=\s*["']([^"']+)["']/i,
      /\bsrc\s*=\s*["']([^"']+)["']/i,
    ];
    let raw = null;
    for (const re of candidates) {
      const cm = tag.match(re);
      if (cm && cm[1]) {
        const val = cm[1].trim();
        // Skip obvious placeholder data: URIs.
        if (val.startsWith("data:")) continue;
        raw = val;
        break;
      }
    }
    if (!raw) continue;
    const abs = absolutize(raw, baseUrl);
    if (!abs) continue;
    // Only accept image content-types (Madara sometimes embeds icon
    // ``<img>`` tags inside the chapter container that ALSO carry the
    // marker class — filter on extension as a sanity check).
    if (!/\.(webp|jpg|jpeg|png|gif)(\?|$)/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    urls.push(abs);
  }
  return urls;
}

function groupNumericImages(urls) {
  const groups = new Map();
  for (const url of urls) {
    const m = url.match(/^(.*\/)(\d{1,4})\.(webp|jpg|jpeg|png)(\?.*)?$/i);
    if (!m) continue;
    const base = m[1];
    const numStr = m[2];
    const ext = m[3].toLowerCase();
    const padding = numStr.length;
    const key = `${base}|${ext}|${padding}`;
    const num = parseInt(numStr, 10);
    if (!groups.has(key)) {
      groups.set(key, { base, ext, padding, urls: [] });
    }
    groups.get(key).urls.push({ url, num });
  }
  return [...groups.values()];
}

function buildSequentialUrl(group, n) {
  const padded = String(n).padStart(group.padding, "0");
  return `${group.base}${padded}.${group.ext}`;
}

async function headOk(url, referer) {
  // HEAD often blocked by CDNs — do a tiny ranged GET instead. Uses
  // siteFetchInit() so referer + cookies match the rest of the
  // pipeline (otherwise Cloudflare-protected probes 403 even when the
  // actual image download would succeed).
  try {
    const init = siteFetchInit(referer || url, { Range: "bytes=0-2" });
    init.method = "GET";
    const r = await fetch(url, init);
    if (!r.ok && r.status !== 206) return false;
    const ct = r.headers.get("content-type") || "";
    if (ct && !/image\//i.test(ct) && !/octet-stream/i.test(ct)) {
      // Most CDNs return image/*. Some return application/octet-stream.
      // Anything else (e.g. text/html for the 404 page) is a miss.
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// Image fetching + JPEG re-encode (handles WebP/PNG → JPEG)
// -----------------------------------------------------------------------

async function fetchAndEncodeJpeg(url, quality, referer) {
  const blob = await fetchBlob(url, referer);
  if (!blob) return null;

  // If it's already a JPEG and quality is high, we can skip the
  // re-encode and just embed it directly. Keeps the PDF smaller +
  // avoids a generation loss.
  const ct = (blob.type || "").toLowerCase();
  if (ct === "image/jpeg" || ct === "image/jpg") {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dims = readJpegDimensions(buf);
    if (dims) {
      return { bytes: buf, width: dims.width, height: dims.height };
    }
  }

  // Otherwise decode + re-encode as JPEG.
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await jpegBlob.arrayBuffer());
  return { bytes, width: canvas.width, height: canvas.height };
}

/**
 * Build the fetch options most manga sites need to NOT 403:
 *
 *   - ``credentials: "include"`` so the user's own session cookies are
 *     attached. Manhuaus, manhwafreak, etc. sit behind Cloudflare Bot
 *     Fight Mode — they reject any request that doesn't carry the
 *     ``cf_clearance`` cookie the user got when their browser solved
 *     the challenge. With ``omit`` we were sending zero cookies and
 *     getting an instant 403.
 *
 *   - ``Referer`` set to the site origin so referer-strict CDNs (some
 *     image hosts only serve when the referer matches the site
 *     domain) don't reject the request.
 *
 * Returns ``RequestInit`` ready to pass to fetch().
 */
function siteFetchInit(url, extraHeaders = {}) {
  let referer = "";
  try {
    referer = new URL(url).origin + "/";
  } catch {
    /* invalid URL — referer stays empty */
  }
  return {
    credentials: "include",
    headers: {
      ...(referer ? { Referer: referer } : {}),
      ...extraHeaders,
    },
  };
}

async function fetchText(url) {
  const r = await fetch(url, siteFetchInit(url));
  if (!r.ok) {
    // 403 / 503 from Cloudflare-fronted sites usually means the user
    // hasn't completed the bot-check yet. Surface a friendlier hint
    // alongside the raw status so they know what to do.
    if (r.status === 403 || r.status === 503) {
      throw new Error(
        `HTTP ${r.status} on ${url} — Cloudflare blocking? Open the chapter URL in THIS Chrome window first, solve any "Verify you are human" challenge, then re-run.`,
      );
    }
    throw new Error(`HTTP ${r.status} on ${url}`);
  }
  return r.text();
}

async function fetchBlob(url, referer) {
  // For image fetches we'd ideally use the chapter-page URL as
  // referer (most image CDNs check that the request "came from" the
  // chapter page). Caller passes it in when known; we fall back to
  // the image's own origin otherwise.
  const init = siteFetchInit(referer || url);
  const r = await fetch(url, init);
  if (!r.ok) return null;
  return r.blob();
}

/**
 * Parse JPEG SOF marker to read width/height without a canvas decode.
 * Returns null if it's not a recognisable JPEG.
 */
function readJpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    while (bytes[i] === 0xff && i < bytes.length) i++;
    const marker = bytes[i];
    i++;
    // SOF markers (skip DHT/DQT/etc.). 0xC0..0xCF except 0xC4, 0xC8, 0xCC.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      return { width, height };
    }
    const segLen = (bytes[i] << 8) | bytes[i + 1];
    i += segLen;
  }
  return null;
}

// -----------------------------------------------------------------------
// Minimal PDF builder — embeds JPEGs as DCTDecode XObjects.
// One page per image. Page size = image size (in points, 1pt = 1px here
// which gives roughly 1:1 rendering at 72 DPI; viewers handle scaling).
// -----------------------------------------------------------------------

function buildPdf(images) {
  // Object indices:
  //   1: Catalog
  //   2: Pages
  //   3..: Page objs + image XObject + content stream for each image
  //
  // For N images:
  //   pageObj[i]   = 3 + i*3
  //   contentObj[i]= 4 + i*3
  //   imageObj[i]  = 5 + i*3

  const N = images.length;
  const objects = []; // index 0 unused; objects[i] = bytes for obj i
  objects.push(null);

  // Catalog (1)
  objects.push(textBytes(`<< /Type /Catalog /Pages 2 0 R >>`));

  // Pages (2) — kids list populated later
  const pageRefs = [];
  for (let i = 0; i < N; i++) {
    pageRefs.push(`${3 + i * 3} 0 R`);
  }
  objects.push(
    textBytes(`<< /Type /Pages /Count ${N} /Kids [${pageRefs.join(" ")}] >>`),
  );

  for (let i = 0; i < N; i++) {
    const img = images[i];
    const w = img.width;
    const h = img.height;
    const pageObjNum = 3 + i * 3;
    const contentObjNum = 4 + i * 3;
    const imageObjNum = 5 + i * 3;

    // Page object
    objects.push(
      textBytes(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
          `/Resources << /XObject << /Im0 ${imageObjNum} 0 R >> >> ` +
          `/Contents ${contentObjNum} 0 R >>`,
      ),
    );

    // Content stream: place image at (0,0) sized w×h
    const stream = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    const streamBytes = textBytes(stream);
    objects.push(
      concatBytes(
        textBytes(`<< /Length ${streamBytes.length} >>\nstream\n`),
        streamBytes,
        textBytes(`\nendstream`),
      ),
    );

    // Image XObject — JPEG embedded directly via /DCTDecode
    const imgHeader = textBytes(
      `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${img.bytes.length} >>\nstream\n`,
    );
    const imgFooter = textBytes(`\nendstream`);
    objects.push(concatBytes(imgHeader, img.bytes, imgFooter));
  }

  // Assemble the PDF file with xref table.
  const header = textBytes("%PDF-1.4\n%\xff\xff\xff\xff\n");
  const chunks = [header];
  const offsets = []; // byte offset of object N within the final file
  let cursor = header.length;

  for (let i = 1; i < objects.length; i++) {
    const objHeader = textBytes(`${i} 0 obj\n`);
    const objFooter = textBytes(`\nendobj\n`);
    const objBody = objects[i];
    offsets[i] = cursor;
    chunks.push(objHeader, objBody, objFooter);
    cursor += objHeader.length + objBody.length + objFooter.length;
  }

  // xref
  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const xrefBytes = textBytes(xref);
  chunks.push(xrefBytes);

  const trailer = textBytes(
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );
  chunks.push(trailer);

  return concatBytes(...chunks);
}

// -----------------------------------------------------------------------
// byte helpers
// -----------------------------------------------------------------------

function textBytes(str) {
  // Latin-1 / raw-byte encoding — PDF dictionary/text outside streams
  // is ASCII anyway. For image bytes we already have a Uint8Array.
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// -----------------------------------------------------------------------
// Offscreen document for blob URLs (reliable large-file downloads)
// -----------------------------------------------------------------------
// Background service workers can't reliably create blob: URLs that
// chrome.downloads will accept across all Chrome versions. The official
// workaround is to spin up an offscreen DOM document. We send raw bytes
// over, it returns a blob: URL, and chrome.downloads consumes it just
// like any other URL — no .tmp orphans, no 25 MB data: URL flakiness.

const OFFSCREEN_PATH = "offscreen.html";
let offscreenCreating = null;

async function ensureOffscreen() {
  // Already there?
  if (await chrome.offscreen.hasDocument?.()) return;
  // Creation in flight? Wait on it.
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: "Create blob URLs from PDF bytes for chrome.downloads.",
  });
  try {
    await offscreenCreating;
  } catch (err) {
    // Some Chrome versions don't accept the "BLOBS" reason — fall back.
    if (String(err?.message || err).toLowerCase().includes("reason")) {
      offscreenCreating = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["DOM_PARSER"],
        justification: "Create blob URLs from PDF bytes for chrome.downloads.",
      });
      await offscreenCreating;
    } else if (!String(err?.message || err).toLowerCase().includes("only a single offscreen")) {
      throw err;
    }
  } finally {
    offscreenCreating = null;
  }
}

async function createBlobUrl(bytes, mime) {
  await ensureOffscreen();
  // chrome.runtime.sendMessage uses JSON serialisation, so we can't pass
  // Uint8Array directly (it'd become a giant `{0:..,1:..,2:..}` object).
  // base64 is the compact, predictable wire format.
  const b64 = bytesToBase64(bytes);
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "MAKE_BLOB_URL",
    bytesBase64: b64,
    mime,
  });
  if (!response?.ok) {
    throw new Error(`Offscreen blob creation failed: ${response?.error || "unknown"}`);
  }
  return response.url;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function revokeBlobUrl(url) {
  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "REVOKE_BLOB_URL",
      url,
    });
  } catch {}
}

// -----------------------------------------------------------------------
// chrome.downloads wrapper
// -----------------------------------------------------------------------

async function downloadFile(url, filename, saveAs = false) {
  // conflictAction: "overwrite" so re-running the same range doesn't
  // produce "chapter 1 (1).pdf" / "chapter 1 (2).pdf". User gets clean
  // sequential names exactly matching the chapter numbers.
  //
  // For blob: URLs, Chrome ignores the `filename` argument here — the
  // onDeterminingFilename listener (registered at top of file) actually
  // forces the name. We still pass `filename` for the saveAs dialog's
  // suggested-name field.
  pendingFilenames.set(url, {
    filename,
    conflictAction: "overwrite",
  });
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs,
        conflictAction: "overwrite",
      },
      (id) => {
        if (chrome.runtime.lastError) {
          pendingFilenames.delete(url);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      },
    );
  });
}

// -----------------------------------------------------------------------
// Messaging helper — best-effort broadcast to popup. Swallow errors when
// the popup isn't open.
// -----------------------------------------------------------------------

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
