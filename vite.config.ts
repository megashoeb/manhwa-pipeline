import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the manhwa pipeline web app.
// All processing happens client-side; the dev server only serves the bundle.
//
// ``base: "./"`` matters for the Electron build: packaged builds load
// the HTML via the ``file://`` protocol, where absolute paths (the
// default ``/`` base) break asset URLs. Relative URLs work everywhere
// — same Vercel build, no regression — so we just always use them.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // listen on 0.0.0.0 so we can test from another device on LAN
  },
  optimizeDeps: {
    // Pre-bundle pdfjs-dist so the first PDF load is snappy.
    include: ["pdfjs-dist"],
  },
});
