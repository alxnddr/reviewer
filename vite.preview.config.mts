import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const ROOT = "/Users/sp/alxnddr-code/reviewer";

export default defineConfig({
  root: `${ROOT}/src/renderer`,
  server: { port: 13580, strictPort: true },
  resolve: {
    alias: { "@": `${ROOT}/src/renderer/src` },
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" },
  plugins: [react(), tailwindcss()],
});
