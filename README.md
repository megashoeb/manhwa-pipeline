# Manhwa Recap Pipeline

Browser + desktop app jo manhwa chapter PDFs ko **YouTube-ready recap** me convert karta hai — clean panel images + Gemini-generated narration script + SRT (CapCut auto-sync ke liye 1:1 mapping). Includes a Chrome extension for chapter image scraping → PDF.

---

## Quick Start

3 tareeke se use kar sakte ho:

| Option | Speed | Setup | Best for |
|---|---|---|---|
| 🌐 **Web app (Vercel)** | Slower (network roundtrip per PDF) | None — just open URL | Quick tests, sharing |
| 🖥️ **Windows desktop app** | ⚡ Fast (local processing) | Download + extract zip | Daily use |
| 🍎 **Mac desktop app** | ⚡ Fast | Build from source on Mac | Daily use |

### Option 1 — Web app (sabse simple)

Bas browser kholo: **https://manhwa-pipeline.vercel.app**

Chrome / Edge / Firefox sab me chalega. Gemini API key UI me daalo (one-time).

---

## Windows pe install (Desktop app)

### Method A — Pre-built download (Recommended)

> *Agar GitHub Releases page pe `Manhwa-Recap-Windows.zip` available ho:*

1. **Download**: https://github.com/megashoeb/manhwa-pipeline/releases (latest release)
2. **`Manhwa-Recap-Windows.zip` download karo**
3. Right-click → **Extract All...** → kahin bhi extract karo (e.g. `C:\Tools\Manhwa Recap\`)
4. Extracted folder kholo → **`Manhwa Recap.exe`** double-click karo

✅ Done — app khul jayegi. No installation required, portable hai.

### Method B — Build from source

Agar pre-built download available nahi, ya aap khud build karna chahte ho:

**Prerequisites:**
- [Node.js 18+](https://nodejs.org/) (LTS recommended)
- [Git](https://git-scm.com/download/win)

**Steps:**

```powershell
# 1. Clone repo
git clone https://github.com/megashoeb/manhwa-pipeline.git
cd manhwa-pipeline

# 2. Install dependencies (~2 min, downloads ~400 MB)
npm install

# 3. Build Windows app (~30 sec)
npm run electron:build:win
```

Output: `release\Manhwa Recap-win32-x64\Manhwa Recap.exe` ← double-click to run.

Folder ko kahin bhi copy karo — portable hai, registry me kuch install nahi karta.

### Desktop shortcut banane ke liye

1. `Manhwa Recap.exe` pe right-click karo
2. **Send to** → **Desktop (create shortcut)**
3. Ya **Pin to Start** for quick access

---

## Mac pe install (Desktop app)

### Method A — Pre-built download

> *Agar GitHub Releases page pe `Manhwa-Recap-Mac.dmg` available ho:*

1. **Download**: https://github.com/megashoeb/manhwa-pipeline/releases
2. Aapke Mac ka chip dekho:
   - **Apple Silicon (M1/M2/M3/M4)** → `Manhwa-Recap-arm64.zip`
   - **Intel Mac** → `Manhwa-Recap-x64.zip`
3. Zip extract karo
4. **`Manhwa Recap.app`** ko **Applications** folder me drag karo
5. First launch: right-click → **Open** → "Open Anyway" click karo

> 🛡️ **Gatekeeper warning aayegi** kyunki app unsigned hai (Apple Developer cert nahi liya). Ek baar "Open Anyway" karke trust kar do — agle baar normally khulegi.

### Method B — Build from source (Mac machine zaroori)

```bash
# 1. Clone repo (Terminal me)
git clone https://github.com/megashoeb/manhwa-pipeline.git
cd manhwa-pipeline

# 2. Install Node.js if missing — https://nodejs.org/ se download
node --version  # should be 18+

# 3. Install dependencies
npm install

# 4. Build Mac app (x64 + ARM64 dono builds banenge)
npm run electron:build:mac
```

Output:
- **Intel Mac**: `release/Manhwa Recap-darwin-x64/Manhwa Recap.app`
- **Apple Silicon**: `release/Manhwa Recap-darwin-arm64/Manhwa Recap.app`

Apne chip ke hisaab se `.app` ko **Applications** folder me drag karo.

> **Note**: Mac build Windows machine pe bhi ban sakta hai (`npm run electron:build:mac` Windows pe bhi chalega), but unsigned hoga — Mac user ko right-click → Open karna padega.

---

## First-time Setup (after install)

App kholne ke baad:

1. **API Key Manager** panel kholo (top-right me settings icon)
2. **Gemini API key add karo**:
   - Free key yahan se: https://aistudio.google.com/apikey
   - Multiple keys add kar sakte ho (rotation ke liye — free tier limits handle ho jayenge)
3. **Test PDF upload karo** (single chapter se shuru karo)
4. Mode select karo:
   - **Single mode** — ek chapter test ke liye
   - **Bulk mode (Long-form recap)** — 5-15 chapters ka final YouTube video script

Output: ZIP file with `images/`, `script.txt`, `script.srt`, `manifest.json` → CapCut me load karo.

---

## Chrome Extension (manhwa scraping)

Chapter PDFs aapke paas nahi hain? Extension se scrape karo:

1. Repo me `extension/` folder hai
2. Chrome → `chrome://extensions/` → **Developer mode** ON
3. **Load unpacked** → `extension/` folder select karo
4. Extension icon click karo → starting chapter URL + count daalo → **Start**

PDFs `Downloads/<folder>/chapter 1.pdf`, `chapter 2.pdf`, … ke naam se save honge. Details: [`extension/README.md`](./extension/README.md)

---

## Available Scripts (developers)

```bash
npm run dev                  # Web dev server at http://localhost:5173
npm run build                # Production Vite build (dist/)
npm run preview              # Preview production build locally
npm run typecheck            # TypeScript check (no emit)

npm run electron:dev         # Desktop app with live reload (Vite + Electron)
npm run electron:build:win   # Build Windows .exe folder
npm run electron:build:mac   # Build Mac .app (x64 + ARM64)
```

---

## Architecture

```
src/                  React + TypeScript source (browser + Electron renderer)
  ├─ components/       UI: PdfUploader, BulkMode, ApiKeyManager, ImageGrid, ...
  ├─ core/             Pipeline: panelSlicer, curator, narrator, polish, ...
  └─ types/            Shared TypeScript interfaces

electron/             Desktop app shell
  ├─ main.cjs          BrowserWindow + native menu + single-instance lock
  └─ preload.cjs       contextBridge (exposes isDesktop, platform, version)

extension/            Chrome extension for manhwa chapter scraping
  ├─ manifest.json     MV3
  ├─ popup.html/css/js Input form + progress UI
  ├─ background.js     Image scraper + PDF builder service worker
  └─ offscreen.*       Blob URL handling for chrome.downloads

dist/                 Vite production build (gitignored — built locally)
release/              Electron packaging output (gitignored — built locally)
```

Same React app code targets **3 platforms** — web (Vercel), Windows (.exe), Mac (.app). No fork.

---

## Troubleshooting

**"Cannot find module 'electron/main.cjs'" on launch**
→ `npm install` rerun karo, `npm run build` se Vite dist/ banao, fir electron:build chalao.

**Build fails on Windows: "Cannot create symbolic link"**
→ Already handled — hum `electron-packager` use karte hain (not electron-builder), jisko symlinks ki zaroorat nahi.

**Mac me "App is damaged" error**
→ Gatekeeper unsigned app block kar raha. Solution:
```bash
xattr -cr "/Applications/Manhwa Recap.app"
```
Fir normally launch ho jayegi.

**App khul gayi but PDF process nahi hua**
→ Gemini API key add karo (API Key Manager panel). Free key https://aistudio.google.com/apikey se mil jayegi.

**Vercel slow lag rahi**
→ Desktop app use karo — local processing me 5-10× faster hota hai (no network roundtrips for PDF/image data).

---

## Contributing

Issues / PRs welcome: https://github.com/megashoeb/manhwa-pipeline

---

## License

ISC (informal personal-use license — see git history).

Made with the help of Claude.
