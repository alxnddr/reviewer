import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Dependencies stay external; pure-ESM ones (electron-store) reach the
        // CJS bundle through Node's require(esm), which returns a namespace
        // object carrying an `__esModule` marker. Rollup's default interop
        // ignores that marker and hands the namespace itself to `new`; "auto"
        // checks it and unwraps `.default`, so the class survives.
        output: { interop: "auto" },
      },
    },
  },
  preload: {},
  renderer: {
    // electron-vite builds ELECTRON_RENDERER_URL from the *configured* renderer
    // port (lib: `conf.port`), while Vite silently increments the *actual* bind
    // when a port is contended — so on a machine running other dev servers the
    // main process loads a URL the renderer never bound (ERR_CONNECTION_REFUSED).
    // Pin a fixed port well outside the usual 3000/4200/5173/8080 ranges and make
    // it strict: Vite binds exactly this or fails loudly, so the two never drift.
    server: {
      port: 13579,
      strictPort: true,
    },
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      // A hoisted second React copy (via Base UI deps) breaks hooks at runtime.
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: ["react", "react-dom", "@base-ui/react"],
    },
    worker: {
      // The @pierre/diffs highlight worker code-splits (lazy wasm engine); the
      // default iife worker format cannot, and Chromium ≥ 80 runs module workers.
      format: "es",
    },
    plugins: [react(), tailwindcss()],
  },
});
