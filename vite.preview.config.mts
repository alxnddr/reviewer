import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// No npm script wraps this config — it is run ad hoc (`vite --config
// vite.preview.config.mts`) to preview the renderer in a plain browser, beside
// electron-vite's own renderer on 13579 — so `process.cwd()` is whatever
// directory the caller happened to be in. Anchor on this file instead: Vite
// imports `.mts` configs natively, and on its esbuild-bundling fallback path it
// rewrites `import.meta.url` back to this file's URL, so both paths agree.
const ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(ROOT, "src/renderer"),
  server: { port: 13580, strictPort: true },
  resolve: {
    alias: { "@": resolve(ROOT, "src/renderer/src") },
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" },
  plugins: [react(), tailwindcss()],
});
