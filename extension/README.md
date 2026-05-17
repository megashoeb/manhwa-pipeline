# Manhwa Chapter → PDF Downloader (Chrome Extension)

Yeh extension manhwa sites (asurascans, vortexscans, etc.) ke chapter pages se images scrape karta hai aur **chapter-wise PDFs** banake aapke `Downloads` folder me save kar deta hai. Koi external library use nahi hoti — sab kuch built-in JS me hai.

---

## Install (load unpacked)

1. Open Chrome → `chrome://extensions/`
2. Top-right me **Developer mode** ON karo.
3. **Load unpacked** click karo.
4. `D:\Manwha-Web\extension` folder select karo.
5. Toolbar me extension icon (puzzle-piece) pe click karke pin kar lo.

> Edge / Brave bhi same way kaam karega (Chromium-based).

---

## How to use

1. Apne browser me **pehla chapter** open karo jisse aap shuru karna chahte ho — jaise:
   - `https://asurascans.com/comics/<slug>-<hash>/chapter/1`
   - `https://vortexscans.org/series/<slug>/chapter-1`
2. URL bar se URL **copy** karo.
3. Extension icon pe click karo → popup khulega.
4. Popup me:
   - **Starting chapter URL** — wahi URL paste karo.
   - **Number of chapters** — kitne chapters chahiye (e.g. `10` → chapter 1 se 10 tak).
   - **Output folder** — `Downloads` ke andar folder name. Nested paths bhi chalega: `Comics/Solo-Leveling`.
   - **Ask me where to save** *(checkbox)* — ON karoge to har chapter pe Chrome Save As dialog khulega aur aap koi bhi location pick kar sakte ho (D: drive, external HDD, anywhere). Chrome last folder yaad rakhta hai — 2nd chapter se 1-click ho jata hai.
   - **Filename padding** — 100+ chapters ke liye `chapter 001.pdf` recommend (file manager me natural sort). Default = no padding (`chapter 1.pdf`).
   - **JPEG quality** — default Medium (0.85). High = bigger files, Low = smaller.
5. **Start** dabao.

**Filename**: hamesha URL ke chapter number ke saath match karta hai. Agar aap `…/chapter/5` se start karte ho aur 3 chapters lete ho, files banengi:

```
chapter 5.pdf
chapter 6.pdf
chapter 7.pdf
```

Default save path: `Downloads/<folder>/chapter <N>.pdf`. Save As mode me: jaha aap navigate karoge wahaan.

Re-run karne pe same chapter numbers **overwrite** ho jaate hain — Chrome `chapter 1 (1).pdf` jaisa suffix nahi lagayega.

---

## Kaise kaam karta hai (technical)

For each chapter:

1. **URL increment** — `…/chapter-1` ya `…/chapter/1` ka number badhake N+1, N+2, … bana leta hai.
2. **HTML scrape** — page ka HTML fetch karke saari `<img>` URLs nikalta hai (including lazy-loaded `data-src`, `srcset`, aur inline JSON image lists).
3. **Sequence detect** — `/001.webp`, `/002.webp` jaise numeric filenames ka largest group find karta hai.
4. **404 walk** — last detected page ke aage probe karta hai (Range GET) jab tak 2 consecutive misses na aaye — taaki lazy-loaded later pages bhi mil jaaye.
5. **WebP → JPEG** — `OffscreenCanvas` + `createImageBitmap` se decode karke JPEG re-encode (already-JPEG images skip ho jaate hain).
6. **PDF build** — minimal PDF writer (no jsPDF / pdf-lib dependency) JPEG ko `DCTDecode` XObject ke roop me embed karta hai — koi quality loss nahi.
7. **Save** — `chrome.downloads.download()` se file system pe save.

Stop button kabhi bhi dabao — currently running chapter ke beech me cleanly abort ho jayega.

---

## Supported URL patterns

URL ke andar in patterns me se koi bhi work karega (case-insensitive):

- `…/chapter-1`, `…/chapter-001`
- `…/chapter/1`, `…/chapter/55`
- `…/ch-1`, `…/ch/1`

Agar aapki site ka pattern alag hai (e.g. `…/c1/`, `…/episode-5`), `background.js` ke `parseChapterUrl()` me ek regex add kar lena.

---

## Troubleshooting

- **"Could not detect chapter number"** → URL me `chapter-N` ya `chapter/N` pattern hona chahiye. Browser address bar se exact URL copy karo.
- **"No images found"** → Site cloudflare-protected ya CAPTCHA-locked ho sakti hai. Browser me chapter open hona chahiye pehle (extension same Chrome session use karta hai), ya site shayad images JS me runtime-render karti hai (DOM parse nahi hota — sirf HTML). Workaround: chapter ko refresh karke wait karo until images load, fir try karo.
- **CDN blocking** → kuch CDNs cross-origin fetch block karte hain. Extension `<all_urls>` host permission ke saath aata hai, isliye most cases me kaam karega. Agar nahi → console logs check karo (`chrome://extensions/` → extension → "service worker" link).
- **PDF blank ya broken** → JPEG quality `High` pe try karo. Agar source images PNG with transparency hain to JPEG conversion white background lagayega — ye normal hai.

---

## Files

```
extension/
  manifest.json     ← MV3 manifest
  popup.html        ← UI markup
  popup.css         ← UI styling
  popup.js          ← form handling + progress rendering
  background.js     ← scraping + PDF builder (service worker)
  README.md         ← this file
```
