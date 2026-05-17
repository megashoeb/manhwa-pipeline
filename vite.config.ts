import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the manhwa pipeline web app.
// All processing happens client-side; the dev server only serves the bundle.
export default defineConfig({
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
