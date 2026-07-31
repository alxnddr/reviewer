import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      // A crash reports `out/main/index.js:1234` — a bundled line that names no
      // file anyone can open, and src/main/crash.ts persists exactly that text
      // for a reader to send back. The map is what turns it into a source
      // position. Cheap here: main is not minified, so its map is ~270 KB in the
      // asar.
      //
      // Who applies it, and where, is not symmetric — Node's source-map support
      // is off unless the *process* started with `--enable-source-maps`, and
      // nothing inside the bundle can turn it on after the fact (the map is
      // cached at compile time, so `process.setSourceMapsEnabled(true)` on the
      // first line of index.ts is already too late for index.js itself):
      //
      //   - unpackaged (`bun run dev`, `bun run start`): the package.json
      //     scripts set NODE_OPTIONS=--enable-source-maps, so `error.stack` —
      //     and therefore the crash log and its dialog — reads in src/ terms.
      //   - packaged: Electron accepts only `--http-parser` and
      //     `--max-http-header-size` from NODE_OPTIONS once the app is packaged
      //     (node_bindings.cc), so there is no way to switch it on for a
      //     shipped .app. The stack in a user's main-crash.log is bundled
      //     positions, resolved by hand afterwards.
      //
      // That second case is why the maps ship inside the asar rather than being
      // emitted `hidden` and dropped: they carry `sourcesContent`, so the .app
      // the reader already has is a complete, version-exact symbolication kit.
      // Nothing else in this repo archives per-build maps.
      sourcemap: true,
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
  preload: {
    // 23 KB of map on an 8 KB bundle, and the only one of the three that costs
    // nothing to consume: the preload is sandboxed (window.ts `sandbox: true`),
    // so it runs in the renderer and its errors land in DevTools, which follows
    // `//# sourceMappingURL` on its own — no process flag involved.
    build: {
      sourcemap: true,
    },
  },
  renderer: {
    // No `build.sourcemap` here: the renderer's assets are ~14 MB before maps,
    // every byte under out/ goes into the asar (electron-builder.yml `files:`),
    // and a symbolicated renderer stack is not worth that — DevTools is open on
    // any run where a renderer stack is being read, and in dev it maps against
    // the Vite server's originals anyway.
    //
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
